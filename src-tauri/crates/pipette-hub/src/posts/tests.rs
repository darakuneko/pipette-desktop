// SPDX-License-Identifier: GPL-2.0-or-later
//! The keymap post handlers on a scripted Hub for the answers of each
//! status and shape, and on the in-memory Hub for a post's whole life.

#![allow(clippy::unwrap_used)]

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use pipette_js_json::stringify;
use pipette_net::{HttpError, HttpReply, HttpRequest, Method};

use super::*;
use crate::fake::FakeHub;
use crate::http::{HubHttp, HubRequesters, SystemTiming};

const MB: usize = 1024 * 1024;
const TOKEN: &str = r#"{"ok":true,"data":{"token":"jwt-1","user":{"id":"u-1"}}}"#;

/// A Hub that answers each request with the next of its replies and
/// records the requests.
struct Script {
    replies: Mutex<VecDeque<(u16, String)>>,
    seen: Mutex<Vec<HttpRequest>>,
}

fn scripted(replies: &[(u16, &str)]) -> (HubToken, Arc<Script>) {
    let script = Arc::new(Script {
        replies: Mutex::new(replies.iter().map(|(status, body)| (*status, (*body).to_owned())).collect()),
        seen: Mutex::new(Vec::new()),
    });
    let answering = Arc::clone(&script);
    let requester = move |request: HttpRequest| -> Result<HttpReply, HttpError> {
        answering.seen.lock().unwrap().push(request);
        let (status, body) = answering.replies.lock().unwrap().pop_front().expect("a scripted reply");
        Ok(HttpReply {
            status,
            retry_after: None,
            content_type: Some("application/json".to_owned()),
            body: body.into_bytes(),
        })
    };
    let http = HubHttp::new(
        "http://127.0.0.1:9",
        HubRequesters::single(Arc::new(requester)),
        Arc::new(SystemTiming),
    );
    (HubToken::new(http, Arc::new(|| Some("google-id-token".to_owned()))), script)
}

impl Script {
    fn urls(&self) -> Vec<(Method, String)> {
        self.seen.lock().unwrap().iter().map(|request| (request.method, request.url.clone())).collect()
    }
}

/// The body of a multipart request with its boundary written `{boundary}`:
/// each attempt takes the boundary from the clock, so two attempts a
/// millisecond apart differ only there.
fn without_boundary(request: &HttpRequest) -> Vec<u8> {
    let content_type = request
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
        .map(|(_, value)| value.as_str())
        .expect("a content type");
    let boundary = content_type.split_once("boundary=").expect("a boundary").1.as_bytes();
    let body = request.body.as_deref().expect("a body");
    let mut out = Vec::with_capacity(body.len());
    let mut rest = body;
    while let Some(at) = rest.windows(boundary.len()).position(|window| window == boundary) {
        out.extend_from_slice(&rest[..at]);
        out.extend_from_slice(b"{boundary}");
        rest = &rest[at + boundary.len()..];
    }
    out.extend_from_slice(rest);
    out
}

fn params() -> KeymapPostParams<'static> {
    KeymapPostParams {
        title: Some("  My keymap  "),
        keyboard_name: Some(" My Board/v2 "),
        vil_json: Some("{}"),
        pipette_json: Some("{}"),
        keymap_c: Some("c"),
        pdf_base64: Some("JVBERg=="),
        thumbnail_base64: Some("/9j/"),
    }
}

/// The base64 of `n` zero bytes.
fn base64_of(n: usize) -> String {
    let mut text = "AAAA".repeat(n / 3);
    match n % 3 {
        1 => text.push_str("AA=="),
        2 => text.push_str("AAA="),
        _ => {}
    }
    text
}

fn text(answer: &Value) -> String {
    stringify(answer)
}

