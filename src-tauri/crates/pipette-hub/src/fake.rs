// SPDX-License-Identifier: GPL-2.0-or-later
//! An in-memory Hub for the tests: the same Hub as the Node fake of
//! scripts/fake-hub/ (its routes, checks, texts, response shapes, ids,
//! clock and injected faults), answering in the process instead of over
//! HTTP. Both pass the conformance cases of
//! scripts/fake-hub/conformance-cases.json.
//!
//! The control methods stand for the Node fake's control endpoints:
//! [`FakeHub::set_user`] (`users`), [`FakeHub::inject`] (`faults`),
//! [`FakeHub::seed_post`] (`posts`), [`FakeHub::seed_pack`]
//! (`i18n-packs` / `theme-packs`), [`FakeHub::seed_key_label`]
//! (`key-labels`), [`FakeHub::touch`], [`FakeHub::revoke_tokens`],
//! [`FakeHub::reset`], [`FakeHub::requests`] and
//! [`FakeHub::clear_requests`].
//!
//! The id_token is `test:<email>` (an example.com or `.test` address, as
//! the Hub's test mode takes) or a JWT whose payload has an email; the
//! signature is not checked. The Hub's limits on token requests, daily
//! uploads and request rates are not kept: a 429 comes only from a fault.

use std::sync::{Mutex, MutexGuard, PoisonError};

use pipette_js_json::{Object, Value};
use pipette_net::{HttpError, HttpReply, HttpRequest, HttpRequester, Method, RequestFuture};

mod http;
mod packs;
mod routes;
mod state;
mod validate;

pub use state::{CLOCK_START_MS, Fault, PackKind, SYSTEM_USER_ID, fault_body};

use http::{Answer, Request, fail};
use state::{KeyLabel, Pack, PostContent, State};

/// The base URL to point the code under test at; the fake reads the path
/// from `/api/` on, whatever the origin.
pub const FAKE_HUB_BASE: &str = "http://127.0.0.1:9";

/// The boundary the app's multipart bodies have at the fake's clock start.
pub const FAKE_HUB_BOUNDARY: &str = "----PipetteBoundary1767225600000";

pub(crate) fn object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    let mut object = Object::new();
    for (key, value) in fields {
        object.insert(key, value);
    }
    Value::Object(object)
}

/// A request the fake received.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoggedRequest {
    pub method: Method,
    /// The path, without the query.
    pub path: String,
    /// The query's pairs, decoded.
    pub query: Vec<(String, String)>,
    /// The route (`auth.token`, `keyLabels.list`, …); `None` for a path the
    /// Hub does not serve.
    pub op: Option<&'static str>,
    /// The email of the account of the bearer JWT.
    pub account: Option<String>,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

impl LoggedRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }
}

/// The record kinds [`FakeHub::touch`] moves on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordKind {
    Post,
    PrivatePost,
    I18n,
    Theme,
    KeyLabel,
}

#[derive(Default)]
struct Inner {
    state: State,
    log: Vec<LoggedRequest>,
}

/// The in-memory Hub: the `HttpRequester` of the requests under test,
/// shared as `Arc<FakeHub>` (an `Arc<dyn HttpRequester>` too).
#[derive(Default)]
pub struct FakeHub {
    inner: Mutex<Inner>,
}

impl FakeHub {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Empty state, clock, counters and faults (the log too).
    pub fn reset(&self) {
        *self.lock() = Inner::default();
    }

    /// Creates the account of `email` or changes it: its display name, and
    /// whether it is active when `active` is given. Returns its id.
    pub fn set_user(&self, email: &str, display_name: Option<&str>, active: Option<bool>) -> String {
        let state = &mut self.lock().state;
        if state.user_by_email(email).is_none() {
            state.create_user(email, display_name.map(str::to_owned));
        }
        let user = state.user_by_email_mut(email).expect("created above");
        user.display_name = display_name.map(str::to_owned);
        if let Some(active) = active {
            user.active = active;
        }
        user.id.clone()
    }

