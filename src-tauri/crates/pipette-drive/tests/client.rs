// SPDX-License-Identifier: GPL-2.0-or-later
//! The retries and answers of the Drive client against scripted HTTP
//! answers: the cases of src/main/__tests__/google-drive.test.ts that the
//! request log (tests/request_log.rs) does not hold, mostly requests
//! without an answer, which the Node fake Drive cannot give.

#![allow(clippy::unwrap_used)]

mod common;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use common::{API, TestEnv, UPLOAD};
use pipette_drive::DriveError;
use pipette_drive::client::DriveClient;
use pipette_drive::http::HttpDrive;
use pipette_net::{HttpError, HttpReply, HttpRequest, HttpRequester, Method, RequestFuture};

type Answer = Box<dyn Fn() -> Result<HttpReply, HttpError> + Send + Sync>;
type Hook = Box<dyn Fn() + Send>;

/// Answers each request with the next scripted answer, the last one again
/// once they run out (`stubSequence` of google-drive.test.ts).
#[derive(Clone, Default)]
struct Script {
    answers: Arc<Mutex<VecDeque<Answer>>>,
    requests: Arc<Mutex<Vec<HttpRequest>>>,
    /// Called with each request before it is answered.
    on_request: Arc<Mutex<Option<Hook>>>,
}

fn reply(status: u16, body: &str) -> Answer {
    reply_after(status, body, None)
}

fn reply_after(status: u16, body: &str, retry_after: Option<&str>) -> Answer {
    let body = body.to_owned();
    let retry_after = retry_after.map(str::to_owned);
    Box::new(move || {
        Ok(HttpReply {
            status,
            retry_after: retry_after.clone(),
            content_type: None,
            body: body.clone().into_bytes(),
        })
    })
}

fn network(message: &'static str) -> Answer {
    Box::new(move || Err(HttpError::Network(message.to_owned())))
}

fn timeout() -> Answer {
    Box::new(|| Err(HttpError::Timeout))
}

impl Script {
    fn new(answers: Vec<Answer>) -> Self {
        let script = Self::default();
        *script.answers.lock().unwrap() = answers.into();
        script
    }

    fn requests(&self) -> Vec<HttpRequest> {
        self.requests.lock().unwrap().clone()
    }

    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

impl HttpRequester for Script {
    fn request(&self, request: HttpRequest) -> RequestFuture<'_> {
        self.requests.lock().unwrap().push(request);
        if let Some(hook) = &*self.on_request.lock().unwrap() {
            hook();
        }
        let mut answers = self.answers.lock().unwrap();
        let answer = answers.pop_front().unwrap();
        let result = answer();
        if answers.is_empty() {
            answers.push_back(answer);
        }
        Box::pin(std::future::ready(result))
    }
}

struct Setup {
    script: Script,
    env: Arc<TestEnv>,
    client: DriveClient,
}

fn setup_with_tokens(
    answers: Vec<Answer>,
    tokens: impl Fn() -> Result<Option<String>, String> + Send + Sync + 'static,
) -> Setup {
    let script = Script::new(answers);
    let env = TestEnv::new(0, 0.0);
    let drive = HttpDrive::new(script.clone(), tokens, API, UPLOAD);
    Setup { script, env: env.clone(), client: DriveClient::new(Arc::new(drive), env) }
}

fn setup(answers: Vec<Answer>) -> Setup {
    setup_with_tokens(answers, || Ok(Some("mock-token".to_owned())))
}

const ENVELOPE: &str = r#"{"version":1,"syncUnit":"favorites/macro"}"#;
const LISTING: &str = r#"{"files":[]}"#;

#[tokio::test]
async fn retries_a_request_without_an_answer_when_it_is_safe_to_resend() {
    let s = setup(vec![network("fetch failed"), timeout(), reply(200, ENVELOPE)]);
    assert_eq!(s.client.download("x").await.unwrap(), ENVELOPE.as_bytes());
    assert_eq!(s.script.count(), 3);
    assert_eq!(s.env.sleeps(), [1000.0, 2000.0]);
}

