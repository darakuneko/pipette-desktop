// SPDX-License-Identifier: GPL-2.0-or-later
//! The token cache and the retry after a 401, on a scripted Hub whose
//! answers can be held until a test lets them go.

#![allow(clippy::unwrap_used)]

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pipette_net::{HttpError, HttpReply, HttpRequest, HttpRequester, Method, RequestFuture};
use tokio::sync::Notify;

use super::*;
use crate::http::{HubRequesters, HubTiming};

/// How long a test waits for something that should happen at once.
const WAIT: Duration = Duration::from_secs(10);

struct Reply {
    status: u16,
    body: String,
    retry_after: Option<String>,
    /// The answer waits for this before it is sent.
    hold: Option<Arc<Notify>>,
}

fn ok(data: &str) -> Reply {
    Reply { status: 200, body: format!(r#"{{"ok":true,"data":{data}}}"#), retry_after: None, hold: None }
}

fn status(status: u16, body: &str) -> Reply {
    Reply { status, body: body.to_owned(), retry_after: None, hold: None }
}

fn token_reply(jwt: &str) -> Reply {
    ok(&format!(r#"{{"token":"{jwt}","user":{{"id":"u-1"}}}}"#))
}

fn held(reply: Reply, hold: &Arc<Notify>) -> Reply {
    Reply { hold: Some(Arc::clone(hold)), ..reply }
}

const USER: &str = r#"{"id":"u-1","email":"user@example.com","display_name":"User","role":"user"}"#;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Seen {
    method: Method,
    path: String,
    authorization: Option<String>,
    body: Option<String>,
}

/// A Hub that answers `/api/auth/token` and the other paths from their
/// own queues, records the requests, and tells when a request arrived.
#[derive(Default)]
struct ScriptHub {
    tokens: Mutex<VecDeque<Reply>>,
    others: Mutex<VecDeque<Reply>>,
    seen: Mutex<Vec<Seen>>,
    arrived: Notify,
    token_requests: AtomicUsize,
}

impl ScriptHub {
    fn new(tokens: Vec<Reply>, others: Vec<Reply>) -> Arc<Self> {
        Arc::new(Self {
            tokens: Mutex::new(tokens.into()),
            others: Mutex::new(others.into()),
            ..Self::default()
        })
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    fn token_requests(&self) -> usize {
        self.token_requests.load(Ordering::SeqCst)
    }

    /// Waits, at most [`WAIT`], until `count` token requests have arrived.
    async fn wait_for_token_requests(&self, count: usize) {
        tokio::time::timeout(WAIT, async {
            while self.token_requests() < count {
                let arrived = self.arrived.notified();
                if self.token_requests() >= count {
                    break;
                }
                arrived.await;
            }
        })
        .await
        .expect("the token request arrives");
    }
}

impl HttpRequester for ScriptHub {
    fn request(&self, request: HttpRequest) -> RequestFuture<'_> {
        let path = request.url.strip_prefix(BASE).unwrap().to_owned();
        let header =
            |name: &str| request.headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone());
        self.seen.lock().unwrap().push(Seen {
            method: request.method,
            path: path.clone(),
            authorization: header("Authorization"),
            body: request.body.as_ref().map(|body| String::from_utf8(body.clone()).unwrap()),
        });
        let reply = if path == "/api/auth/token" {
            self.token_requests.fetch_add(1, Ordering::SeqCst);
            self.tokens.lock().unwrap().pop_front()
        } else {
            self.others.lock().unwrap().pop_front()
        };
        self.arrived.notify_waiters();
        let reply = reply.unwrap_or_else(|| panic!("no answer for {path}"));
        Box::pin(async move {
            if let Some(hold) = &reply.hold {
                hold.notified().await;
            }
            Ok::<_, HttpError>(HttpReply {
                status: reply.status,
                retry_after: reply.retry_after,
                content_type: Some("application/json".to_owned()),
                body: reply.body.into_bytes(),
            })
        })
    }
}

const BASE: &str = "http://127.0.0.1:9";

/// A clock the tests move; sleeps return at once.
#[derive(Default)]
struct TestClock {
    now: Mutex<f64>,
    slept: Mutex<Vec<Duration>>,
}

impl TestClock {
    fn advance(&self, ms: f64) {
        *self.now.lock().unwrap() += ms;
    }
}

impl HubTiming for TestClock {
    fn now_ms(&self) -> f64 {
        *self.now.lock().unwrap()
    }

    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.slept.lock().unwrap().push(duration);
        Box::pin(std::future::ready(()))
    }
}

struct Setup {
    token: Arc<HubToken>,
    hub: Arc<ScriptHub>,
    clock: Arc<TestClock>,
    id_token_calls: Arc<AtomicUsize>,
}

/// A token cache on `hub`, signed in as `id_token` (`None`: signed out).
fn setup_with(hub: Arc<ScriptHub>, id_token: Option<&'static str>) -> Setup {
    let clock = Arc::new(TestClock { now: Mutex::new(1_000_000.0), ..TestClock::default() });
    let http = HubHttp::new(BASE, HubRequesters::single(hub.clone()), clock.clone());
    let id_token_calls = Arc::new(AtomicUsize::new(0));
    let calls = Arc::clone(&id_token_calls);
    let source = move || {
        calls.fetch_add(1, Ordering::SeqCst);
        id_token.map(str::to_owned)
    };
    let token = Arc::new(HubToken::new(http, Arc::new(source)));
    Setup { token, hub, clock, id_token_calls }
}

fn setup(tokens: Vec<Reply>, others: Vec<Reply>) -> Setup {
    setup_with(ScriptHub::new(tokens, others), Some("id-token"))
}

/// `HUB_FETCH_AUTH_ME` through the cache: `Ok(user)` or the message.
async fn fetch_me(token: &HubToken) -> Result<String, String> {
    token
        .with_token_retry(|jwt| async move {
            token.http().send(&Endpoint::AuthMe, Some(jwt.as_str()), RequestBody::None).await
        })
        .await
        .map(|user| stringify(&user.unwrap()))
        .map_err(|err| err.message)
}

fn me_bearers(hub: &ScriptHub) -> Vec<String> {
    hub.seen()
        .into_iter()
        .filter(|seen| seen.path == "/api/auth/me")
        .map(|seen| seen.authorization.unwrap())
        .collect()
}

fn token_bodies(hub: &ScriptHub) -> Vec<String> {
    hub.seen()
        .into_iter()
        .filter(|seen| seen.path == "/api/auth/token")
        .map(|seen| seen.body.unwrap())
        .collect()
}

#[tokio::test]
async fn the_token_is_reused_for_its_24_hours_only() {
    let s = setup(vec![token_reply("jwt-1"), token_reply("jwt-2")], (0..4).map(|_| ok(USER)).collect());
    assert_eq!(fetch_me(&s.token).await.unwrap(), USER);
    assert_eq!(fetch_me(&s.token).await.unwrap(), USER);
    assert_eq!(s.hub.token_requests(), 1);
    // The JWT's own `exp` is not read: the cache keeps it 24 hours.
    s.clock.advance(HUB_JWT_TTL_MS - 1.0);
    fetch_me(&s.token).await.unwrap();
    assert_eq!(s.hub.token_requests(), 1);
    s.clock.advance(1.0);
    fetch_me(&s.token).await.unwrap();
    assert_eq!(s.hub.token_requests(), 2);
    assert_eq!(me_bearers(&s.hub), ["Bearer jwt-1", "Bearer jwt-1", "Bearer jwt-1", "Bearer jwt-2"]);
    assert_eq!(token_bodies(&s.hub), [r#"{"id_token":"id-token"}"#; 2]);
    assert!(s.token.snapshot().cached);
}

#[tokio::test]
async fn calls_made_together_share_one_token_request() {
    let hold = Arc::new(Notify::new());
    let s = setup(vec![held(token_reply("jwt-1"), &hold)], (0..3).map(|_| ok(USER)).collect());
    let release = async {
        s.hub.wait_for_token_requests(1).await;
        assert!(s.token.snapshot().inflight);
        hold.notify_one();
    };
    let (a, b, c, ()) = tokio::join!(fetch_me(&s.token), fetch_me(&s.token), fetch_me(&s.token), release);
    for answer in [a, b, c] {
        assert_eq!(answer.unwrap(), USER);
    }
    assert_eq!(s.hub.token_requests(), 1);
    assert_eq!(me_bearers(&s.hub), ["Bearer jwt-1"; 3]);
    let snapshot = s.token.snapshot();
    assert!(snapshot.cached && !snapshot.inflight);
}

#[tokio::test]
async fn clearing_takes_a_new_token_and_forgets_the_display_name() {
    let s = setup(vec![token_reply("jwt-1"), token_reply("jwt-2")], vec![ok(USER), ok(USER)]);
    s.token.set_pending_display_name(Some("Name".to_owned()));
    fetch_me(&s.token).await.unwrap();
    s.token.clear();
    let snapshot = s.token.snapshot();
    assert_eq!(
        snapshot,
        TokenSnapshot { cached: false, inflight: false, generation: 1, display_name_pending: false }
    );
    fetch_me(&s.token).await.unwrap();
    assert_eq!(
        token_bodies(&s.hub),
        [r#"{"id_token":"id-token","display_name":"Name"}"#, r#"{"id_token":"id-token"}"#]
    );
    assert_eq!(me_bearers(&s.hub), ["Bearer jwt-1", "Bearer jwt-2"]);
}

#[tokio::test]
async fn a_failed_token_request_is_not_cached() {
    let s = setup(vec![status(500, "down"), token_reply("jwt-1")], vec![ok(USER)]);
    assert_eq!(fetch_me(&s.token).await.unwrap_err(), "Hub auth failed: 500 down");
    assert!(!s.token.snapshot().cached);
    assert_eq!(fetch_me(&s.token).await.unwrap(), USER);
    assert_eq!(s.hub.token_requests(), 2);
}

/// A token taken while the cache is cleared is not cached, and the callers
/// of the overtaken request still get its token.
#[tokio::test]
async fn a_token_taken_while_the_cache_is_cleared_is_not_kept() {
    let hold = Arc::new(Notify::new());
    let s = setup(
        vec![held(token_reply("stale-jwt"), &hold), token_reply("fresh-jwt")],
        vec![ok(USER), ok(USER)],
    );
    let clear = async {
        s.hub.wait_for_token_requests(1).await;
        s.token.clear();
        hold.notify_one();
    };
    let (answer, ()) = tokio::join!(fetch_me(&s.token), clear);
    answer.unwrap();
    assert!(!s.token.snapshot().cached);
    fetch_me(&s.token).await.unwrap();
    assert_eq!(s.hub.token_requests(), 2);
    assert_eq!(me_bearers(&s.hub), ["Bearer stale-jwt", "Bearer fresh-jwt"]);
}

/// Setting the display name keeps the generation: the request it
/// overtook is still cached when it ends, and its end forgets the shared
/// request started after the display name was set.
#[tokio::test]
async fn a_display_name_set_during_a_request_keeps_the_ts_quirks() {
    let first = Arc::new(Notify::new());
    let second = Arc::new(Notify::new());
    let s = setup(
        vec![held(token_reply("jwt-old"), &first), held(token_reply("jwt-new"), &second)],
        (0..3).map(|_| ok(USER)).collect(),
    );
    let spawn_fetch = |token: &Arc<HubToken>| {
        let token = Arc::clone(token);
        tokio::spawn(async move { fetch_me(&token).await })
    };
    let old = spawn_fetch(&s.token);
    s.hub.wait_for_token_requests(1).await;
    s.token.set_pending_display_name(Some("New".to_owned()));
    assert!(!s.token.snapshot().inflight);
    let new = spawn_fetch(&s.token);
    s.hub.wait_for_token_requests(2).await;
    assert!(s.token.snapshot().inflight);

    first.notify_one();
    tokio::time::timeout(WAIT, old).await.unwrap().unwrap().unwrap();
    // Cached although a display name was set meanwhile, and the second
    // request, still running, is no longer shared.
    let snapshot = s.token.snapshot();
    assert!(snapshot.cached && !snapshot.inflight);

    second.notify_one();
    tokio::time::timeout(WAIT, new).await.unwrap().unwrap().unwrap();
    assert_eq!(
        token_bodies(&s.hub),
        [r#"{"id_token":"id-token"}"#, r#"{"id_token":"id-token","display_name":"New"}"#]
    );
    // The second request ended last and its token is the one cached.
    fetch_me(&s.token).await.unwrap();
    assert_eq!(me_bearers(&s.hub), ["Bearer jwt-old", "Bearer jwt-new", "Bearer jwt-new"]);
    assert_eq!(s.token.snapshot().generation, 0);
}

#[tokio::test]
async fn a_leader_dropped_before_its_answer_lets_the_next_caller_ask_again() {
    let hold = Arc::new(Notify::new());
    let s = setup(vec![held(token_reply("lost"), &hold), token_reply("jwt-1")], vec![ok(USER)]);
    let leader = s.token.get();
    tokio::select! {
        _ = leader => panic!("the held answer arrived"),
        () = s.hub.wait_for_token_requests(1) => {}
    }
    assert!(!s.token.snapshot().inflight);
    assert_eq!(fetch_me(&s.token).await.unwrap(), USER);
    assert_eq!(me_bearers(&s.hub), ["Bearer jwt-1"]);
}

#[tokio::test]
async fn the_display_name_goes_with_the_next_token_only_when_not_empty() {
    let s = setup(
        (1..=4).map(|n| token_reply(&format!("jwt-{n}"))).collect(),
        (0..4).map(|_| ok(USER)).collect(),
    );
    s.token.set_pending_display_name(Some("Alice \"A\"".to_owned()));
    fetch_me(&s.token).await.unwrap();
    s.token.set_pending_display_name(Some(String::new()));
    fetch_me(&s.token).await.unwrap();
    s.token.set_pending_display_name(None);
    fetch_me(&s.token).await.unwrap();
    s.token.set_pending_display_name(Some("日本語".to_owned()));
    fetch_me(&s.token).await.unwrap();
    assert_eq!(
        token_bodies(&s.hub),
        [
            r#"{"id_token":"id-token","display_name":"Alice \"A\""}"#,
            r#"{"id_token":"id-token"}"#,
            r#"{"id_token":"id-token"}"#,
            r#"{"id_token":"id-token","display_name":"日本語"}"#,
        ]
    );
    assert_eq!(s.token.snapshot().generation, 0);
}

#[tokio::test]
async fn signed_out_sends_nothing() {
    let s = setup_with(ScriptHub::new(vec![], vec![]), None);
    assert_eq!(fetch_me(&s.token).await.unwrap_err(), HUB_ERROR_NOT_AUTHENTICATED);
    assert!(s.hub.seen().is_empty());
    assert_eq!(s.id_token_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_401_takes_a_new_token_and_retries_once() {
    let s = setup(vec![token_reply("jwt-1"), token_reply("jwt-2")], vec![status(401, "expired"), ok(USER)]);
    assert_eq!(fetch_me(&s.token).await.unwrap(), USER);
    assert_eq!(me_bearers(&s.hub), ["Bearer jwt-1", "Bearer jwt-2"]);
}

#[tokio::test]
async fn a_second_401_is_the_error_and_the_new_token_stays_cached() {
    let s = setup(
        vec![token_reply("jwt-1"), token_reply("jwt-2")],
        vec![status(401, "expired"), status(401, "still"), ok(USER)],
    );
    assert_eq!(fetch_me(&s.token).await.unwrap_err(), "Hub fetch auth me failed: 401 still");
    assert_eq!(fetch_me(&s.token).await.unwrap(), USER);
    assert_eq!(s.hub.token_requests(), 2);
    assert_eq!(me_bearers(&s.hub), ["Bearer jwt-1", "Bearer jwt-2", "Bearer jwt-2"]);
}

#[tokio::test]
async fn a_failed_token_request_of_the_retry_is_the_error() {
    let s = setup(vec![token_reply("jwt-1"), status(401, "Unauthorized")], vec![status(401, "x")]);
    assert_eq!(fetch_me(&s.token).await.unwrap_err(), "Hub auth failed: 401 Unauthorized");
}

#[tokio::test]
async fn other_failures_are_not_retried() {
    let s = setup(vec![token_reply("jwt-1")], vec![status(500, "Internal Server Error")]);
    assert_eq!(fetch_me(&s.token).await.unwrap_err(), "Hub fetch auth me failed: 500 Internal Server Error");
    assert_eq!(me_bearers(&s.hub).len(), 1);
}

#[tokio::test]
async fn a_403_or_429_is_its_sentinel_before_and_after_a_retry() {
    let rate_limited = || Reply { retry_after: Some("120".to_owned()), ..status(429, "slow") };
    let s = setup(
        vec![token_reply("jwt-1"), token_reply("jwt-2"), token_reply("jwt-3")],
        vec![
            status(403, "Forbidden"),
            status(401, "x"),
            status(403, "Forbidden"),
            rate_limited(),
            status(401, "x"),
            rate_limited(),
        ],
    );
    for expected in [HUB_ERROR_ACCOUNT_DEACTIVATED; 2].into_iter().chain([HUB_ERROR_RATE_LIMITED; 2]) {
        assert_eq!(fetch_me(&s.token).await.unwrap_err(), expected);
    }
    assert!(s.clock.slept.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_failures_of_the_token_request() {
    let s = setup(
        vec![
            status(409, "taken"),
            status(403, "banned"),
            Reply { retry_after: Some("120".to_owned()), ..status(429, "limit") },
            status(401, "bad id token"),
            ok_false("Invalid token"),
            status(404, "gone"),
        ],
        vec![],
    );
    let mut errors = Vec::new();
    for _ in 0..6 {
        let err = s.token.get().await.unwrap_err();
        errors.push((err.message, err.kind));
    }
    assert_eq!(
        errors,
        [
            (HUB_ERROR_DISPLAY_NAME_CONFLICT.to_owned(), None),
            (HUB_ERROR_ACCOUNT_DEACTIVATED.to_owned(), None),
            (HUB_ERROR_RATE_LIMITED.to_owned(), None),
            ("Hub auth failed: 401 bad id token".to_owned(), Some(StatusKind::Unauthorized)),
            ("Hub auth failed: Invalid token".to_owned(), None),
            // The token request has a class of its own for a 404.
            ("Hub auth failed: 404 gone".to_owned(), Some(StatusKind::NotFound)),
        ]
    );
    assert!(!s.token.snapshot().cached);
}

fn ok_false(error: &str) -> Reply {
    status(200, &format!(r#"{{"ok":false,"error":"{error}"}}"#))
}

#[test]
fn the_token_is_read_as_the_template_literal_writes_it() {
    let parse = |text: &str| Some(pipette_js_json::parse(text).unwrap());
    assert_eq!(token_of(parse(r#"{"token":"abc"}"#)).unwrap().as_str(), "abc");
    assert_eq!(token_of(parse(r#"{"token":5}"#)).unwrap().as_str(), "5");
    assert_eq!(token_of(parse("{}")).unwrap().as_str(), "undefined");
    assert_eq!(token_of(parse(r#""text""#)).unwrap().as_str(), "undefined");
    assert_eq!(token_of(None).unwrap_err().message, "Cannot read properties of undefined (reading 'token')");
    assert_eq!(
        token_of(parse("null")).unwrap_err().message,
        "Cannot read properties of null (reading 'token')"
    );
}

#[test]
fn a_hub_failure_keeps_the_class_of_the_hub_error() {
    let err = HubError::Status {
        label: "L",
        status: 409,
        body: "b".to_owned(),
        kind: StatusKind::Conflict,
        retry_after: None,
    };
    let failure = HubFailure::from(err);
    assert_eq!(failure.message, "L: 409 b");
    assert!(failure.is(StatusKind::Conflict));
    assert_eq!(
        HubFailure::from(InvalidInput("Title too long".to_owned())),
        HubFailure::plain("Title too long")
    );
}