    /// The next requests (of `fault.only`, when given) get this answer.
    pub fn inject(&self, fault: Fault) {
        self.lock().state.inject(fault);
    }

    /// Forgets every Hub JWT issued: the next authenticated request is 401.
    pub fn revoke_tokens(&self) {
        self.lock().state.jwts.clear();
    }

    /// The id of the account of `email` (`system` for the Hub's built-in
    /// owner), created with its local part as its display name when
    /// missing.
    fn owner(state: &mut State, email: &str) -> String {
        if email == "system" {
            return SYSTEM_USER_ID.to_owned();
        }
        match state.user_by_email(email) {
            Some(user) => user.id.clone(),
            None => state.create_user(email, Some(email.split('@').next().unwrap_or(email).to_owned())).id,
        }
    }

    /// A keyboard post of `owner` as another machine uploaded it; the
    /// post's answer.
    pub fn seed_post(
        &self,
        owner: &str,
        title: &str,
        keyboard_name: Option<&str>,
        updated_at: Option<&str>,
    ) -> Value {
        let state = &mut self.lock().state;
        let owner = Self::owner(state, owner);
        let content = PostContent {
            title: title.to_owned(),
            keyboard_name: keyboard_name.map(str::to_owned),
            post_type: "keyboard".to_owned(),
            files: Vec::new(),
            keyboard_uid: None,
            total_keystrokes: None,
            range_from_ms: None,
            range_to_ms: None,
        };
        let post = state.new_post(content, &owner, updated_at);
        let answer = state.public_post(&post);
        state.posts.push(post);
        answer
    }

    /// A pack of `owner`: for a language pack `body` is the
    /// `{version, kind, exportedAt, pack}` export, for a theme pack the
    /// pack. Its detail answer.
    pub fn seed_pack(&self, kind: PackKind, owner: &str, body: &Value, updated_at: Option<&str>) -> Value {
        let state = &mut self.lock().state;
        let owner = Self::owner(state, owner);
        let named = match kind {
            PackKind::I18n => body.as_object().and_then(|export| export.get("pack")),
            PackKind::Theme => Some(body),
        };
        // `String(named?.name ?? '')`.
        let field = |key: &str| match named.and_then(Value::as_object).and_then(|object| object.get(key)) {
            None | Some(Value::Null) => String::new(),
            value => pipette_js_json::js_string(value),
        };
        let created = state.stamp(None);
        let pack = Pack {
            id: state.new_id(),
            name: field("name"),
            version: field("version"),
            pack_json: pipette_js_json::stringify(body),
            uploaded_by: owner,
            updated_at: updated_at.map_or_else(|| created.clone(), str::to_owned),
            created_at: created,
        };
        let answer = state.pack_detail(kind, &pack);
        state.packs_mut(kind).push(pack);
        answer
    }

    /// A key label of `owner` (`system` for a built-in one); its answer.
    pub fn seed_key_label(
        &self,
        owner: &str,
        name: &str,
        map: Value,
        composite_labels: Option<Value>,
        keymap_applicable: bool,
        updated_at: Option<&str>,
    ) -> Value {
        let state = &mut self.lock().state;
        let owner = Self::owner(state, owner);
        let created = state.stamp(None);
        let label = KeyLabel {
            id: state.new_id(),
            name: name.to_owned(),
            map,
            composite_labels,
            keymap_applicable,
            uploaded_by: owner,
            updated_at: updated_at.map_or_else(|| created.clone(), str::to_owned),
            created_at: created,
        };
        let answer = state.public_key_label(&label);
        state.key_labels.push(label);
        answer
    }

