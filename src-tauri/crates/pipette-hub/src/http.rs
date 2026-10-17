// SPDX-License-Identifier: GPL-2.0-or-later
//! The Hub's HTTP layer: one request function for the three ways the TS
//! reads a response (`hubFetch` of hub-client.ts and hub-key-labels.ts,
//! `hubFetchJson` of hub-i18n.ts and hub-theme.ts, and the downloads that
//! call `fetch` themselves; [`ReadMode`]), the error each failure becomes
//! and the one retry after a short 429.
//!
//! The messages are the TS's: `<label>: <status> <body>` for a failed
//! status and `<label>: <error>` for an envelope with `ok: false`, which
//! src/renderer/utils/hub-error-i18n.ts maps to its messages. The body of a
//! failed status is cut at 64 KiB (`ERROR_BODY_LIMIT` of pipette-net), where
//! Electron keeps all of it. A request that gets no response and a body
//! that is not JSON fail with messages of their own, which the renderer
//! shows as its generic failure, as it does for Electron's.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use pipette_js_json::{Value, js_string};
use pipette_net::{HttpError, HttpReply, HttpRequest, HttpRequester, Limits};

use crate::endpoint::{Endpoint, ReadMode};
use crate::multipart::MultipartBody;
use crate::retry_after::parse_retry_after;

/// `MAX_RETRY_AFTER_S` of the TS: a 429 asking for a longer wait (a daily
/// limit, say) is not retried.
pub const MAX_RETRY_AFTER_S: f64 = 60.0;

/// The bounds of the Hub requests other than the multipart uploads: 30
/// seconds to connect, 60 seconds without a byte, 10 minutes in all,
/// 64 MiB. Electron's `fetch` has no time limit of the app's own. The
/// multipart uploads take `Limits::DEFAULT` (30 minutes in all): a large
/// upload that is still sending is only stopped by that total.
pub const HUB_LIMITS: Limits = Limits {
    connect_timeout: Duration::from_secs(30),
    read_timeout: Duration::from_secs(60),
    total_timeout: Duration::from_secs(10 * 60),
    max_body_bytes: 64 * 1024 * 1024,
};

/// Which class of the TS's errors a failed status is: the token retry and
/// the handlers tell these apart (`instanceof Hub401Error` …).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusKind {
    /// `Hub401Error`.
    Unauthorized,
    /// `Hub403Error`.
    Forbidden,
    /// `Hub404Error` (hub-client.ts's endpoints only).
    NotFound,
    /// `Hub409Error` (not the downloads').
    Conflict,
    /// `Hub429Error`.
    RateLimited,
    /// A plain `Error`.
    Other,
}

/// Why a Hub request failed.
#[derive(Debug, thiserror::Error)]
pub enum HubError {
    /// A status other than 2xx: `<label>: <status> <body>`.
    #[error("{label}: {status} {body}")]
    Status {
        label: &'static str,
        status: u16,
        body: String,
        kind: StatusKind,
        /// The `Retry-After` of a 429, in seconds (`retryAfterSeconds`).
        retry_after: Option<f64>,
    },
    /// A 2xx envelope with `ok` false: `<label>: <error ?? 'unknown error'>`.
    #[error("{label}: {message}")]
    Envelope { label: &'static str, message: String },
    /// No response: `fetch` rejected.
    #[error(transparent)]
    Network(#[from] HttpError),
    /// A 2xx body that `response.json()` (or the envelope check) rejects.
    #[error("{0}")]
    Body(String),
}

impl HubError {
    /// The class of a failed status, `None` for the other failures.
    pub fn status_kind(&self) -> Option<StatusKind> {
        match self {
            HubError::Status { kind, .. } => Some(*kind),
            _ => None,
        }
    }
}

/// The clock and the wait of the retry, replaceable in the tests.
pub trait HubTiming: Send + Sync {
    /// `Date.now()`.
    fn now_ms(&self) -> f64;
    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

/// The system clock and Tokio's timer.
pub struct SystemTiming;

impl HubTiming for SystemTiming {
    fn now_ms(&self) -> f64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
    }

    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(tokio::time::sleep(duration))
    }
}

/// The clients the Hub requests go through: the multipart uploads through
/// `upload` (built with `Limits::DEFAULT`), every other request through
/// `other` (built with [`HUB_LIMITS`]).
#[derive(Clone)]
pub struct HubRequesters {
    pub upload: Arc<dyn HttpRequester>,
    pub other: Arc<dyn HttpRequester>,
}

impl HubRequesters {
    /// One requester for both, for the tests.
    pub fn single(requester: Arc<dyn HttpRequester>) -> Self {
        Self { upload: Arc::clone(&requester), other: requester }
    }
}

/// The body of a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestBody {
    None,
    /// `application/json`; the text is the TS's `JSON.stringify(…)`.
    Json(String),
    Multipart(MultipartBody),
}

