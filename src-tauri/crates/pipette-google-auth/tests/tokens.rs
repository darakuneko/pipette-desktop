// SPDX-License-Identifier: GPL-2.0-or-later
//! The token tests of src/main/__tests__/google-auth.test.ts: the code
//! exchange, the status, the sign-out, the refresh, the id_token and the
//! `sub`, the races with a sign-out, the time limits and the Hub test
//! account.

#![allow(clippy::unwrap_used)]

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{Answer, Harness, NOW, jwt, tokens};
use pipette_google_auth::{AuthError, AuthTiming, StoreTokens, SwitchDirectly, SwitchFuture, TokenSwitch};
use serde_json::json;

const MINUTE: i64 = 60 * 1000;

#[tokio::test]
async fn exchanges_the_code_for_tokens_and_stores_them() {
    let harness = Harness::new();
    harness.sign_in_with(tokens(json!({ "access_token": "test-access-token" }))).await;

    assert!(harness.auth.is_authenticated().await);
    assert_eq!(harness.auth.access_token().await.as_deref().map(String::as_str), Some("test-access-token"));
    assert!(harness.token_file().is_file());
    let form = harness.endpoint.forms()[0].clone();
    let names: Vec<&str> = form.iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(names, ["grant_type", "code", "redirect_uri", "client_id", "client_secret", "code_verifier"]);
    assert_eq!(harness.endpoint.field(0, "grant_type").as_deref(), Some("authorization_code"));
    assert_eq!(harness.endpoint.field(0, "redirect_uri").as_deref(), Some("http://127.0.0.1:8080"));
    assert_eq!(harness.endpoint.field(0, "code_verifier").as_deref(), Some("verifier"));
}

#[tokio::test]
async fn keeps_the_tokens_for_the_next_process() {
    let harness = Harness::new();
    harness
        .sign_in_with(tokens(json!({ "access_token": "kept", "id_token": jwt(json!({ "sub": "s" })) })))
        .await;
    let config = pipette_google_auth::AuthConfig {
        auth_endpoint: common::AUTH_ENDPOINT.into(),
        token_endpoint: common::TOKEN_ENDPOINT.into(),
        http: harness.endpoint.clone(),
        timing: AuthTiming::default(),
        now_ms: Arc::new(|| NOW),
        hub_test_account: Arc::new(|| None),
    };
    let next = pipette_google_auth::GoogleAuth::new(config, harness.secrets.clone());
    assert_eq!(next.access_token().await.as_deref().map(String::as_str), Some("kept"));
    assert_eq!(next.account_sub().await.as_deref(), Some("s"));
}

#[tokio::test]
async fn a_failed_exchange_stores_nothing() {
    let harness = Harness::new();
    harness.endpoint.answer(Answer::Reply(400, json!("bad request")));
    let err =
        harness.auth.exchange_code_for_tokens("bad-code", "v", 8080, &SwitchDirectly).await.unwrap_err();
    assert_eq!(err.to_string(), "Token exchange failed: 400 bad request");
    assert!(!harness.auth.is_authenticated().await);
}

#[tokio::test]
async fn is_signed_out_without_tokens() {
    let harness = Harness::new();
    assert!(!harness.auth.is_authenticated().await);
    assert!(harness.auth.access_token().await.is_none());
    assert!(harness.auth.id_token().await.is_none());
    assert!(harness.auth.account_sub().await.is_none());
    // A missing token file needs no key store call.
    assert_eq!(harness.keystore.calls(), 0);
}

#[tokio::test]
async fn sign_out_removes_the_tokens() {
    let harness = Harness::new();
    harness.sign_in_with(tokens(json!({}))).await;
    harness.auth.sign_out().await;
    assert!(!harness.auth.is_authenticated().await);
    assert!(!harness.token_file().exists());
    // Signing out twice is no error.
    harness.auth.sign_out().await;
}

