// SPDX-License-Identifier: GPL-2.0-or-later
//! The Hub's HTTP layer against scripted replies: the request each
//! endpoint sends, the three ways of reading a response, the error each
//! failure becomes, and the one retry after a short 429.

#![allow(clippy::unwrap_used)]

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pipette_hub::fake::{FAKE_HUB_BASE, FakeHub, Fault};
use pipette_hub::multipart::{MultipartBody, UploadFile, pack_body, post_boundary};
use pipette_hub::{
    Endpoint, HubError, HubHttp, HubRequesters, HubTiming, ListQuery, RequestBody, StatusKind,
};
use pipette_js_json::{Value, parse};
use pipette_net::{HttpError, HttpReply, HttpRequest, Method};

/// A clock at a fixed time whose sleeps are recorded and return at once.
#[derive(Default)]
struct Clock {
    slept: Mutex<Vec<Duration>>,
}

impl HubTiming for Clock {
    fn now_ms(&self) -> f64 {
        784_111_770_000.0
    }

    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.slept.lock().unwrap().push(duration);
        Box::pin(std::future::ready(()))
    }
}

/// Answers each request with the next scripted reply and records it.
struct Script {
    replies: Mutex<VecDeque<Result<HttpReply, HttpError>>>,
    seen: Mutex<Vec<HttpRequest>>,
}

fn reply(status: u16, retry_after: Option<&str>, body: &str) -> Result<HttpReply, HttpError> {
    Ok(HttpReply {
        status,
        retry_after: retry_after.map(str::to_owned),
        content_type: Some("application/json".to_owned()),
        body: body.as_bytes().to_vec(),
    })
}

struct Harness {
    http: HubHttp,
    script: Arc<Script>,
    clock: Arc<Clock>,
}

fn harness(replies: Vec<Result<HttpReply, HttpError>>) -> Harness {
    let script = Arc::new(Script { replies: Mutex::new(replies.into()), seen: Mutex::new(Vec::new()) });
    let answer = Arc::clone(&script);
    let requester = move |request: HttpRequest| {
        answer.seen.lock().unwrap().push(request);
        answer.replies.lock().unwrap().pop_front().expect("a scripted reply")
    };
    let clock = Arc::new(Clock::default());
    let http = HubHttp::new("http://127.0.0.1:9", HubRequesters::single(Arc::new(requester)), clock.clone());
    Harness { http, script, clock }
}

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(future)
}

fn send(
    h: &Harness,
    endpoint: Endpoint<'_>,
    jwt: Option<&str>,
    body: RequestBody,
) -> Result<Option<Value>, HubError> {
    block_on(h.http.send(&endpoint, jwt, body))
}

