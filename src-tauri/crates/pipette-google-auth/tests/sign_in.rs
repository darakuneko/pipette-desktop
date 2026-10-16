// SPDX-License-Identifier: GPL-2.0-or-later
//! The browser sign-in (`startOAuthFlow` of src/main/sync/google-auth.ts)
//! over a real loopback listener, with the token endpoint scripted. The
//! tests named `differs_from_electron_*` pin the places where the sign-in
//! deliberately does not do what Electron does.

#![allow(clippy::unwrap_used)]

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{AUTH_ENDPOINT, Harness, TestBrowser, callback, param, tokens};
use pipette_google_auth::{
    AuthError, AuthTiming, CLIENT_ID, SCOPE, StoreTokens, SwitchDirectly, SwitchFuture, TokenSwitch,
};
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::task::JoinHandle;

/// Starts a sign-in on `harness` with `browser`.
fn start(harness: &Harness, browser: &Arc<TestBrowser>) -> JoinHandle<Result<(), AuthError>> {
    let auth = harness.auth.clone();
    let browser = browser.clone();
    tokio::spawn(async move { auth.sign_in(browser.as_ref(), &SwitchDirectly).await })
}

fn finished(handle: &JoinHandle<Result<(), AuthError>>) -> bool {
    handle.is_finished()
}

#[tokio::test]
async fn opens_the_authorization_url_and_signs_in_with_the_code() {
    let harness = Harness::new();
    let browser = Arc::new(TestBrowser::default());
    harness.endpoint.ok(tokens(json!({ "access_token": "flow-token" })));
    let flow = start(&harness, &browser);
    let url = browser.url(0).await;

    assert_eq!(
        format!("{}://{}{}", url.scheme(), url.host_str().unwrap(), url.path()),
        "http://127.0.0.1/auth"
    );
    assert!(url.as_str().starts_with(AUTH_ENDPOINT));
    let names: Vec<String> = url.query_pairs().map(|(key, _)| key.into_owned()).collect();
    assert_eq!(
        names,
        [
            "response_type",
            "client_id",
            "redirect_uri",
            "scope",
            "state",
            "code_challenge",
            "code_challenge_method",
            "access_type",
            "prompt"
        ]
    );
    assert_eq!(param(&url, "client_id"), CLIENT_ID);
    assert_eq!(param(&url, "scope"), SCOPE);
    assert_eq!(param(&url, "access_type"), "offline");
    assert_eq!(param(&url, "prompt"), "consent");
    let state = param(&url, "state");
    let challenge = param(&url, "code_challenge");

    assert_eq!(callback(&url, &format!("/?code=test-auth-code&state={state}")).await, Some(200));
    flow.await.unwrap().unwrap();
    assert!(harness.auth.is_authenticated().await);
    assert_eq!(harness.endpoint.field(0, "code").as_deref(), Some("test-auth-code"));
    let verifier = harness.endpoint.field(0, "code_verifier").unwrap();
    assert_eq!(pipette_google_auth::pkce::code_challenge(&verifier), challenge);
    assert_eq!(harness.endpoint.field(0, "redirect_uri"), Some(param(&url, "redirect_uri")));
    // The listener is closed once the code is taken.
    assert_eq!(callback(&url, &format!("/?code=again&state={state}")).await, None);
}

#[tokio::test]
async fn answers_400_to_requests_without_the_state_or_a_code_and_keeps_waiting() {
    let harness = Harness::new();
    let browser = Arc::new(TestBrowser::default());
    harness.endpoint.ok(tokens(json!({})));
    let flow = start(&harness, &browser);
    let url = browser.url(0).await;
    let state = param(&url, "state");
    assert_eq!(callback(&url, "/favicon.ico").await, Some(400));
    assert_eq!(callback(&url, "/?code=x&state=wrong").await, Some(400));
    assert_eq!(callback(&url, &format!("/?state={state}")).await, Some(400));
    assert!(!finished(&flow));
    assert_eq!(callback(&url, &format!("/?code=c&state={state}")).await, Some(200));
    flow.await.unwrap().unwrap();
}

#[tokio::test]
async fn an_error_with_the_state_fails_the_sign_in() {
    let harness = Harness::new();
    let browser = Arc::new(TestBrowser::default());
    let flow = start(&harness, &browser);
    let url = browser.url(0).await;
    let state = param(&url, "state");
    assert_eq!(callback(&url, &format!("/?error=access_denied&state={state}")).await, Some(200));
    let err = flow.await.unwrap().unwrap_err();
    assert_eq!(err.to_string(), "OAuth error: access_denied");
    assert!(harness.endpoint.forms().is_empty());
}

#[tokio::test]
async fn differs_from_electron_an_error_without_the_state_is_refused() {
    let harness = Harness::new();
    let browser = Arc::new(TestBrowser::default());
    harness.endpoint.ok(tokens(json!({})));
    let flow = start(&harness, &browser);
    let url = browser.url(0).await;
    assert_eq!(callback(&url, "/?error=access_denied").await, Some(400));
    assert!(!finished(&flow));
    assert_eq!(callback(&url, &format!("/?code=c&state={}", param(&url, "state"))).await, Some(200));
    flow.await.unwrap().unwrap();
}