/// Sends Hub requests to one base URL.
#[derive(Clone)]
pub struct HubHttp {
    base: String,
    requesters: HubRequesters,
    timing: Arc<dyn HubTiming>,
}

impl HubHttp {
    pub fn new(base: impl Into<String>, requesters: HubRequesters, timing: Arc<dyn HubTiming>) -> Self {
        Self { base: base.into(), requesters, timing }
    }

    /// The Hub API base URL the requests go to (`getHubOrigin`).
    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn timing(&self) -> &Arc<dyn HubTiming> {
        &self.timing
    }

    /// The request as the TS's `init` builds it: `Authorization` when there
    /// is a JWT, then the `Content-Type` of the body.
    fn request(&self, endpoint: &Endpoint<'_>, jwt: Option<&str>, body: RequestBody) -> HttpRequest {
        let mut headers = Vec::new();
        if let Some(jwt) = jwt {
            headers.push(("Authorization".to_owned(), format!("Bearer {jwt}")));
        }
        let body = match body {
            RequestBody::None => None,
            RequestBody::Json(text) => {
                headers.push(("Content-Type".to_owned(), "application/json".to_owned()));
                Some(text.into_bytes())
            }
            RequestBody::Multipart(multipart) => {
                headers.push((
                    "Content-Type".to_owned(),
                    format!("multipart/form-data; boundary={}", multipart.boundary),
                ));
                Some(multipart.body)
            }
        };
        HttpRequest {
            method: endpoint.method(),
            url: format!("{}{}", self.base, endpoint.path()),
            headers,
            body,
        }
    }

    /// Sends a request to `endpoint` and reads the response the way the TS
    /// function for it does. The result is the envelope's `data` (`None`
    /// where it is `undefined`) or, where the endpoint takes any body, the
    /// body itself.
    pub async fn send(
        &self,
        endpoint: &Endpoint<'_>,
        jwt: Option<&str>,
        body: RequestBody,
    ) -> Result<Option<Value>, HubError> {
        let requester =
            if endpoint.is_multipart_upload() { &self.requesters.upload } else { &self.requesters.other };
        let label = endpoint.label();
        let request = self.request(endpoint, jwt, body);
        let mode = endpoint.read_mode();
        if mode == ReadMode::RawDownload {
            let reply = requester.request(request).await?;
            if !reply.ok() {
                return Err(self.download_status_error(label, reply));
            }
            return parse_json(&reply.body).map(Some);
        }
        let mut retried = false;
        loop {
            let reply = requester.request(request.clone()).await?;
            if reply.status == 429 {
                let retry_after = parse_retry_after(reply.retry_after.as_deref(), self.timing.now_ms());
                if let Some(seconds) = retry_after.filter(|seconds| !retried && *seconds <= MAX_RETRY_AFTER_S)
                {
                    self.timing.sleep(Duration::from_secs_f64(seconds.max(0.0))).await;
                    retried = true;
                    continue;
                }
                return Err(status_error(label, reply, StatusKind::RateLimited, retry_after));
            }
            if !reply.ok() {
                let kind = match reply.status {
                    401 => StatusKind::Unauthorized,
                    403 => StatusKind::Forbidden,
                    404 if mode == (ReadMode::Strict { typed_not_found: true }) => StatusKind::NotFound,
                    409 => StatusKind::Conflict,
                    _ => StatusKind::Other,
                };
                return Err(status_error(label, reply, kind, None));
            }
            let json = parse_json(&reply.body)?;
            return match mode {
                ReadMode::Lenient => unwrap_lenient(label, json),
                _ => unwrap_strict(label, json),
            };
        }
    }

    /// The failed status of a download: 401, 403 and 429 (with its
    /// `Retry-After`, not retried) have their classes, anything else is a
    /// plain error.
    fn download_status_error(&self, label: &'static str, reply: HttpReply) -> HubError {
        match reply.status {
            401 => status_error(label, reply, StatusKind::Unauthorized, None),
            403 => status_error(label, reply, StatusKind::Forbidden, None),
            429 => {
                let retry_after = parse_retry_after(reply.retry_after.as_deref(), self.timing.now_ms());
                status_error(label, reply, StatusKind::RateLimited, retry_after)
            }
            _ => status_error(label, reply, StatusKind::Other, None),
        }
    }
}