#[tokio::test]
async fn rethrows_the_last_network_error_after_five_attempts() {
    let s = setup(vec![network("fetch failed")]);
    let err = s.client.list_files(None).await.unwrap_err();
    assert_eq!(err.to_string(), "fetch failed");
    assert_eq!(err.error, DriveError::Network("fetch failed".into()));
    assert_eq!(s.script.count(), 5);
}

#[tokio::test]
async fn does_not_resend_a_create_without_an_answer() {
    for answer in [network("fetch failed"), timeout()] {
        let s = setup(vec![answer]);
        let err = s.client.upload_file("n.enc", ENVELOPE, None, false).await.unwrap_err();
        assert!(matches!(err.error, DriveError::Network(_)), "{err:?}");
        assert_eq!(s.script.count(), 1);
        let raw = setup(vec![network("fetch failed")]);
        assert!(raw.client.create_raw_file("x.json", "{}").await.is_err());
        assert_eq!(raw.script.count(), 1);
    }
}

#[tokio::test]
async fn retries_a_body_that_fails_to_parse_never() {
    let s = setup(vec![reply(200, "not json")]);
    let err = s.client.list_files(None).await.unwrap_err();
    assert!(matches!(err.error, DriveError::BadResponse(_)), "{err:?}");
    assert_eq!(s.script.count(), 1);
}

#[tokio::test]
async fn sends_a_request_that_fails_the_same_way_each_time_once() {
    let too_large: Answer = Box::new(|| Err(HttpError::TooLarge { limit: 256 }));
    let refused: Answer = Box::new(|| Err(HttpError::Refused("drive.example".to_owned())));
    for answer in [too_large, refused] {
        let s = setup(vec![answer]);
        let err = s.client.download("x").await.unwrap_err();
        assert!(matches!(err.error, DriveError::Rejected(_)), "{err:?}");
        assert_eq!(s.script.count(), 1);
        assert!(s.env.sleeps().is_empty());
    }
}

#[tokio::test]
async fn does_not_retry_a_network_error_or_a_rate_limit_while_quitting() {
    for answer in [network("fetch failed"), reply(429, "slow down"), reply(503, "boom")] {
        let s = setup(vec![answer]);
        s.env.quitting.store(true, Ordering::SeqCst);
        assert!(s.client.delete_file("x").await.is_err());
        assert_eq!(s.script.count(), 1);
        assert!(s.env.sleeps().is_empty());
    }
}

#[tokio::test]
async fn does_not_wait_or_resend_when_quitting_begins_during_a_request() {
    let s = setup(vec![reply(503, "boom")]);
    let env = s.env.clone();
    *s.script.on_request.lock().unwrap() = Some(Box::new(move || env.quitting.store(true, Ordering::SeqCst)));
    assert_eq!(s.client.list_files(None).await.unwrap_err().to_string(), "Drive list failed: 503 boom");
    assert_eq!(s.script.count(), 1);
    assert!(s.env.sleeps().is_empty());
}

#[tokio::test]
async fn throws_the_last_error_when_quitting_begins_during_the_wait() {
    let s = setup(vec![network("fetch failed")]);
    s.env.quit_on_next_wait.store(true, Ordering::SeqCst);
    assert_eq!(s.client.download("x").await.unwrap_err().to_string(), "fetch failed");
    assert_eq!(s.script.count(), 1);
    assert_eq!(s.env.sleeps().len(), 1);
}

#[tokio::test]
async fn asks_for_the_token_before_every_attempt() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let tokens = move || Ok(Some(format!("token-{}", counter.fetch_add(1, Ordering::SeqCst) + 1)));
    let s = setup_with_tokens(vec![reply(500, "boom"), reply(200, LISTING)], tokens);
    s.client.list_files(None).await.unwrap();
    let auth: Vec<String> = s.script.requests().iter().map(|request| request.headers[0].1.clone()).collect();
    assert_eq!(auth, ["Bearer token-1", "Bearer token-2"]);
}

