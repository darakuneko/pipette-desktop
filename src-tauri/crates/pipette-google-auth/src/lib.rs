// SPDX-License-Identifier: GPL-2.0-or-later
//! The Google sign-in of the sync: the loopback OAuth flow with PKCE
//! ([`pkce`], [`loopback`]), the tokens and their refresh ([`GoogleAuth`]).
//! The tokens are kept by the secret store (pipette-secret-store), never in
//! the WebView.
//!
//! A sign-out does not revoke the tokens, and the granted scopes are not
//! checked.

use std::future::Future;
use std::pin::Pin;

mod auth;
pub mod jwt;
pub mod loopback;
pub mod pkce;
mod token_endpoint;
mod tokens;

pub use auth::{AuthConfig, AuthTiming, GoogleAuth};
pub use tokens::StoredTokens;

/// The OAuth client id: the desktop app client.
pub const CLIENT_ID: &str = "456971912849-ktrhpfv849jli5qph50i2rlflv1aadqq.apps.googleusercontent.com";
/// The OAuth client secret. A desktop app client's
/// secret is not confidential; PKCE protects the code.
pub const CLIENT_SECRET: &str = "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";
/// The OAuth scopes the sign-in asks for.
pub const SCOPE: &str = "https://www.googleapis.com/auth/drive.appdata openid email profile";

/// The variable of the Hub test account (`getHubTestAccount`).
pub const HUB_TEST_ACCOUNT_ENV: &str = "PIPETTE_HUB_TEST_ACCOUNT";

/// Why a sign-in, a refresh or a token write failed.
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    /// A sign-out or a later sign-in replaced the sign-in, or a write found
    /// the session changed.
    #[error("The sign-in changed; the tokens were not stored")]
    SignInChanged,
    #[error("OS keychain encryption is not available")]
    KeystoreUnavailable,
    /// The browser came back with an `error`.
    #[error("OAuth error: {0}")]
    OAuth(String),
    /// The browser did not come back within the authorization time limit.
    #[error("OAuth flow timed out")]
    TimedOut,
    /// The browser could not be opened.
    #[error("{0}")]
    Browser(String),
    /// The token endpoint answered with a status that is not 2xx.
    #[error("{label} failed: {status} {body}")]
    TokenEndpoint { label: &'static str, status: u16, body: String },
    /// The token request got no answer (the network, the time limit).
    #[error("{0}")]
    Network(String),
    /// A [`TokenSwitch`] refused the new tokens; its own error.
    #[error("{0}")]
    Switch(Box<dyn std::error::Error + Send + Sync>),
    #[error("{0}")]
    Other(String),
}

/// Opens the authorization URL in the user's browser.
pub trait BrowserOpener: Send + Sync {
    fn open(&self, url: &str) -> Result<(), String>;
}

/// The store step of a sign-in, handed to a [`TokenSwitch`]: storing
/// replaces the signed-in account's tokens with the new ones.
pub struct StoreTokens<'a> {
    auth: &'a GoogleAuth,
    tokens: StoredTokens,
    attempt: u64,
}

impl StoreTokens<'_> {
    /// Stores the tokens: a new session, then the write, unless the sign-in
    /// was replaced or cancelled meanwhile (then
    /// [`AuthError::SignInChanged`]).
    pub async fn store(self) -> Result<(), AuthError> {
        self.auth.store_sign_in(self.tokens, self.attempt).await
    }
}

pub type SwitchFuture<'a> = Pin<Box<dyn Future<Output = Result<(), AuthError>> + Send + 'a>>;

/// Runs the store step of a sign-in (`TokenSwitch`) with the `sub` of the
/// new account (`None` when its id_token has none): around steps of its
/// own (e.g. holding the sync lock), or not at all by failing.
pub trait TokenSwitch: Send + Sync {
    fn switch<'a>(&'a self, store: StoreTokens<'a>, new_account_sub: Option<String>) -> SwitchFuture<'a>;
}

/// Stores the tokens and nothing else (`switchDirectly`).
pub struct SwitchDirectly;

impl TokenSwitch for SwitchDirectly {
    fn switch<'a>(&'a self, store: StoreTokens<'a>, _new_account_sub: Option<String>) -> SwitchFuture<'a> {
        Box::pin(store.store())
    }
}