    /// Moves the `updated_at` of a record on (to `updated_at` when given);
    /// the new value, `None` for an unknown record.
    pub fn touch(&self, kind: RecordKind, id: &str, updated_at: Option<&str>) -> Option<String> {
        let state = &mut self.lock().state;
        let exists = match kind {
            RecordKind::Post => state.posts.iter().any(|post| post.id == id),
            RecordKind::PrivatePost => state.private_posts.iter().any(|post| post.id == id),
            RecordKind::I18n => state.i18n.iter().any(|pack| pack.id == id),
            RecordKind::Theme => state.themes.iter().any(|pack| pack.id == id),
            RecordKind::KeyLabel => state.key_labels.iter().any(|label| label.id == id),
        };
        if !exists {
            return None;
        }
        let stamp = state.stamp(updated_at);
        let slot = match kind {
            RecordKind::Post => {
                state.posts.iter_mut().find(|post| post.id == id).map(|post| &mut post.updated_at)
            }
            RecordKind::PrivatePost => {
                state.private_posts.iter_mut().find(|post| post.id == id).map(|post| &mut post.updated_at)
            }
            RecordKind::I18n => {
                state.i18n.iter_mut().find(|pack| pack.id == id).map(|pack| &mut pack.updated_at)
            }
            RecordKind::Theme => {
                state.themes.iter_mut().find(|pack| pack.id == id).map(|pack| &mut pack.updated_at)
            }
            RecordKind::KeyLabel => {
                state.key_labels.iter_mut().find(|label| label.id == id).map(|label| &mut label.updated_at)
            }
        };
        *slot? = stamp.clone();
        Some(stamp)
    }

    /// Every request so far, the first first.
    pub fn requests(&self) -> Vec<LoggedRequest> {
        self.lock().log.clone()
    }

    pub fn clear_requests(&self) {
        self.lock().log.clear();
    }

    fn answer(&self, request: &HttpRequest) -> HttpReply {
        let target = request.url.find("/api/").map_or("/", |at| &request.url[at..]);
        let target = target.split('#').next().unwrap_or("");
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        let query: Vec<(String, String)> = form_urlencoded::parse(query.as_bytes())
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        let header = |name: &str| {
            request
                .headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        };
        let body = request.body.as_deref().unwrap_or(&[]);
        let hub_request = Request {
            query: query.clone(),
            authorization: header("authorization"),
            content_type: header("content-type").unwrap_or(""),
            body,
        };
        let matched = match_route(request.method, path);
        let mut inner = self.lock();
        let bearer = hub_request.authorization.and_then(|value| value.strip_prefix("Bearer "));
        let account = bearer
            .and_then(|token| inner.state.jwts.iter().find(|(jwt, _)| jwt == token))
            .and_then(|(_, id)| inner.state.user_by_id(id))
            .map(|user| user.email.clone());
        inner.log.push(LoggedRequest {
            method: request.method,
            path: path.to_owned(),
            query,
            op: matched.as_ref().map(|(op, _)| *op),
            account,
            headers: request.headers.clone(),
            body: request.body.clone(),
        });
        let answer = match matched {
            None => fail(404, "Not found"),
            Some((op, params)) => match inner.state.take_fault(op) {
                Some((status, body, retry_after)) => {
                    Answer { status, body, retry_after, content_type: "application/json" }
                }
                None => dispatch(&mut inner.state, &hub_request, op, params.first().map(String::as_str)),
            },
        };
        HttpReply {
            status: answer.status,
            retry_after: answer.retry_after,
            content_type: Some(answer.content_type.to_owned()),
            body: answer.body.into_bytes(),
        }
    }
}

impl HttpRequester for FakeHub {
    fn request(&self, request: HttpRequest) -> RequestFuture<'_> {
        Box::pin(std::future::ready(Ok::<_, HttpError>(self.answer(&request))))
    }
}