fn status_error(
    label: &'static str,
    reply: HttpReply,
    kind: StatusKind,
    retry_after: Option<f64>,
) -> HubError {
    HubError::Status { label, status: reply.status, body: response_text(&reply.body), kind, retry_after }
}

/// `response.text()`: UTF-8 without a leading byte order mark, each
/// invalid sequence as U+FFFD.
pub fn response_text(body: &[u8]) -> String {
    let body = body.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(body);
    String::from_utf8_lossy(body).into_owned()
}

/// `response.json()`.
fn parse_json(body: &[u8]) -> Result<Value, HubError> {
    pipette_js_json::parse(&response_text(body)).map_err(|err| HubError::Body(err.to_string()))
}

/// `json.ok ? json.data : throw new Error(`${label}: ${json.error ?? 'unknown error'}`)`.
fn unwrap_strict(label: &'static str, json: Value) -> Result<Option<Value>, HubError> {
    match json {
        Value::Null => Err(HubError::Body("Cannot read properties of null (reading 'ok')".to_owned())),
        Value::Object(mut object) => {
            if object.get("ok").is_some_and(Value::is_truthy) {
                Ok(object.remove("data"))
            } else {
                Err(envelope_error(label, object.get("error")))
            }
        }
        // A primitive or an array has neither `ok` nor `error`.
        _ => Err(envelope_error(label, None)),
    }
}

/// An object with an `ok` property is the envelope; anything else is the
/// result.
fn unwrap_lenient(label: &'static str, json: Value) -> Result<Option<Value>, HubError> {
    match json {
        Value::Object(object) if object.contains_key("ok") => unwrap_strict(label, Value::Object(object)),
        other => Ok(Some(other)),
    }
}

fn envelope_error(label: &'static str, error: Option<&Value>) -> HubError {
    let message = match error {
        None | Some(Value::Null) => "unknown error".to_owned(),
        Some(value) => js_string(Some(value)),
    };
    HubError::Envelope { label, message }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_text_drops_a_bom_and_replaces_invalid_bytes() {
        assert_eq!(response_text(b"\xEF\xBB\xBFok"), "ok");
        assert_eq!(response_text(b"a\xFFb"), "a\u{FFFD}b");
        assert_eq!(response_text(b"\xEF\xBB\xBF\xEF\xBB\xBFx"), "\u{FEFF}x");
    }

    #[test]
    fn the_envelope_is_unwrapped_as_the_ts_does() {
        let parse = |text: &str| pipette_js_json::parse(text).unwrap();
        assert_eq!(unwrap_strict("L", parse(r#"{"ok":true,"data":[1]}"#)).unwrap(), Some(parse("[1]")));
        assert_eq!(unwrap_strict("L", parse(r#"{"ok":1}"#)).unwrap(), None);
        for (text, message) in [
            (r#"{"ok":false,"error":"nope"}"#, "L: nope"),
            (r#"{"ok":false,"error":null}"#, "L: unknown error"),
            (r#"{"ok":0,"error":5}"#, "L: 5"),
            (r#"{"ok":"","error":[1,null,2]}"#, "L: 1,,2"),
            (r#"{"data":1}"#, "L: unknown error"),
            (r#"[1]"#, "L: unknown error"),
            (r#""text""#, "L: unknown error"),
        ] {
            assert_eq!(unwrap_strict("L", parse(text)).unwrap_err().to_string(), message, "{text}");
        }
        assert!(matches!(unwrap_strict("L", Value::Null), Err(HubError::Body(_))));

        assert_eq!(unwrap_lenient("L", parse(r#"{"items":[]}"#)).unwrap(), Some(parse(r#"{"items":[]}"#)));
        assert_eq!(unwrap_lenient("L", Value::Null).unwrap(), Some(Value::Null));
        assert_eq!(unwrap_lenient("L", parse(r#"{"ok":true,"data":2}"#)).unwrap(), Some(parse("2")));
        assert_eq!(
            unwrap_lenient("L", parse(r#"{"ok":false}"#)).unwrap_err().to_string(),
            "L: unknown error"
        );
    }
}
