// SPDX-License-Identifier: GPL-2.0-or-later
//! The Hub JWT: its cache in memory only, the one request concurrent
//! callers share, the retry after a 401 and the sentinels its failures
//! become.
//!
//! The JWT is kept for its own 24 hours (`HUB_JWT_TTL_MS`), never by the
//! JWT's `exp`; a 401 within that time takes a new one. It is never written
//! to disk or to the key store, and neither it nor the Google id_token is
//! logged or handed to the page.
//!
//! The cache:
//! - a token request is cached only when the generation has not changed
//!   while it ran; [`HubToken::clear`] (a sign-in or sign-out) bumps the
//!   generation, so a request it overtook returns its token to its callers
//!   without keeping it;
//! - [`HubToken::set_pending_display_name`] drops the cached token and the
//!   shared request but keeps the generation, so a request already running
//!   still caches its token when it ends;
//! - the end of a token request forgets the shared request whichever one is
//!   shared by then, so a request started after a display name was set is
//!   no longer shared once the earlier one ends.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use pipette_js_json::{Object, Value, js_string, stringify};
use tokio::sync::watch;
use zeroize::Zeroizing;

use crate::endpoint::Endpoint;
use crate::http::{HubError, HubHttp, RequestBody, StatusKind};
use crate::sources::IdTokenSource;
use crate::validate::InvalidInput;

/// `HUB_JWT_TTL_MS`: how long a Hub JWT is used before a new one is taken.
pub const HUB_JWT_TTL_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// `HUB_ERROR_DISPLAY_NAME_CONFLICT` of src/shared/types/hub.ts.
pub const HUB_ERROR_DISPLAY_NAME_CONFLICT: &str = "DISPLAY_NAME_CONFLICT";
/// `HUB_ERROR_ACCOUNT_DEACTIVATED`.
pub const HUB_ERROR_ACCOUNT_DEACTIVATED: &str = "ACCOUNT_DEACTIVATED";
/// `HUB_ERROR_RATE_LIMITED`.
pub const HUB_ERROR_RATE_LIMITED: &str = "RATE_LIMITED";
/// `HUB_ERROR_NOT_AUTHENTICATED`.
pub const HUB_ERROR_NOT_AUTHENTICATED: &str = "Not authenticated with Google. Please sign in again.";

/// What a Hub handler failed with: the error's message, and
/// the class of the Hub error it is (`instanceof Hub409Error` …), `None` for
/// a plain `Error` (the sentinels, the input checks, the failures without
/// a status).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct HubFailure {
    pub message: String,
    pub kind: Option<StatusKind>,
}

impl HubFailure {
    /// A plain `Error` with `message`.
    pub fn plain(message: impl Into<String>) -> Self {
        Self { message: message.into(), kind: None }
    }

    /// Whether this is the Hub error of `kind`.
    pub fn is(&self, kind: StatusKind) -> bool {
        self.kind == Some(kind)
    }
}

impl From<HubError> for HubFailure {
    fn from(err: HubError) -> Self {
        Self { kind: err.status_kind(), message: err.to_string() }
    }
}

impl From<InvalidInput> for HubFailure {
    fn from(err: InvalidInput) -> Self {
        Self::plain(err.0)
    }
}

/// `err` as the Hub's sentinel: a 403 is the deactivated account and a 429
/// the rate limit; any other failure stays as it is.
pub fn as_hub_sentinel(err: HubError) -> HubFailure {
    match err.status_kind() {
        Some(StatusKind::Forbidden) => HubFailure::plain(HUB_ERROR_ACCOUNT_DEACTIVATED),
        Some(StatusKind::RateLimited) => HubFailure::plain(HUB_ERROR_RATE_LIMITED),
        _ => err.into(),
    }
}

/// A Hub JWT, shared by the callers that use it.
pub type Jwt = Arc<Zeroizing<String>>;

type Outcome = Result<Jwt, HubFailure>;