/// `decodeURIComponent` of a path segment (an invalid escape is kept).
fn decode_segment(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = |offset: usize| bytes.get(at + offset).and_then(|b| char::from(*b).to_digit(16));
        match (bytes[at], hex(1), hex(2)) {
            (b'%', Some(high), Some(low)) => {
                out.push(u8::try_from(high * 16 + low).unwrap_or(0));
                at += 3;
            }
            (byte, _, _) => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The route of a request and its path parameters, as the Node fake's
/// route table matches them.
fn match_route(method: Method, path: &str) -> Option<(&'static str, Vec<String>)> {
    let rest = path.strip_prefix("/api/")?;
    let segments: Vec<&str> = rest.split('/').collect();
    let id = |segment: &str| (!segment.is_empty()).then(|| vec![decode_segment(segment)]);
    let none = || Some(Vec::new());
    use Method::{Delete, Get, Patch, Post, Put};
    let found = match (method, segments.as_slice()) {
        (Post, ["auth", "token"]) => ("auth.token", none()),
        (Get, ["auth", "me"]) => ("auth.me", none()),
        (Patch, ["auth", "me"]) => ("auth.patchMe", none()),
        (Get, ["files", "me"]) => ("files.me", none()),
        (Get, ["files", "me", "keyboard"]) => ("files.meKeyboard", none()),
        (Get, ["files", one]) => ("files.get", id(one)),
        (Post, ["files"] | ["files", ""]) => ("files.create", none()),
        (Put, ["files", one]) => ("files.update", id(one)),
        (Patch, ["files", one]) => ("files.patch", id(one)),
        (Delete, ["files", one]) => ("files.delete", id(one)),
        (Post, ["private", "files"] | ["private", "files", ""]) => ("private.create", none()),
        (Delete, ["private", "files", one]) => ("private.delete", id(one)),
        (_, [base, tail @ ..]) => {
            let prefix = match *base {
                "i18n-packs" => "i18n",
                "theme-packs" => "theme",
                "key-labels" => "keyLabels",
                _ => return None,
            };
            let (action, params) = match (method, tail) {
                (Get, [] | [""]) => ("list", none()),
                (Post, ["timestamps"]) => ("timestamps", none()),
                (Get, [one]) => ("get", id(one)),
                (Get, [one, "download"]) => ("download", id(one)),
                (Post, [] | [""]) => ("create", none()),
                (Put, [one]) => ("update", id(one)),
                (Delete, [one]) => ("delete", id(one)),
                _ => return None,
            };
            (op_name(prefix, action), params)
        }
        _ => return None,
    };
    Some((found.0, found.1?))
}

fn op_name(prefix: &str, action: &str) -> &'static str {
    const OPS: [&str; 21] = [
        "i18n.list",
        "i18n.timestamps",
        "i18n.get",
        "i18n.download",
        "i18n.create",
        "i18n.update",
        "i18n.delete",
        "theme.list",
        "theme.timestamps",
        "theme.get",
        "theme.download",
        "theme.create",
        "theme.update",
        "theme.delete",
        "keyLabels.list",
        "keyLabels.timestamps",
        "keyLabels.get",
        "keyLabels.download",
        "keyLabels.create",
        "keyLabels.update",
        "keyLabels.delete",
    ];
    let name = format!("{prefix}.{action}");
    OPS.iter().find(|op| **op == name).copied().unwrap_or("unknown")
}

fn dispatch(state: &mut State, request: &Request<'_>, op: &str, id: Option<&str>) -> Answer {
    let id_or_empty = id.unwrap_or("");
    match op {
        "auth.token" => routes::token(state, request),
        "auth.me" => routes::get_me(state, request),
        "auth.patchMe" => routes::patch_me(state, request),
        "files.me" => routes::my_posts(state, request),
        "files.meKeyboard" => routes::my_keyboard_posts(state, request),
        "files.get" => routes::get_post(state, id_or_empty),
        "files.create" => routes::create_post(state, request),
        "files.update" => routes::update_post(state, request, id_or_empty),
        "files.patch" => routes::patch_post(state, request, id_or_empty),
        "files.delete" => routes::delete_post(state, request, id_or_empty),
        "private.create" => routes::create_private(state, request),
        "private.delete" => routes::delete_private(state, request, id_or_empty),
        _ => match op.split_once('.') {
            Some(("i18n", action)) => packs::pack_route(state, request, PackKind::I18n, action, id),
            Some(("theme", action)) => packs::pack_route(state, request, PackKind::Theme, action, id),
            Some(("keyLabels", action)) => packs::key_label_route(state, request, action, id),
            _ => fail(404, "Not found"),
        },
    }
}

#[cfg(test)]
mod tests;