#[tokio::test]
async fn sends_nothing_and_retries_nothing_without_a_token() {
    let s = setup_with_tokens(vec![reply(200, LISTING)], || Ok(None));
    let err = s.client.list_files(None).await.unwrap_err();
    assert_eq!(err.to_string(), "Not authenticated with Google Drive");
    assert_eq!(s.script.count(), 0);
    let s = setup_with_tokens(vec![reply(200, LISTING)], || Err("refresh failed".to_owned()));
    assert_eq!(s.client.delete_file("x").await.unwrap_err().error, DriveError::Auth("refresh failed".into()));
    assert_eq!(s.script.count(), 0);
}

#[tokio::test]
async fn backs_off_exponentially_with_jitter() {
    let s = setup(vec![
        reply(502, "boom"),
        reply(502, "boom"),
        reply(502, "boom"),
        reply(502, "boom"),
        reply(200, LISTING),
    ]);
    s.client.list_files(None).await.unwrap();
    // TestEnv draws 0 for the jitter.
    assert_eq!(s.env.sleeps(), [1000.0, 2000.0, 4000.0, 8000.0]);
}

#[tokio::test]
async fn reads_retry_after_in_seconds_capped_at_30_s() {
    let s = setup(vec![
        reply_after(429, "slow", Some("3")),
        reply_after(429, "slow", Some("120")),
        reply_after(429, "slow", Some("")),
        reply(200, LISTING),
    ]);
    s.client.list_files(None).await.unwrap();
    assert_eq!(s.env.sleeps(), [3000.0, 30_000.0, 4000.0]);
}

#[tokio::test]
async fn retries_403_only_for_a_rate_limit() {
    let limit = r#"{"error":{"code":403,"errors":[{"reason":"rateLimitExceeded"}]}}"#;
    let s = setup(vec![reply(403, limit), reply(200, r#"{"id":"new","modifiedTime":"m"}"#)]);
    let file = s.client.upload_file("n.enc", ENVELOPE, None, false).await.unwrap();
    assert_eq!((file.id.as_str(), file.modified_time.as_str()), ("new", "m"));
    assert_eq!(s.script.count(), 2);
    let s = setup(vec![reply(403, "forbidden")]);
    assert_eq!(s.client.download("x").await.unwrap_err().to_string(), "Drive download failed: 403 forbidden");
    assert_eq!(s.script.count(), 1);
}

#[tokio::test]
async fn creates_the_file_when_the_id_to_update_is_gone() {
    let s = setup(vec![reply(404, "not found"), reply(200, r#"{"id":"new-id","modifiedTime":"m"}"#)]);
    let file = s.client.upload_file("n.enc", ENVELOPE, Some("gone-id"), true).await.unwrap();
    assert_eq!(file.id, "new-id");
    let methods: Vec<Method> = s.script.requests().iter().map(|request| request.method).collect();
    assert_eq!(methods, [Method::Patch, Method::Post]);
    let s = setup(vec![reply(404, "not found")]);
    let err = s.client.upload_file("n.enc", ENVELOPE, Some("gone-id"), false).await.unwrap_err();
    assert_eq!(err.to_string(), "Drive update failed: 404 not found");
    assert_eq!(err.status(), Some(404));
    assert_eq!(s.script.count(), 1);
}

#[tokio::test]
async fn answers_none_for_a_rename_of_a_file_gone_and_ok_for_its_delete() {
    let s = setup(vec![reply(404, "gone")]);
    assert_eq!(s.client.rename_file("gone", "b.enc").await.unwrap(), None);
    s.client.delete_file("gone").await.unwrap();
    assert_eq!(s.script.count(), 2);
}

#[tokio::test]
async fn keeps_the_start_of_an_error_body_that_is_not_utf8() {
    let s = setup(vec![Box::new(|| {
        Ok(HttpReply { status: 400, retry_after: None, content_type: None, body: vec![b'b', 0xff, b'd'] })
    })]);
    assert_eq!(
        s.client.download("x").await.unwrap_err().to_string(),
        "Drive download failed: 400 b\u{fffd}d"
    );
}