#[tokio::test]
async fn the_checks_come_before_any_request() {
    let (token, script) = scripted(&[]);
    let big_thumbnail = base64_of(2 * MB + 1);
    let big_pdf = base64_of(10 * MB + 1);
    let big_text = "x".repeat(10 * MB + 1);
    let cases: Vec<(KeymapPostParams<'_>, &str)> = vec![
        (KeymapPostParams { title: Some(" \t "), ..params() }, "Title must not be empty"),
        (KeymapPostParams { title: None, ..params() }, "Title must not be empty"),
        (
            KeymapPostParams { thumbnail_base64: Some(&big_thumbnail), ..params() },
            "File too large: thumbnail exceeds 2 MB limit",
        ),
        (
            KeymapPostParams { vil_json: Some(&big_text), ..params() },
            "File too large: vil exceeds 10 MB limit",
        ),
        (
            KeymapPostParams { pipette_json: Some(&big_text), ..params() },
            "File too large: pipette exceeds 10 MB limit",
        ),
        (
            KeymapPostParams { keymap_c: Some(&big_text), ..params() },
            "File too large: keymap C exceeds 10 MB limit",
        ),
        (
            KeymapPostParams { pdf_base64: Some(&big_pdf), ..params() },
            "File too large: PDF exceeds 10 MB limit",
        ),
        // The first over its limit, in the order thumbnail, vil, pipette, C, PDF.
        (
            KeymapPostParams { pdf_base64: Some(&big_pdf), keymap_c: Some(&big_text), ..params() },
            "File too large: keymap C exceeds 10 MB limit",
        ),
        (
            KeymapPostParams {
                pipette_json: Some(&big_text),
                thumbnail_base64: Some(&big_thumbnail),
                ..params()
            },
            "File too large: thumbnail exceeds 2 MB limit",
        ),
        // The title is checked before the files.
        (
            KeymapPostParams { title: Some(""), pdf_base64: Some(&big_pdf), ..params() },
            "Title must not be empty",
        ),
        (KeymapPostParams { keyboard_name: None, ..params() }, "Upload failed"),
        (KeymapPostParams { pdf_base64: None, ..params() }, "Upload failed"),
    ];
    for (params, error) in cases {
        let answer = upload_post(&token, params).await;
        assert_eq!(text(&answer), format!(r#"{{"success":false,"error":"{error}"}}"#));
    }

    // The update checks the post id first.
    for (post_id, params, error) in [
        (None, params(), "Invalid post ID"),
        (Some("a b"), KeymapPostParams { title: Some(""), ..params() }, "Invalid post ID"),
        (
            Some(""),
            KeymapPostParams { thumbnail_base64: Some(&big_thumbnail), ..params() },
            "Invalid post ID",
        ),
        (Some("post-1"), KeymapPostParams { title: Some(""), ..params() }, "Title must not be empty"),
        (
            Some("post-1"),
            KeymapPostParams { thumbnail_base64: Some(&big_thumbnail), ..params() },
            "File too large: thumbnail exceeds 2 MB limit",
        ),
        (Some("post-1"), KeymapPostParams { vil_json: None, ..params() }, "Update failed"),
    ] {
        let answer = update_post(&token, post_id, params).await;
        assert_eq!(text(&answer), format!(r#"{{"success":false,"error":"{error}"}}"#));
    }

    assert_eq!(
        text(&patch_post(&token, Some("../x"), Some("t")).await),
        r#"{"success":false,"error":"Invalid post ID"}"#
    );
    assert_eq!(
        text(&patch_post(&token, Some("p"), Some(" ")).await),
        r#"{"success":false,"error":"Title must not be empty"}"#
    );
    assert_eq!(
        text(&patch_post(&token, Some("p"), Some(&"x".repeat(201))).await),
        r#"{"success":false,"error":"Title too long"}"#
    );
    assert_eq!(text(&delete_post(&token, None).await), r#"{"success":false,"error":"Invalid post ID"}"#);
    assert_eq!(
        text(&fetch_my_keyboard_posts(&token, None).await),
        r#"{"success":false,"error":"Missing keyboard name"}"#
    );
    assert!(script.urls().is_empty());
}

#[tokio::test]
async fn files_at_their_exact_limit_are_sent() {
    let thumbnail = base64_of(2 * MB);
    let pdf = base64_of(10 * MB);
    let (token, script) = scripted(&[(200, TOKEN), (200, r#"{"ok":true,"data":{"id":"post-1"}}"#)]);
    let answer = upload_post(
        &token,
        KeymapPostParams { thumbnail_base64: Some(&thumbnail), pdf_base64: Some(&pdf), ..params() },
    )
    .await;
    assert_eq!(text(&answer), r#"{"success":true,"postId":"post-1"}"#);
    assert_eq!(script.urls()[1], (Method::Post, "http://127.0.0.1:9/api/files".to_owned()));
}

#[tokio::test]
async fn the_post_id_is_read_from_what_the_hub_answered() {
    for (data, expected) in [
        (r#"{"id":"p","title":"t"}"#, r#"{"success":true,"postId":"p"}"#),
        (r#"{"title":"t"}"#, r#"{"success":true}"#),
        (r#""text""#, r#"{"success":true}"#),
        ("null", r#"{"success":false,"error":"Cannot read properties of null (reading 'id')"}"#),
    ] {
        let (token, _) = scripted(&[(200, TOKEN), (200, &format!(r#"{{"ok":true,"data":{data}}}"#))]);
        assert_eq!(text(&upload_post(&token, params()).await), expected, "{data}");
    }
    let (token, _) = scripted(&[(200, TOKEN), (200, r#"{"ok":true}"#)]);
    assert_eq!(
        text(&update_post(&token, Some("p"), params()).await),
        r#"{"success":false,"error":"Cannot read properties of undefined (reading 'id')"}"#
    );
}

#[tokio::test]
async fn the_sentinels_and_errors_of_each_handler() {
    type Call = for<'a> fn(&'a HubToken) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + 'a>>;
    let calls: [(Call, &str); 6] = [
        (|token| Box::pin(upload_post(token, params())), "Hub upload failed"),
        (|token| Box::pin(update_post(token, Some("post-1"), params())), "Hub update failed"),
        (|token| Box::pin(patch_post(token, Some("post-1"), Some("t"))), "Hub patch failed"),
        (|token| Box::pin(delete_post(token, Some("post-1"))), "Hub delete failed"),
        (|token| Box::pin(fetch_my_posts(token, MyPostsParams::default())), "Hub fetch my posts failed"),
        (|token| Box::pin(fetch_my_keyboard_posts(token, Some("KB"))), "Hub fetch keyboard posts failed"),
    ];
    for (call, label) in calls {
        for (status, body, error) in [
            (403, "banned", "ACCOUNT_DEACTIVATED".to_owned()),
            (429, "slow down", "RATE_LIMITED".to_owned()),
            (404, "Not Found", format!("{label}: 404 Not Found")),
            (500, "boom", format!("{label}: 500 boom")),
            (200, r#"{"ok":false,"error":"Invalid file"}"#, format!("{label}: Invalid file")),
        ] {
            let (token, _) = scripted(&[(200, TOKEN), (status, body)]);
            let expected = format!(r#"{{"success":false,"error":"{error}"}}"#);
            assert_eq!(text(&call(&token).await), expected, "{label} {status}");
        }
        // A 401 takes a new token and runs the request once more; a second
        // 401 is the error.
        let (token, script) = scripted(&[(200, TOKEN), (401, "expired"), (200, TOKEN), (401, "again")]);
        assert_eq!(text(&call(&token).await), format!(r#"{{"success":false,"error":"{label}: 401 again"}}"#));
        assert_eq!(script.urls().len(), 4);
    }
    // Signed out.
    let http = HubHttp::new(
        "http://127.0.0.1:9",
        HubRequesters::single(Arc::new(FakeHub::new())),
        Arc::new(SystemTiming),
    );
    let token = HubToken::new(http, Arc::new(|| None));
    assert_eq!(
        text(&delete_post(&token, Some("p")).await),
        r#"{"success":false,"error":"Not authenticated with Google. Please sign in again."}"#
    );
}

#[tokio::test]
async fn a_401_sends_the_same_body_again_with_the_new_token() {
    let (token, script) = scripted(&[
        (200, TOKEN),
        (401, "expired"),
        (200, r#"{"ok":true,"data":{"token":"jwt-2"}}"#),
        (200, r#"{"ok":true,"data":{"id":"post-1"}}"#),
    ]);
    assert_eq!(text(&upload_post(&token, params()).await), r#"{"success":true,"postId":"post-1"}"#);
    let seen = script.seen.lock().unwrap();
    let (first, second) = (&seen[1], &seen[3]);
    assert_eq!(without_boundary(first), without_boundary(second));
    assert_eq!(first.headers[0].1, "Bearer jwt-1");
    assert_eq!(second.headers[0].1, "Bearer jwt-2");
}

#[tokio::test]
async fn my_posts_clamp_the_paging_and_count_the_pages() {
    let page = |data: &str| format!(r#"{{"ok":true,"data":{data}}}"#);
    let (token, script) = scripted(&[
        (200, TOKEN),
        (200, &page(r#"{"items":[{"id":"p"}],"total":41,"page":1,"per_page":20}"#)),
        (200, &page(r#"{"items":[],"total":5,"page":1,"per_page":0}"#)),
        (200, &page(r#"{"items":[],"total":"many","page":2}"#)),
        (200, &page(r#"[]"#)),
        (200, &page("null")),
    ]);
    let fetch =
        |page: Option<f64>, per_page: Option<f64>| fetch_my_posts(&token, MyPostsParams { page, per_page });
    assert_eq!(
        text(&fetch(None, None).await),
        r#"{"success":true,"posts":[{"id":"p"}],"pagination":{"total":41,"page":1,"per_page":20,"total_pages":3}}"#
    );
    assert_eq!(
        text(&fetch(Some(-5.0), Some(200.0)).await),
        r#"{"success":true,"posts":[],"pagination":{"total":5,"page":1,"per_page":0,"total_pages":5}}"#
    );
    assert_eq!(
        text(&fetch(Some(2.7), Some(0.5)).await),
        r#"{"success":true,"posts":[],"pagination":{"total":"many","page":2,"total_pages":1}}"#
    );
    assert_eq!(
        text(&fetch(Some(f64::NAN), Some(f64::INFINITY)).await),
        r#"{"success":true,"pagination":{"total_pages":1}}"#
    );
    assert_eq!(
        text(&fetch(None, None).await),
        r#"{"success":false,"error":"Cannot read properties of null (reading 'total')"}"#
    );
    let urls: Vec<String> = script.urls().into_iter().skip(1).map(|(_, url)| url).collect();
    assert_eq!(
        urls,
        [
            "http://127.0.0.1:9/api/files/me",
            "http://127.0.0.1:9/api/files/me?page=1&per_page=100",
            "http://127.0.0.1:9/api/files/me?page=2&per_page=1",
            "http://127.0.0.1:9/api/files/me",
            "http://127.0.0.1:9/api/files/me",
        ]
    );
}

#[tokio::test]
async fn a_keymap_post_on_the_in_memory_hub() {
    let hub = Arc::new(FakeHub::new());
    let http = HubHttp::new("http://127.0.0.1:9", HubRequesters::single(hub.clone()), Arc::new(SystemTiming));
    let token = HubToken::new(http, Arc::new(|| Some("test:alice@example.com".to_owned())));

    let uploaded = upload_post(&token, KeymapPostParams { keyboard_name: Some("Board"), ..params() }).await;
    let post_id = uploaded.as_object().unwrap().get("postId").unwrap().as_str().unwrap().to_owned();
    let updated = update_post(
        &token,
        Some(&post_id),
        KeymapPostParams { title: Some("Second"), keyboard_name: Some("Board"), ..params() },
    )
    .await;
    assert_eq!(text(&updated), format!(r#"{{"success":true,"postId":"{post_id}"}}"#));
    assert_eq!(text(&patch_post(&token, Some(&post_id), Some(" Third ")).await), r#"{"success":true}"#);

    let mine = fetch_my_posts(&token, MyPostsParams { page: Some(1.0), per_page: Some(10.0) }).await;
    let mine = text(&mine);
    assert!(mine.contains(r#""title":"Third""#) && mine.contains(r#""total_pages":1"#), "{mine}");
    let board = text(&fetch_my_keyboard_posts(&token, Some("  Board  ")).await);
    assert!(board.starts_with(r#"{"success":true,"posts":[{"#) && board.contains(&post_id), "{board}");
    let other = text(&fetch_my_keyboard_posts(&token, Some("Other")).await);
    assert_eq!(other, r#"{"success":true,"posts":[]}"#);

    assert_eq!(text(&delete_post(&token, Some(&post_id)).await), r#"{"success":true}"#);
    // A post that is gone is a 404 here, unlike a private post.
    let gone = text(&delete_post(&token, Some(&post_id)).await);
    assert!(gone.starts_with(r#"{"success":false,"error":"Hub delete failed: 404 "#), "{gone}");
    assert_eq!(hub.requests().iter().filter(|r| r.path == "/api/auth/token").count(), 1);
}

#[tokio::test]
async fn the_keyboard_name_query_is_encoded_as_encode_uri_component_does() {
    let (token, script) = scripted(&[(200, TOKEN), (200, r#"{"ok":true,"data":[]}"#)]);
    let answer = fetch_my_keyboard_posts(&token, Some(" A b+c!*'()~&=/日 ")).await;
    assert_eq!(text(&answer), r#"{"success":true,"posts":[]}"#);
    assert_eq!(
        script.urls()[1].1,
        "http://127.0.0.1:9/api/files/me/keyboard?name=A%20b%2Bc!*'()~%26%3D%2F%E6%97%A5"
    );
}