struct Cached {
    token: Jwt,
    expires_at: f64,
}

struct Inflight {
    id: u64,
    outcome: watch::Receiver<Option<Outcome>>,
}

#[derive(Default)]
struct TokenState {
    cached: Option<Cached>,
    inflight: Option<Inflight>,
    generation: u64,
    pending_display_name: Option<String>,
    next_inflight_id: u64,
}

/// What the Hub token cache holds, without the token: for the e2e tests'
/// view of the Hub.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenSnapshot {
    /// A JWT is cached (expired or not).
    pub cached: bool,
    /// A token request is shared with the callers that come.
    pub inflight: bool,
    /// The times the cache was cleared by a sign-in or sign-out.
    pub generation: u64,
    /// A display name is set for the next token request.
    pub display_name_pending: bool,
}

/// The Hub JWT of this process: [`get`](HubToken::get),
/// [`clear`](HubToken::clear),
/// [`set_pending_display_name`](HubToken::set_pending_display_name) and
/// [`with_token_retry`](HubToken::with_token_retry).
pub struct HubToken {
    http: HubHttp,
    id_tokens: Arc<dyn IdTokenSource>,
    state: Mutex<TokenState>,
}

enum Next {
    Ready(Outcome),
    Wait(watch::Receiver<Option<Outcome>>),
    Lead { generation: u64, id: u64, done: watch::Sender<Option<Outcome>> },
}

/// Forgets the shared request of a leader that is dropped before it ends
/// (its callers try again); a leader that ends forgets it itself.
struct LeadGuard<'a> {
    token: &'a HubToken,
    id: u64,
    ended: bool,
}

impl Drop for LeadGuard<'_> {
    fn drop(&mut self) {
        if self.ended {
            return;
        }
        let mut state = self.token.lock();
        if state.inflight.as_ref().is_some_and(|inflight| inflight.id == self.id) {
            state.inflight = None;
        }
    }
}

impl HubToken {
    pub fn new(http: HubHttp, id_tokens: Arc<dyn IdTokenSource>) -> Self {
        Self { http, id_tokens, state: Mutex::new(TokenState::default()) }
    }

    /// The client the token and the handlers' requests go through.
    pub fn http(&self) -> &HubHttp {
        &self.http
    }

    fn lock(&self) -> MutexGuard<'_, TokenState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The cached JWT while it is within its 24 hours, else the token request
    /// under way, else a new one.
    pub async fn get(&self) -> Outcome {
        loop {
            let next = {
                let mut state = self.lock();
                let now = self.http.timing().now_ms();
                if let Some(cached) = state.cached.as_ref().filter(|cached| now < cached.expires_at) {
                    Next::Ready(Ok(Arc::clone(&cached.token)))
                } else if let Some(inflight) = &state.inflight {
                    Next::Wait(inflight.outcome.clone())
                } else {
                    let (done, outcome) = watch::channel(None);
                    let id = state.next_inflight_id;
                    state.next_inflight_id += 1;
                    state.inflight = Some(Inflight { id, outcome });
                    Next::Lead { generation: state.generation, id, done }
                }
            };
            match next {
                Next::Ready(outcome) => return outcome,
                Next::Wait(mut outcome) => {
                    // A leader dropped before it ended sends nothing: try again.
                    let ended = outcome.wait_for(Option::is_some).await.ok().and_then(|ended| ended.clone());
                    if let Some(outcome) = ended {
                        return outcome;
                    }
                }
                Next::Lead { generation, id, done } => {
                    let mut guard = LeadGuard { token: self, id, ended: false };
                    let outcome = self.request().await;
                    {
                        let mut state = self.lock();
                        state.inflight = None;
                        if let (Ok(token), true) = (&outcome, state.generation == generation) {
                            let expires_at = self.http.timing().now_ms() + HUB_JWT_TTL_MS;
                            state.cached = Some(Cached { token: Arc::clone(token), expires_at });
                        }
                    }
                    guard.ended = true;
                    done.send_replace(Some(outcome.clone()));
                    return outcome;
                }
            }
        }
    }