#[tokio::test]
async fn times_out_without_the_browser_coming_back() {
    let timing = AuthTiming { authorization: Duration::from_millis(100), ..AuthTiming::default() };
    let harness = Harness::with_timing(timing);
    let browser = Arc::new(TestBrowser::default());
    let flow = start(&harness, &browser);
    let url = browser.url(0).await;
    let err = flow.await.unwrap().unwrap_err();
    assert_eq!(err.to_string(), "OAuth flow timed out");
    assert_eq!(callback(&url, &format!("/?code=late&state={}", param(&url, "state"))).await, None);
}

/// Holds the store step until told to go on.
struct SlowSwitch(tokio::sync::Notify);

impl TokenSwitch for SlowSwitch {
    fn switch<'a>(&'a self, store: StoreTokens<'a>, _sub: Option<String>) -> SwitchFuture<'a> {
        Box::pin(async move {
            self.0.notified().await;
            store.store().await
        })
    }
}

#[tokio::test]
async fn the_authorization_time_limit_stops_once_the_code_arrives() {
    let timing = AuthTiming { authorization: Duration::from_millis(200), ..AuthTiming::default() };
    let harness = Harness::with_timing(timing);
    let browser = Arc::new(TestBrowser::default());
    harness.endpoint.ok(tokens(json!({})));
    let switch = Arc::new(SlowSwitch(tokio::sync::Notify::new()));
    let flow = {
        let auth = harness.auth.clone();
        let browser = browser.clone();
        let switch = switch.clone();
        tokio::spawn(async move { auth.sign_in(browser.as_ref(), switch.as_ref()).await })
    };
    let url = browser.url(0).await;
    assert_eq!(callback(&url, &format!("/?code=c&state={}", param(&url, "state"))).await, Some(200));
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(!finished(&flow));
    switch.0.notify_one();
    flow.await.unwrap().unwrap();
    assert!(harness.auth.is_authenticated().await);
}

#[tokio::test]
async fn a_silent_or_oversized_connection_does_not_block_the_redirect() {
    let timing = AuthTiming { connection: Duration::from_millis(200), ..AuthTiming::default() };
    let harness = Harness::with_timing(timing);
    let browser = Arc::new(TestBrowser::default());
    harness.endpoint.ok(tokens(json!({})));
    let flow = start(&harness, &browser);
    let url = browser.url(0).await;
    let port = url::Url::parse(&param(&url, "redirect_uri")).unwrap().port().unwrap();
    let _silent = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut huge = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let state = param(&url, "state");
    let oversized = format!("GET /?code=c&state={state} HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(9000));
    // The listener stops reading past the limit, so the write may fail.
    let _ = huge.write_all(oversized.as_bytes()).await;
    assert_eq!(callback(&url, &format!("/?code=c&state={state}")).await, Some(200));
    flow.await.unwrap().unwrap();
}

#[tokio::test]
async fn differs_from_electron_a_sign_out_cancels_the_wait_for_the_browser() {
    let harness = Harness::new();
    let browser = Arc::new(TestBrowser::default());
    let flow = start(&harness, &browser);
    let url = browser.url(0).await;
    harness.auth.sign_out().await;
    assert!(matches!(flow.await.unwrap(), Err(AuthError::SignInChanged)));
    assert_eq!(callback(&url, &format!("/?code=c&state={}", param(&url, "state"))).await, None);
}

#[tokio::test]
async fn differs_from_electron_a_sign_out_during_the_exchange_keeps_the_account_signed_out() {
    let harness = Harness::new();
    let browser = Arc::new(TestBrowser::default());
    let respond = harness.endpoint.later();
    let flow = start(&harness, &browser);
    let url = browser.url(0).await;
    assert_eq!(callback(&url, &format!("/?code=c&state={}", param(&url, "state"))).await, Some(200));
    while harness.endpoint.forms().is_empty() {
        tokio::task::yield_now().await;
    }
    harness.auth.sign_out().await;
    let _ = respond.send((200, tokens(json!({}))));
    assert!(matches!(flow.await.unwrap(), Err(AuthError::SignInChanged)));
    assert!(!harness.auth.is_authenticated().await);
}

#[tokio::test]
async fn differs_from_electron_a_later_sign_in_replaces_an_earlier_one() {
    let harness = Harness::new();
    let browser = Arc::new(TestBrowser::default());
    harness.endpoint.ok(tokens(json!({ "access_token": "second" })));
    let first = start(&harness, &browser);
    let first_url = browser.url(0).await;
    let second = start(&harness, &browser);
    let second_url = browser.url(1).await;
    assert!(matches!(first.await.unwrap(), Err(AuthError::SignInChanged)));
    assert_eq!(callback(&first_url, &format!("/?code=c&state={}", param(&first_url, "state"))).await, None);
    assert_eq!(
        callback(&second_url, &format!("/?code=c&state={}", param(&second_url, "state"))).await,
        Some(200)
    );
    second.await.unwrap().unwrap();
    assert_eq!(harness.auth.access_token().await.as_deref().map(String::as_str), Some("second"));
}

/// A browser that cannot be opened.
struct NoBrowser;

impl pipette_google_auth::BrowserOpener for NoBrowser {
    fn open(&self, _url: &str) -> Result<(), String> {
        Err("no browser".to_owned())
    }
}

#[tokio::test]
async fn a_browser_that_does_not_open_fails_the_sign_in() {
    let harness = Harness::new();
    let err = harness.auth.sign_in(&NoBrowser, &SwitchDirectly).await.unwrap_err();
    assert_eq!(err.to_string(), "no browser");
}
