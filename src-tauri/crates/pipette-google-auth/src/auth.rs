// SPDX-License-Identifier: GPL-2.0-or-later
//! The sign-in and the tokens of the sync (src/main/sync/google-auth.ts).
//!
//! A sign-in takes an attempt generation when it starts. A sign-out, or a
//! sign-in started after it, advances the generation, and the earlier
//! attempt then drops what it has (the wait for the browser, the code
//! exchange, the tokens) and fails. Electron advances its session only when
//! it stores the tokens, so a sign-out during the exchange can be followed
//! by the sign-in it meant to cancel; here it cannot.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use pipette_net::HttpRequester;
use pipette_secret_store::SecretStore;
use tokio::sync::watch;
use zeroize::Zeroizing;

use crate::jwt::{self, ID_TOKEN_MAX_AGE_SECS};
use crate::loopback::{Callback, Loopback, READ_TIMEOUT};
use crate::pkce::new_auth_request;
use crate::token_endpoint::{TokenResponse, exchange_form, post_form, refresh_form};
use crate::tokens::{StoredTokens, TokenFile};
use crate::{AuthError, BrowserOpener, StoreTokens, TokenSwitch};

/// How early before its expiry an access token is refreshed.
const REFRESH_MARGIN_MS: i64 = 5 * 60 * 1000;

/// The time limits of the sign-in.
#[derive(Debug, Clone, Copy)]
pub struct AuthTiming {
    /// A token request (the exchange of a sign-in, or a refresh)
    /// (`tokenExchangeTiming`).
    pub token_request: Duration,
    /// From the start of a sign-in until the browser comes back; stopped
    /// once it does.
    pub authorization: Duration,
    /// Each loopback connection's request head and answer.
    pub connection: Duration,
}

impl Default for AuthTiming {
    fn default() -> Self {
        Self {
            token_request: Duration::from_secs(60),
            authorization: Duration::from_secs(5 * 60),
            connection: READ_TIMEOUT,
        }
    }
}

/// Where the sign-in goes and what it runs on.
pub struct AuthConfig {
    /// The authorization endpoint (`pipette_net::GoogleEndpoints::auth`).
    pub auth_endpoint: String,
    /// The token endpoint (`pipette_net::GoogleEndpoints::token`).
    pub token_endpoint: String,
    pub http: Arc<dyn HttpRequester>,
    pub timing: AuthTiming,
    /// `Date.now()`.
    pub now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// The Hub test account (`getHubTestAccount` of src/main/hub/hub-base.ts),
    /// read on every call; see [`crate::hub_test_account`].
    pub hub_test_account: Arc<dyn Fn() -> Option<String> + Send + Sync>,
}

type Listener = Box<dyn Fn() + Send + Sync>;

pub struct GoogleAuth {
    config: AuthConfig,
    tokens: TokenFile,
    attempts: watch::Sender<u64>,
    account_listeners: Mutex<Vec<Listener>>,
}

impl GoogleAuth {
    pub fn new(config: AuthConfig, secrets: Arc<SecretStore>) -> Self {
        Self {
            config,
            tokens: TokenFile::new(secrets),
            attempts: watch::Sender::new(0),
            account_listeners: Mutex::new(Vec::new()),
        }
    }

    /// Calls `listener` whenever the stored sign-in changes: after a
    /// sign-in stores its tokens and after a sign-out. For what the app
    /// keeps per account (the Hub token).
    pub fn on_account_changed(&self, listener: impl Fn() + Send + Sync + 'static) {
        self.listeners().push(Box::new(listener));
    }

    fn listeners(&self) -> std::sync::MutexGuard<'_, Vec<Listener>> {
        self.account_listeners.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn account_changed(&self) {
        for listener in self.listeners().iter() {
            listener();
        }
    }

    fn now(&self) -> i64 {
        (self.config.now_ms)()
    }

    fn begin_attempt(&self) -> u64 {
        let mut attempt = 0;
        self.attempts.send_modify(|current| {
            *current += 1;
            attempt = *current;
        });
        attempt
    }

    pub(crate) fn is_current_attempt(&self, attempt: u64) -> bool {
        *self.attempts.borrow() == attempt
    }

    /// Resolves once `attempt` is no longer the current one.
    async fn superseded(&self, attempt: u64) {
        let mut changes = self.attempts.subscribe();
        // The sender lives as long as `self`, so `wait_for` ends only by
        // its predicate.
        let _ = changes.wait_for(|current| *current != attempt).await;
    }

    /// Signs in through the browser (`startOAuthFlow`): opens the
    /// authorization URL with `browser`, waits for the loopback redirect,
    /// exchanges the code and stores the tokens through `switch`.
    pub async fn sign_in(
        &self,
        browser: &dyn BrowserOpener,
        switch: &dyn TokenSwitch,
    ) -> Result<(), AuthError> {
        let attempt = self.begin_attempt();
        let loopback = Loopback::bind().await.map_err(|err| AuthError::Other(err.to_string()))?;
        let port = loopback.port();
        let request = new_auth_request(&self.config.auth_endpoint, port)
            .map_err(|err| AuthError::Other(format!("no random bytes for the sign-in: {err}")))?;
        browser.open(&request.url).map_err(AuthError::Browser)?;
        let wait = tokio::time::timeout(
            self.config.timing.authorization,
            loopback.wait_with(&request.state, self.config.timing.connection),
        );
        // Dropping the wait closes the listener.
        let callback = tokio::select! {
            callback = wait => callback.map_err(|_| AuthError::TimedOut)?,
            () = self.superseded(attempt) => return Err(AuthError::SignInChanged),
        };
        let code = match callback {
            Callback::Code(code) => code,
            Callback::Error(error) => return Err(AuthError::OAuth(error)),
        };
        self.exchange(&code, &request.code_verifier, port, attempt, switch).await
    }