/// The Hub test account: `account` (the value of [`HUB_TEST_ACCOUNT_ENV`])
/// when it is not empty and the Hub API base `hub_api_base` is on localhost
/// or 127.0.0.1.
pub fn hub_test_account(account: Option<String>, hub_api_base: &str) -> Option<String> {
    let account = account.filter(|account| !account.is_empty())?;
    let host = url::Url::parse(hub_api_base).ok()?.host_str()?.to_owned();
    (host == "localhost" || host == "127.0.0.1").then_some(account)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hub_test_account_needs_a_local_hub() {
        let account = || Some("tester@example.com".to_owned());
        assert_eq!(hub_test_account(account(), "http://localhost:8787"), account());
        assert_eq!(hub_test_account(account(), "http://127.0.0.1:8787/"), account());
        assert_eq!(hub_test_account(account(), "https://pipette-hub-worker.keymaps.workers.dev"), None);
        assert_eq!(hub_test_account(account(), "not a url"), None);
        assert_eq!(hub_test_account(Some(String::new()), "http://localhost:8787"), None);
        assert_eq!(hub_test_account(None, "http://localhost:8787"), None);
    }
}

/// The requests and the stored token JSON against the recorded golden
/// (tests/fixtures/ts_auth.json).
#[cfg(test)]
mod golden {
    use serde_json::Value;

    use crate::pkce::{auth_url, code_challenge};
    use crate::token_endpoint::{exchange_form, refresh_form};
    use crate::tokens::StoredTokens;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/ts_auth.json")).unwrap()
    }

    fn text(value: &Value) -> &str {
        value.as_str().unwrap()
    }

    #[test]
    fn builds_the_recorded_authorization_urls() {
        let fixture = fixture();
        for recorded in fixture["authUrls"].as_array().unwrap() {
            let port = u16::try_from(recorded["port"].as_u64().unwrap()).unwrap();
            let challenge = code_challenge(text(&recorded["codeVerifier"]));
            assert_eq!(
                auth_url(pipette_net::GOOGLE_AUTH_ENDPOINT, port, &challenge, text(&recorded["state"])),
                text(&recorded["url"])
            );
        }
    }

    #[test]
    fn sends_the_recorded_token_requests() {
        let fixture = fixture();
        let exchange = &fixture["exchange"];
        let port = u16::try_from(exchange["port"].as_u64().unwrap()).unwrap();
        let form = exchange_form(text(&exchange["code"]), text(&exchange["codeVerifier"]), port);
        assert_eq!(form.as_str(), text(&exchange["request"]["body"]));
        let refresh = &fixture["refresh"];
        assert_eq!(refresh_form(text(&refresh["refreshToken"])).as_str(), text(&refresh["request"]["body"]));
        for request in [&exchange["request"], &refresh["request"]] {
            assert_eq!(text(&request["method"]), "POST");
            assert_eq!(text(&request["url"]), pipette_net::GOOGLE_TOKEN_ENDPOINT);
            assert_eq!(
                request["headers"],
                serde_json::json!({ "Content-Type": "application/x-www-form-urlencoded" })
            );
        }
    }

    /// The golden was recorded with the clock fixed at the time it holds as
    /// `now`, so `expiresAt` is `now` plus `expires_in`.
    #[test]
    fn stores_the_recorded_token_json() {
        let fixture = fixture();
        for name in ["storedAfterExchange", "storedWithoutRefreshToken"] {
            let stored = text(&fixture[name]);
            let tokens: StoredTokens = serde_json::from_str(stored).unwrap();
            assert_eq!(tokens.expires_at, fixture["now"].as_i64().unwrap() + 3599 * 1000, "{name}");
            assert_eq!(serde_json::to_string(&tokens).unwrap(), stored, "{name}");
        }
        let without: StoredTokens =
            serde_json::from_str(text(&fixture["storedWithoutRefreshToken"])).unwrap();
        assert_eq!(without.refresh_token, None);
        assert!(!text(&fixture["storedWithoutRefreshToken"]).contains("refreshToken"));
    }
}