#[tokio::test]
async fn refreshes_an_access_token_that_expires_within_five_minutes() {
    let harness = Harness::new();
    harness
        .sign_in_with(tokens(json!({ "access_token": "initial", "refresh_token": "refresh-token" })))
        .await;
    harness.advance(55 * MINUTE - 1);
    assert_eq!(harness.auth.access_token().await.as_deref().map(String::as_str), Some("initial"));
    harness.advance(1);
    harness.endpoint.ok(json!({ "access_token": "refreshed", "expires_in": 3600 }));
    assert_eq!(harness.auth.access_token().await.as_deref().map(String::as_str), Some("refreshed"));
    let names: Vec<String> = harness.endpoint.forms()[1].iter().map(|(key, _)| key.clone()).collect();
    assert_eq!(names, ["grant_type", "refresh_token", "client_id", "client_secret"]);
    assert_eq!(harness.endpoint.field(1, "grant_type").as_deref(), Some("refresh_token"));
    assert_eq!(harness.endpoint.field(1, "refresh_token").as_deref(), Some("refresh-token"));
    // The refreshed token is stored with its new lifetime.
    assert_eq!(harness.auth.access_token().await.as_deref().map(String::as_str), Some("refreshed"));
}

#[tokio::test]
async fn a_failed_refresh_gives_no_access_token_and_keeps_the_sign_in() {
    let harness = Harness::new();
    harness.sign_in_with(tokens(json!({ "expires_in": -1 }))).await;
    harness.endpoint.answer(Answer::Reply(401, json!({ "error": "invalid_grant" })));
    assert!(harness.auth.access_token().await.is_none());
    assert!(harness.auth.is_authenticated().await);
}

#[tokio::test]
async fn an_expired_access_token_without_a_refresh_token_is_none_and_sends_no_refresh() {
    let harness = Harness::new();
    harness.endpoint.ok(json!({ "access_token": "a", "expires_in": -1 }));
    harness.auth.exchange_code_for_tokens("code", "v", 8080, &SwitchDirectly).await.unwrap();
    assert!(harness.auth.is_authenticated().await);
    assert!(harness.auth.access_token().await.is_none());
    assert_eq!(harness.endpoint.forms().len(), 1);
}

mod id_token {
    use super::*;

    fn now_secs() -> i64 {
        NOW / 1000
    }

    #[tokio::test]
    async fn is_none_without_one_and_without_a_refresh_that_brings_one() {
        let harness = Harness::new();
        harness.sign_in_with(tokens(json!({}))).await;
        harness.endpoint.ok(json!({ "access_token": "b", "expires_in": 3600 }));
        assert!(harness.auth.id_token().await.is_none());
    }

    #[tokio::test]
    async fn is_none_without_exp_or_when_expired() {
        for claims in
            [json!({ "iat": now_secs() }), json!({ "iat": now_secs() - 100, "exp": now_secs() - 1 })]
        {
            let harness = Harness::new();
            harness.sign_in_with(tokens(json!({ "id_token": jwt(claims) }))).await;
            harness.endpoint.ok(json!({ "access_token": "b", "expires_in": 3600 }));
            assert!(harness.auth.id_token().await.is_none());
        }
    }

    #[tokio::test]
    async fn is_the_stored_one_while_fresh() {
        let harness = Harness::new();
        let token = jwt(json!({ "iat": now_secs(), "exp": now_secs() + 3600 }));
        harness.sign_in_with(tokens(json!({ "id_token": token }))).await;
        assert_eq!(harness.auth.id_token().await.as_deref(), Some(&token));
        assert_eq!(harness.endpoint.forms().len(), 1);
    }

    #[tokio::test]
    async fn is_refreshed_once_older_than_five_minutes() {
        let harness = Harness::new();
        let stale = jwt(json!({ "iat": now_secs() - 301, "exp": now_secs() + 3600 }));
        harness.sign_in_with(tokens(json!({ "id_token": stale }))).await;
        // The refresh brings none: the stale one is kept and not returned.
        harness.endpoint.ok(json!({ "access_token": "b", "expires_in": 3600 }));
        assert!(harness.auth.id_token().await.is_none());
        let fresh = jwt(json!({ "iat": now_secs(), "exp": now_secs() + 3600 }));
        harness.endpoint.ok(json!({ "access_token": "c", "expires_in": 3600, "id_token": fresh }));
        assert_eq!(harness.auth.id_token().await.as_deref(), Some(&fresh));
    }

