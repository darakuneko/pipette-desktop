// SPDX-License-Identifier: GPL-2.0-or-later
//! Sign-ins and sign-outs that overlap the write of the tokens: what is
//! cached always matches what the file holds, a cancelled sign-in never
//! ends a later one's session, and a write under way finishes.

#![allow(clippy::unwrap_used)]

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{Answer, Harness, tokens};
use pipette_google_auth::{
    AuthConfig, AuthError, AuthTiming, GoogleAuth, StoreTokens, SwitchDirectly, SwitchFuture, TokenSwitch,
};
use serde_json::json;
use tokio::sync::Notify;

/// The access token a new process reads from the file, `None` without one.
async fn token_on_disk(harness: &Harness) -> Option<String> {
    let reader = GoogleAuth::new(
        AuthConfig {
            auth_endpoint: common::AUTH_ENDPOINT.into(),
            token_endpoint: common::TOKEN_ENDPOINT.into(),
            http: harness.endpoint.clone(),
            timing: AuthTiming::default(),
            now_ms: Arc::new(|| common::NOW),
            hub_test_account: Arc::new(|| None),
        },
        harness.secrets.clone(),
    );
    reader.access_token().await.map(|token| token.to_string())
}

async fn token_in_memory(harness: &Harness) -> Option<String> {
    harness.auth.access_token().await.map(|token| token.to_string())
}

/// Holds the store step until released, telling when it is entered.
#[derive(Default)]
struct HeldSwitch {
    entered: Notify,
    release: Notify,
}

impl TokenSwitch for HeldSwitch {
    fn switch<'a>(&'a self, store: StoreTokens<'a>, _sub: Option<String>) -> SwitchFuture<'a> {
        Box::pin(async move {
            self.entered.notify_one();
            self.release.notified().await;
            store.store().await
        })
    }
}

async fn until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("the condition was not reached");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cancelled_sign_in_does_not_end_the_session_of_the_one_that_replaced_it() {
    let harness = Harness::new();
    harness.endpoint.ok(tokens(json!({ "access_token": "a" })));
    harness.endpoint.ok(tokens(json!({ "access_token": "b" })));
    let held = Arc::new(HeldSwitch::default());
    let first = {
        let (auth, held) = (harness.auth.clone(), held.clone());
        tokio::spawn(async move { auth.exchange_code_for_tokens("a", "v", 8080, held.as_ref()).await })
    };
    held.entered.notified().await;
    harness.keystore.block();
    let second = {
        let auth = harness.auth.clone();
        tokio::spawn(async move { auth.exchange_code_for_tokens("b", "v", 8080, &SwitchDirectly).await })
    };
    until(|| harness.keystore.calls() > 0).await;
    held.release.notify_one();
    tokio::time::sleep(Duration::from_millis(20)).await;
    harness.keystore.release();
    second.await.unwrap().unwrap();
    assert!(matches!(first.await.unwrap(), Err(AuthError::SignInChanged)));
    assert_eq!(token_in_memory(&harness).await.as_deref(), Some("b"));
    assert_eq!(token_on_disk(&harness).await.as_deref(), Some("b"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_write_under_way_when_a_later_sign_in_starts_finishes() {
    let harness = Harness::new();
    harness.endpoint.ok(tokens(json!({ "access_token": "a" })));
    harness.endpoint.answer(Answer::Reply(400, json!("denied")));
    harness.keystore.block();
    let first = {
        let auth = harness.auth.clone();
        tokio::spawn(async move { auth.exchange_code_for_tokens("a", "v", 8080, &SwitchDirectly).await })
    };
    until(|| harness.keystore.calls() > 0).await;
    let second = harness.auth.exchange_code_for_tokens("b", "v", 8080, &SwitchDirectly).await;
    assert!(second.is_err());
    harness.keystore.release();
    first.await.unwrap().unwrap();
    assert_eq!(token_in_memory(&harness).await.as_deref(), Some("a"));
    assert_eq!(token_on_disk(&harness).await.as_deref(), Some("a"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_cache_matches_the_file_whatever_the_order_of_a_sign_in_and_a_sign_out() {
    for round in 0..40 {
        let harness = Harness::new();
        harness.endpoint.ok(tokens(json!({ "access_token": format!("t{round}") })));
        let signing_in = {
            let auth = harness.auth.clone();
            tokio::spawn(async move { auth.exchange_code_for_tokens("c", "v", 8080, &SwitchDirectly).await })
        };
        if round % 2 == 0 {
            tokio::task::yield_now().await;
        }
        let signing_out = {
            let auth = harness.auth.clone();
            tokio::spawn(async move { auth.sign_out().await })
        };
        let _ = signing_in.await.unwrap();
        signing_out.await.unwrap();
        assert_eq!(token_in_memory(&harness).await, token_on_disk(&harness).await, "round {round}");
    }
}