#[test]
fn sends_the_recorded_requests_headers_and_body() {
    let h = harness(vec![reply(200, None, r#"{"ok":true,"data":{"token":"t"}}"#)]);
    let data =
        send(&h, Endpoint::AuthToken, None, RequestBody::Json(r#"{"id_token":"x"}"#.to_owned())).unwrap();
    assert_eq!(data, Some(parse(r#"{"token":"t"}"#).unwrap()));
    let seen = h.script.seen.lock().unwrap();
    assert_eq!(seen[0].method, Method::Post);
    assert_eq!(seen[0].url, "http://127.0.0.1:9/api/auth/token");
    assert_eq!(seen[0].headers, [("Content-Type".to_owned(), "application/json".to_owned())]);
    assert_eq!(seen[0].body.as_deref(), Some(&br#"{"id_token":"x"}"#[..]));
}

#[test]
fn a_multipart_request_carries_the_jwt_then_the_boundary() {
    let h = harness(vec![reply(200, None, r#"{"ok":true,"data":{"id":"p"}}"#)]);
    let body = pack_body(post_boundary(5), &UploadFile { name: "a.json".to_owned(), data: b"{}".to_vec() });
    send(&h, Endpoint::UpdatePost { post_id: "p 1" }, Some("jwt"), RequestBody::Multipart(body.clone()))
        .unwrap();
    let seen = h.script.seen.lock().unwrap();
    assert_eq!(seen[0].method, Method::Put);
    assert_eq!(seen[0].url, "http://127.0.0.1:9/api/files/p%201");
    assert_eq!(
        seen[0].headers,
        [
            ("Authorization".to_owned(), "Bearer jwt".to_owned()),
            ("Content-Type".to_owned(), "multipart/form-data; boundary=----PipetteBoundary5".to_owned()),
        ]
    );
    let MultipartBody { body, .. } = body;
    assert_eq!(seen[0].body.as_deref(), Some(&body[..]));
}

#[test]
fn a_short_429_is_retried_once_after_its_wait() {
    let h = harness(vec![reply(429, Some("2"), "slow down"), reply(200, None, r#"{"ok":true,"data":[]}"#)]);
    let data =
        send(&h, Endpoint::MyPosts { page: None, per_page: None }, Some("j"), RequestBody::None).unwrap();
    assert_eq!(data, Some(parse("[]").unwrap()));
    assert_eq!(*h.clock.slept.lock().unwrap(), [Duration::from_secs(2)]);
    assert_eq!(h.script.seen.lock().unwrap().len(), 2);
}

#[test]
fn a_date_retry_after_waits_until_then() {
    let h = harness(vec![
        reply(429, Some("Sun, 06 Nov 1994 08:49:37 GMT"), ""),
        reply(200, None, r#"{"ok":true,"data":1}"#),
    ]);
    send(&h, Endpoint::AuthMe, Some("j"), RequestBody::None).unwrap();
    assert_eq!(*h.clock.slept.lock().unwrap(), [Duration::from_secs(7)]);
}

#[test]
fn a_long_or_missing_retry_after_and_a_second_429_are_rate_limited() {
    for script in [
        vec![reply(429, None, "no header")],
        vec![reply(429, Some("86400"), r#"{"ok":false,"error":"Daily upload limit exceeded"}"#)],
        vec![reply(429, Some("1"), ""), reply(429, Some("5"), "again")],
    ] {
        let calls = script.len();
        let h = harness(script);
        let err = send(&h, Endpoint::UploadPost, Some("j"), RequestBody::None).unwrap_err();
        assert_eq!(err.status_kind(), Some(StatusKind::RateLimited), "{err}");
        assert!(err.to_string().starts_with("Hub upload failed: 429 "), "{err}");
        assert_eq!(h.script.seen.lock().unwrap().len(), calls);
    }
    let h = harness(vec![reply(429, Some("86400"), "daily")]);
    let HubError::Status { retry_after, .. } =
        send(&h, Endpoint::UploadPost, Some("j"), RequestBody::None).unwrap_err()
    else {
        panic!("not a status error");
    };
    assert_eq!(retry_after, Some(86400.0));
    assert!(h.clock.slept.lock().unwrap().is_empty());
}

#[test]
fn failed_statuses_get_the_recorded_classes_and_messages() {
    let cases = [
        (Endpoint::AuthMe, 401, Some(StatusKind::Unauthorized)),
        (Endpoint::AuthMe, 403, Some(StatusKind::Forbidden)),
        (Endpoint::DeletePost { post_id: "x" }, 404, Some(StatusKind::NotFound)),
        (Endpoint::KeyLabelDelete { post_id: "x" }, 404, Some(StatusKind::Other)),
        (Endpoint::I18nDelete { post_id: "x" }, 404, Some(StatusKind::Other)),
        (Endpoint::KeyLabelUpload, 409, Some(StatusKind::Conflict)),
        (Endpoint::ThemeUpload, 409, Some(StatusKind::Conflict)),
        (Endpoint::AuthToken, 500, Some(StatusKind::Other)),
    ];
    for (endpoint, status, kind) in cases {
        let h = harness(vec![reply(status, None, "body text")]);
        let err = send(&h, endpoint, None, RequestBody::None).unwrap_err();
        assert_eq!(err.status_kind(), kind, "{endpoint:?}");
        assert_eq!(err.to_string(), format!("{}: {status} body text", endpoint.label()));
    }
}

#[test]
fn the_downloads_read_raw_and_do_not_retry() {
    let h = harness(vec![reply(200, None, r#"{"version":1,"ok":false}"#)]);
    let data = send(&h, Endpoint::I18nDownload { post_id: "p" }, None, RequestBody::None).unwrap();
    assert_eq!(data, Some(parse(r#"{"version":1,"ok":false}"#).unwrap()));
    for (status, kind) in [
        (401, StatusKind::Unauthorized),
        (403, StatusKind::Forbidden),
        (429, StatusKind::RateLimited),
        (409, StatusKind::Other),
        (404, StatusKind::Other),
    ] {
        let h = harness(vec![reply(status, Some("1"), "nope")]);
        let err = send(&h, Endpoint::KeyLabelDownload { post_id: "k" }, None, RequestBody::None).unwrap_err();
        assert_eq!(err.status_kind(), Some(kind));
        assert_eq!(err.to_string(), format!("Hub key-label download failed: {status} nope"));
        assert!(h.clock.slept.lock().unwrap().is_empty());
    }
    let h = harness(vec![reply(429, Some("3"), "")]);
    let HubError::Status { retry_after, .. } =
        send(&h, Endpoint::I18nDownload { post_id: "p" }, None, RequestBody::None).unwrap_err()
    else {
        panic!("not a status error");
    };
    assert_eq!(retry_after, Some(3.0));
}

#[test]
fn the_lenient_endpoints_take_a_body_without_the_envelope() {
    let h = harness(vec![reply(200, None, r#"{"items":[],"total":0}"#), reply(200, None, r#"{"ok":false}"#)]);
    let list = send(&h, Endpoint::ThemeList(ListQuery::default()), None, RequestBody::None).unwrap();
    assert_eq!(list, Some(parse(r#"{"items":[],"total":0}"#).unwrap()));
    let err = send(&h, Endpoint::ThemeList(ListQuery::default()), None, RequestBody::None).unwrap_err();
    assert_eq!(err.to_string(), "Hub theme list failed: unknown error");
    // The strict endpoints need the envelope.
    let h = harness(vec![reply(200, None, r#"{"items":[]}"#), reply(200, None, "not json")]);
    let err = send(&h, Endpoint::KeyLabelList(ListQuery::default()), None, RequestBody::None).unwrap_err();
    assert_eq!(err.to_string(), "Hub key-label list failed: unknown error");
    let err = send(&h, Endpoint::KeyLabelList(ListQuery::default()), None, RequestBody::None).unwrap_err();
    assert!(matches!(err, HubError::Body(_)), "{err:?}");
}

#[test]
fn a_request_without_a_response_is_a_network_error() {
    let h = harness(vec![Err(HttpError::Refused("example.com".to_owned()))]);
    let err = send(&h, Endpoint::AuthMe, Some("j"), RequestBody::None).unwrap_err();
    assert!(matches!(err, HubError::Network(HttpError::Refused(_))), "{err:?}");
    assert_eq!(err.status_kind(), None);
}

#[test]
fn reads_the_in_memory_hub() {
    let hub = Arc::new(FakeHub::new());
    let http = HubHttp::new(FAKE_HUB_BASE, HubRequesters::single(hub.clone()), Arc::new(Clock::default()));
    let token = block_on(http.send(
        &Endpoint::AuthToken,
        None,
        RequestBody::Json(r#"{"id_token":"test:alice@example.com"}"#.to_owned()),
    ))
    .unwrap()
    .unwrap();
    let jwt = token.as_object().unwrap().get("token").unwrap().as_str().unwrap().to_owned();
    let me = block_on(http.send(&Endpoint::AuthMe, Some(&jwt), RequestBody::None)).unwrap().unwrap();
    assert_eq!(me.as_object().unwrap().get("display_name").unwrap().as_str(), Some("alice"));

    hub.inject(Fault::new(401, 1).only("auth.me"));
    let err = block_on(http.send(&Endpoint::AuthMe, Some(&jwt), RequestBody::None)).unwrap_err();
    assert_eq!(err.status_kind(), Some(StatusKind::Unauthorized));
    assert_eq!(
        err.to_string(),
        r#"Hub fetch auth me failed: 401 {"ok":false,"error":"Invalid or expired token"}"#
    );
    assert_eq!(
        hub.requests().last().unwrap().header("authorization"),
        Some(format!("Bearer {jwt}").as_str())
    );

    hub.inject(Fault::new(429, 1).retry_after("1"));
    let list =
        block_on(http.send(&Endpoint::KeyLabelList(ListQuery::default()), None, RequestBody::None)).unwrap();
    assert!(list.is_some());
    assert_eq!(hub.requests().iter().filter(|r| r.op == Some("keyLabels.list")).count(), 2);
}
