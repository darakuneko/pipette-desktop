// SPDX-License-Identifier: GPL-2.0-or-later
//! The requests to the token endpoint (src/main/sync/google-auth.ts): the
//! code exchange of a sign-in and the refresh, each a form POST bounded by
//! a time limit.

use std::time::Duration;

use pipette_net::{HttpRequest, HttpRequester, Method};
use serde::Deserialize;
use zeroize::{Zeroize, Zeroizing};

use crate::pkce::redirect_uri;
use crate::{AuthError, CLIENT_ID, CLIENT_SECRET};

/// What the token endpoint answers; the fields the sync reads.
#[derive(Deserialize)]
pub(crate) struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Seconds. Without it the tokens count as expired at once (Electron
    /// stores `NaN`, which refreshes on every use).
    #[serde(default)]
    pub expires_in: Option<f64>,
    #[serde(default)]
    pub id_token: Option<String>,
}

impl Drop for TokenResponse {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
        self.id_token.zeroize();
    }
}

impl TokenResponse {
    /// When the access token expires, for a response received at `now_ms`.
    pub(crate) fn expires_at(&self, now_ms: i64) -> i64 {
        match self.expires_in {
            Some(seconds) if seconds.is_finite() => now_ms.saturating_add((seconds * 1000.0) as i64),
            _ => 0,
        }
    }
}

/// The form of the code exchange.
pub(crate) fn exchange_form(code: &str, code_verifier: &str, port: u16) -> Zeroizing<String> {
    Zeroizing::new(
        form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "authorization_code")
            .append_pair("code", code)
            .append_pair("redirect_uri", &redirect_uri(port))
            .append_pair("client_id", CLIENT_ID)
            .append_pair("client_secret", CLIENT_SECRET)
            .append_pair("code_verifier", code_verifier)
            .finish(),
    )
}

/// The form of a refresh.
pub(crate) fn refresh_form(refresh_token: &str) -> Zeroizing<String> {
    Zeroizing::new(
        form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "refresh_token")
            .append_pair("refresh_token", refresh_token)
            .append_pair("client_id", CLIENT_ID)
            .append_pair("client_secret", CLIENT_SECRET)
            .finish(),
    )
}

/// POSTs `form` to `endpoint`; `label` names the request in the error of a
/// response that is not 2xx (`Token exchange failed: <status> <body>`).
pub(crate) async fn post_form(
    http: &dyn HttpRequester,
    endpoint: &str,
    form: Zeroizing<String>,
    label: &'static str,
    timeout: Duration,
) -> Result<TokenResponse, AuthError> {
    let request = HttpRequest {
        method: Method::Post,
        url: endpoint.to_owned(),
        headers: vec![("Content-Type".to_owned(), "application/x-www-form-urlencoded".to_owned())],
        body: Some(form.as_bytes().to_vec()),
    };
    let reply = match tokio::time::timeout(timeout, http.request(request)).await {
        Ok(Ok(reply)) => reply,
        Ok(Err(err)) => return Err(AuthError::Network(err.to_string())),
        Err(_) => return Err(AuthError::Network("the request timed out".to_owned())),
    };
    let mut body = Zeroizing::new(reply.body);
    if !(200..300).contains(&reply.status) {
        let text = String::from_utf8_lossy(&body).into_owned();
        return Err(AuthError::TokenEndpoint { label, status: reply.status, body: text });
    }
    let parsed =
        serde_json::from_slice(&body).map_err(|err| AuthError::Other(format!("{label} failed: {err}")));
    body.zeroize();
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_or_bad_lifetime_expires_at_once() {
        let response = |expires_in| TokenResponse {
            access_token: "a".into(),
            refresh_token: None,
            expires_in,
            id_token: None,
        };
        assert_eq!(response(Some(3600.0)).expires_at(1_000), 3_601_000);
        assert_eq!(response(Some(-1.0)).expires_at(1_000), 0);
        assert_eq!(response(None).expires_at(1_000), 0);
        assert_eq!(response(Some(f64::NAN)).expires_at(1_000), 0);
    }
}