    /// Exchanges `code` for tokens and stores them through `switch`
    /// (`exchangeCodeForTokens`), as an attempt of its own.
    pub async fn exchange_code_for_tokens(
        &self,
        code: &str,
        code_verifier: &str,
        port: u16,
        switch: &dyn TokenSwitch,
    ) -> Result<(), AuthError> {
        let attempt = self.begin_attempt();
        self.exchange(code, code_verifier, port, attempt, switch).await
    }

    async fn exchange(
        &self,
        code: &str,
        code_verifier: &str,
        port: u16,
        attempt: u64,
        switch: &dyn TokenSwitch,
    ) -> Result<(), AuthError> {
        let request = self.token_request(exchange_form(code, code_verifier, port), "Token exchange");
        let response = tokio::select! {
            response = request => response?,
            () = self.superseded(attempt) => return Err(AuthError::SignInChanged),
        };
        let tokens = StoredTokens {
            access_token: response.access_token.clone(),
            refresh_token: response.refresh_token.clone().unwrap_or_default(),
            expires_at: response.expires_at(self.now()),
            id_token: response.id_token.clone(),
        };
        let sub = jwt::account_sub(tokens.id_token.as_deref());
        switch.switch(StoreTokens { auth: self, tokens, attempt }, sub).await
    }

    /// The store step a [`StoreTokens`] runs: a new session, then the
    /// write while `attempt` is still the current one.
    pub(crate) async fn store_sign_in(&self, tokens: StoredTokens, attempt: u64) -> Result<(), AuthError> {
        let generation = self.tokens.next_session();
        self.tokens.store(tokens, generation, || self.is_current_attempt(attempt)).await?;
        self.account_changed();
        Ok(())
    }

    async fn token_request(
        &self,
        form: Zeroizing<String>,
        label: &'static str,
    ) -> Result<TokenResponse, AuthError> {
        post_form(
            self.config.http.as_ref(),
            &self.config.token_endpoint,
            form,
            label,
            self.config.timing.token_request,
        )
        .await
    }

    /// Signs out (`signOut`): cancels a sign-in under way, forgets the
    /// tokens and removes their file. The tokens are not revoked, as in
    /// Electron.
    pub async fn sign_out(&self) {
        self.attempts.send_modify(|current| *current += 1);
        self.tokens.clear().await;
        self.account_changed();
    }

    /// Whether the sync is signed in (`getAuthStatus`): tokens are stored,
    /// or the Hub test account is set.
    pub async fn is_authenticated(&self) -> bool {
        (self.config.hub_test_account)().is_some() || self.tokens.load().await.is_some()
    }

    /// The access token, refreshed first when it expires within 5 minutes
    /// (`getAccessToken`); `None` when signed out or when the refresh fails.
    pub async fn access_token(&self) -> Option<Zeroizing<String>> {
        let tokens = self.tokens.load().await?;
        if self.now() >= tokens.expires_at.saturating_sub(REFRESH_MARGIN_MS) {
            return self.refresh(&tokens.refresh_token).await.ok();
        }
        Some(Zeroizing::new(tokens.access_token.clone()))
    }

    /// Refreshes the access token with `refresh_token` and stores the new
    /// tokens, keeping the stored id_token when the response has none
    /// (`refreshAccessToken`). Fails without storing anything when a
    /// sign-in or sign-out happened meanwhile.
    async fn refresh(&self, refresh_token: &str) -> Result<Zeroizing<String>, AuthError> {
        let generation = self.tokens.session();
        let response = self.token_request(refresh_form(refresh_token), "Token refresh").await?;
        let existing = self.tokens.load().await;
        let id_token =
            response.id_token.clone().or_else(|| existing.and_then(|tokens| tokens.id_token.clone()));
        let tokens = StoredTokens {
            access_token: response.access_token.clone(),
            refresh_token: refresh_token.to_owned(),
            expires_at: response.expires_at(self.now()),
            id_token,
        };
        self.tokens.store(tokens, generation, || true).await?;
        Ok(Zeroizing::new(response.access_token.clone()))
    }

    /// The id_token for the Hub (`getIdToken`): `test:<account>` for the Hub
    /// test account; else the stored one, refreshed when it is missing,
    /// expired or older than 5 minutes; `None` when there is none fresh.
    pub async fn id_token(&self) -> Option<Zeroizing<String>> {
        if let Some(account) = (self.config.hub_test_account)() {
            return Some(Zeroizing::new(format!("test:{account}")));
        }
        let tokens = self.tokens.load().await?;
        if let Some(id_token) = tokens.id_token.as_deref().filter(|token| self.is_fresh(token)) {
            return Some(Zeroizing::new(id_token.to_owned()));
        }
        if tokens.refresh_token.is_empty() {
            return None;
        }
        self.refresh(&tokens.refresh_token).await.ok()?;
        let refreshed = self.tokens.load().await?;
        refreshed
            .id_token
            .as_deref()
            .filter(|token| self.is_fresh(token))
            .map(|token| Zeroizing::new(token.to_owned()))
    }

    fn is_fresh(&self, id_token: &str) -> bool {
        let now = self.now();
        !id_token.is_empty()
            && !jwt::is_expired(id_token, now)
            && !jwt::is_stale(id_token, ID_TOKEN_MAX_AGE_SECS, now)
    }

    /// The `sub` of the signed-in account's id_token (`getAccountSub`);
    /// `None` when signed out or without one. The Hub test account is not
    /// a Drive sign-in and has none.
    pub async fn account_sub(&self) -> Option<String> {
        jwt::account_sub(self.tokens.load().await?.id_token.as_deref())
    }
}