    #[tokio::test]
    async fn is_none_without_a_refresh_token() {
        let harness = Harness::new();
        harness.endpoint.ok(json!({ "access_token": "a", "expires_in": 3600 }));
        harness.auth.exchange_code_for_tokens("code", "v", 8080, &SwitchDirectly).await.unwrap();
        assert!(harness.auth.id_token().await.is_none());
        assert_eq!(harness.endpoint.forms().len(), 1);
    }
}

mod account_sub {
    use super::*;

    #[tokio::test]
    async fn is_the_sub_of_the_id_token_received_at_sign_in() {
        let harness = Harness::new();
        harness.sign_in_with(tokens(json!({ "id_token": jwt(json!({ "sub": "account-a" })) }))).await;
        assert_eq!(harness.auth.account_sub().await.as_deref(), Some("account-a"));
    }

    #[tokio::test]
    async fn is_none_when_the_sign_in_returned_no_id_token() {
        let harness = Harness::new();
        harness.sign_in_with(tokens(json!({}))).await;
        assert_eq!(harness.auth.account_sub().await, None);
    }

    #[tokio::test]
    async fn is_kept_across_a_refresh_that_returns_no_id_token() {
        let harness = Harness::new();
        harness
            .sign_in_with(tokens(json!({ "id_token": jwt(json!({ "sub": "account-a" })), "expires_in": -1 })))
            .await;
        harness.endpoint.ok(json!({ "access_token": "refreshed", "expires_in": 3600 }));
        assert_eq!(harness.auth.access_token().await.as_deref().map(String::as_str), Some("refreshed"));
        assert_eq!(harness.auth.account_sub().await.as_deref(), Some("account-a"));
    }
}

mod races {
    use super::*;

    /// Signs in with expired tokens and starts a refresh whose answer waits.
    async fn slow_refresh(
        harness: &Harness,
    ) -> (tokio::sync::oneshot::Sender<(u16, serde_json::Value)>, tokio::task::JoinHandle<Option<String>>)
    {
        harness
            .sign_in_with(tokens(
                json!({ "access_token": "old", "refresh_token": "old-refresh", "expires_in": -1 }),
            ))
            .await;
        let respond = harness.endpoint.later();
        let auth = harness.auth.clone();
        let refreshed = tokio::spawn(async move { auth.access_token().await.map(|token| token.to_string()) });
        while harness.endpoint.forms().len() < 2 {
            tokio::task::yield_now().await;
        }
        (respond, refreshed)
    }

    #[tokio::test]
    async fn a_refresh_that_finishes_after_a_sign_out_does_not_sign_back_in() {
        let harness = Harness::new();
        let (respond, refreshed) = slow_refresh(&harness).await;
        harness.auth.sign_out().await;
        respond.send((200, json!({ "access_token": "refreshed-old", "expires_in": 3600 }))).unwrap();
        assert_eq!(refreshed.await.unwrap(), None);
        assert!(!harness.auth.is_authenticated().await);
    }

    #[tokio::test]
    async fn a_refresh_that_finishes_after_a_new_sign_in_does_not_replace_its_tokens() {
        let harness = Harness::new();
        let (respond, refreshed) = slow_refresh(&harness).await;
        harness.sign_in_with(tokens(json!({ "access_token": "new-account" }))).await;
        respond.send((200, json!({ "access_token": "refreshed-old", "expires_in": 3600 }))).unwrap();
        assert_eq!(refreshed.await.unwrap(), None);
        assert_eq!(harness.auth.access_token().await.as_deref().map(String::as_str), Some("new-account"));
    }

    #[tokio::test]
    async fn tokens_whose_write_is_under_way_at_a_sign_out_are_not_kept() {
        let harness = Harness::new();
        harness.keystore.block();
        harness.endpoint.ok(tokens(json!({})));
        let auth = harness.auth.clone();
        let signing_in =
            tokio::spawn(
                async move { auth.exchange_code_for_tokens("code", "v", 8080, &SwitchDirectly).await },
            );
        while harness.keystore.calls() == 0 {
            tokio::task::yield_now().await;
        }
        let auth = harness.auth.clone();
        let signing_out = tokio::spawn(async move { auth.sign_out().await });
        let auth = harness.auth.clone();
        let status = tokio::spawn(async move { auth.is_authenticated().await });
        tokio::task::yield_now().await;
        harness.keystore.release();
        assert!(matches!(signing_in.await.unwrap(), Err(AuthError::SignInChanged)));
        signing_out.await.unwrap();
        assert!(!status.await.unwrap(), "a read queued behind the sign-out sees no tokens");
        assert!(!harness.auth.is_authenticated().await);
        assert!(!harness.token_file().exists());
    }
}