    /// The token request: the Google id_token exchanged for a Hub JWT, with
    /// the display name set for it (read once the id_token is there).
    async fn request(&self) -> Outcome {
        let Some(id_token) = self.id_tokens.id_token().await else {
            return Err(HubFailure::plain(HUB_ERROR_NOT_AUTHENTICATED));
        };
        let display_name = self.lock().pending_display_name.clone();
        let body = auth_body(&id_token, display_name.as_deref());
        let data =
            self.http.send(&Endpoint::AuthToken, None, RequestBody::Json(body)).await.map_err(|err| {
                if err.status_kind() == Some(StatusKind::Conflict) {
                    HubFailure::plain(HUB_ERROR_DISPLAY_NAME_CONFLICT)
                } else {
                    as_hub_sentinel(err)
                }
            })?;
        Ok(Arc::new(token_of(data)?))
    }

    /// On a sign-in or sign-out (and the reset that
    /// signs out), forgets the JWT, the shared request and the display name,
    /// and bumps the generation so a request under way is not cached.
    pub fn clear(&self) {
        let mut state = self.lock();
        state.cached = None;
        state.inflight = None;
        state.generation += 1;
        state.pending_display_name = None;
    }

    /// Sets the display name of the next token request (`None` for any value
    /// that is not a string). Drops the JWT and the shared request so the
    /// next call takes a token with it; the generation stays.
    pub fn set_pending_display_name(&self, display_name: Option<String>) {
        let mut state = self.lock();
        state.pending_display_name = display_name;
        state.cached = None;
        state.inflight = None;
    }

    /// Runs `operation` with the JWT; on a 401, once more with a new JWT. A
    /// 403 or a 429 of either run becomes its sentinel. A second 401 is the
    /// error, and the new JWT stays cached.
    pub async fn with_token_retry<T, F, Fut>(&self, operation: F) -> Result<T, HubFailure>
    where
        F: Fn(Jwt) -> Fut,
        Fut: Future<Output = Result<T, HubError>>,
    {
        let jwt = self.get().await?;
        match operation(jwt).await {
            Ok(value) => Ok(value),
            Err(err) if err.status_kind() == Some(StatusKind::Unauthorized) => {
                self.lock().cached = None;
                let fresh = self.get().await?;
                operation(fresh).await.map_err(as_hub_sentinel)
            }
            Err(err) => Err(as_hub_sentinel(err)),
        }
    }

    /// What the cache holds, without the token.
    pub fn snapshot(&self) -> TokenSnapshot {
        let state = self.lock();
        TokenSnapshot {
            cached: state.cached.is_some(),
            inflight: state.inflight.is_some(),
            generation: state.generation,
            display_name_pending: state.pending_display_name.is_some(),
        }
    }
}

/// `JSON.stringify({ id_token, display_name? })`: the display name only
/// when it is not empty.
fn auth_body(id_token: &str, display_name: Option<&str>) -> String {
    let mut payload = Object::new();
    payload.insert("id_token", Value::from(id_token));
    if let Some(display_name) = display_name.filter(|name| !name.is_empty()) {
        payload.insert("display_name", Value::from(display_name));
    }
    stringify(&Value::Object(payload))
}

/// `auth.token` of the envelope's `data`, as the template literal of the
/// `Authorization` header writes it.
fn token_of(data: Option<Value>) -> Result<Zeroizing<String>, HubFailure> {
    match data {
        None => Err(HubFailure::plain("Cannot read properties of undefined (reading 'token')")),
        Some(Value::Null) => Err(HubFailure::plain("Cannot read properties of null (reading 'token')")),
        Some(Value::Object(object)) => Ok(Zeroizing::new(js_string(object.get("token")))),
        // A primitive or an array has no `token`.
        Some(_) => Ok(Zeroizing::new(js_string(None))),
    }
}

#[cfg(test)]
mod tests;