mod time_limits {
    use super::*;

    fn short() -> AuthTiming {
        AuthTiming { token_request: Duration::from_millis(50), ..AuthTiming::default() }
    }

    #[tokio::test]
    async fn a_stalled_exchange_fails_at_the_time_limit() {
        let harness = Harness::with_timing(short());
        harness.endpoint.answer(Answer::Hang);
        let err =
            harness.auth.exchange_code_for_tokens("code", "v", 8080, &SwitchDirectly).await.unwrap_err();
        assert_eq!(err.to_string(), "the request timed out");
        assert!(!harness.auth.is_authenticated().await);
    }

    #[tokio::test]
    async fn a_stalled_refresh_gives_no_access_token() {
        let harness = Harness::with_timing(short());
        harness.sign_in_with(tokens(json!({ "expires_in": -1 }))).await;
        harness.endpoint.answer(Answer::Hang);
        assert!(harness.auth.access_token().await.is_none());
        assert!(harness.auth.is_authenticated().await);
    }
}

/// Records the `sub` it is given and refuses.
struct Refusing(Mutex<Option<Option<String>>>);

impl TokenSwitch for Refusing {
    fn switch<'a>(&'a self, _store: StoreTokens<'a>, new_account_sub: Option<String>) -> SwitchFuture<'a> {
        *self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(new_account_sub);
        Box::pin(async { Err(AuthError::Switch("busy".into())) })
    }
}

#[tokio::test]
async fn the_switch_gets_the_new_sub_and_stores_nothing_when_it_refuses() {
    let harness = Harness::new();
    harness.endpoint.ok(tokens(json!({ "id_token": jwt(json!({ "sub": "account-b" })) })));
    let switch = Refusing(Mutex::new(None));
    let err = harness.auth.exchange_code_for_tokens("code", "v", 8080, &switch).await.unwrap_err();
    assert_eq!(err.to_string(), "busy");
    assert_eq!(*switch.0.lock().unwrap(), Some(Some("account-b".to_owned())));
    assert!(!harness.auth.is_authenticated().await);
}

#[tokio::test]
async fn account_listeners_hear_each_sign_in_and_sign_out() {
    let harness = Harness::new();
    let heard = Arc::new(Mutex::new(0));
    let counter = heard.clone();
    harness.auth.on_account_changed(move || *counter.lock().unwrap() += 1);
    harness.sign_in_with(tokens(json!({}))).await;
    harness.auth.sign_out().await;
    assert_eq!(*heard.lock().unwrap(), 2);
}

#[tokio::test]
async fn a_key_store_that_is_unavailable_refuses_to_store_the_tokens() {
    let harness = Harness::new();
    harness.keystore.set_unavailable(true);
    harness.endpoint.ok(tokens(json!({})));
    let err = harness.auth.exchange_code_for_tokens("code", "v", 8080, &SwitchDirectly).await.unwrap_err();
    assert_eq!(err.to_string(), "OS keychain encryption is not available");
    assert!(!harness.token_file().exists());
}

mod hub_test_account {
    use super::*;

    #[tokio::test]
    async fn the_id_token_is_the_sentinel_and_nothing_is_requested() {
        let harness = Harness::new();
        harness.set_hub_account(Some("tester@example.com"));
        assert_eq!(
            harness.auth.id_token().await.as_deref().map(String::as_str),
            Some("test:tester@example.com")
        );
        assert!(harness.endpoint.forms().is_empty());
    }

    #[tokio::test]
    async fn the_status_is_signed_in_but_there_is_no_drive_sign_in() {
        let harness = Harness::new();
        harness.set_hub_account(Some("tester@example.com"));
        assert!(harness.auth.is_authenticated().await);
        assert_eq!(harness.auth.account_sub().await, None);
        assert!(harness.auth.access_token().await.is_none());
    }
}
