// SPDX-License-Identifier: GPL-2.0-or-later
//! The claims the sync reads from an id_token, unverified: the token comes
//! straight from Google's token endpoint over TLS, and only its `sub`,
//! `exp` and `iat` are read.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Map, Value};

/// How old an id_token may be for the Hub (`ID_TOKEN_MAX_AGE`), in
/// seconds; the Hub allows 10 minutes.
pub const ID_TOKEN_MAX_AGE_SECS: f64 = 300.0;

/// The payload of `jwt` (`parseJwtPayload`): its second segment as base64url
/// JSON, `None` when it is not an object.
pub fn payload(jwt: &str) -> Option<Map<String, Value>> {
    let segment = jwt.split('.').nth(1)?;
    // Node's base64url decoder takes padding too.
    let bytes = URL_SAFE_NO_PAD.decode(segment.trim_end_matches('=')).ok()?;
    match serde_json::from_slice(&bytes).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// The `sub` of `id_token` (`accountSubOf`); `None` when there is no
/// non-empty string `sub`.
pub fn account_sub(id_token: Option<&str>) -> Option<String> {
    let id_token = id_token.filter(|token| !token.is_empty())?;
    match payload(id_token)?.get("sub")? {
        Value::String(sub) if !sub.is_empty() => Some(sub.clone()),
        _ => None,
    }
}

/// Whether `jwt` is expired at `now_ms` (`isJwtExpired`): also when it has
/// no numeric `exp`.
pub fn is_expired(jwt: &str, now_ms: i64) -> bool {
    match payload(jwt).and_then(|claims| claims.get("exp").and_then(Value::as_f64)) {
        Some(exp) => now_ms as f64 >= exp * 1000.0,
        None => true,
    }
}

/// Whether `jwt` was issued more than `max_age_secs` before `now_ms`
/// (`isJwtStale`): also when it has no numeric `iat`.
pub fn is_stale(jwt: &str, max_age_secs: f64, now_ms: i64) -> bool {
    match payload(jwt).and_then(|claims| claims.get("iat").and_then(Value::as_f64)) {
        Some(iat) => now_ms as f64 / 1000.0 - iat > max_age_secs,
        None => true,
    }
}

#[cfg(test)]
pub(crate) fn jwt_with(payload: &Value) -> String {
    format!("header.{}.sig", URL_SAFE_NO_PAD.encode(payload.to_string()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_the_sub() {
        assert_eq!(account_sub(Some(&jwt_with(&json!({ "sub": "account-a" })))), Some("account-a".into()));
        assert_eq!(account_sub(Some(&jwt_with(&json!({ "sub": "" })))), None);
        assert_eq!(account_sub(Some(&jwt_with(&json!({ "sub": 5 })))), None);
        assert_eq!(account_sub(Some(&jwt_with(&json!({})))), None);
        assert_eq!(account_sub(Some("not-a-jwt")), None);
        assert_eq!(account_sub(Some("")), None);
        assert_eq!(account_sub(None), None);
        let padded = format!("h.{}==.s", URL_SAFE_NO_PAD.encode(json!({ "sub": "p" }).to_string()));
        assert_eq!(account_sub(Some(&padded)), Some("p".into()));
    }

    #[test]
    fn expiry_and_age_follow_the_numeric_claims() {
        let token = jwt_with(&json!({ "exp": 1000, "iat": 700 }));
        assert!(!is_expired(&token, 999_999));
        assert!(is_expired(&token, 1_000_000));
        assert!(is_expired(&jwt_with(&json!({ "exp": "1000" })), 0));
        assert!(!is_stale(&token, 300.0, 1_000_000));
        assert!(is_stale(&token, 300.0, 1_000_001));
        assert!(is_stale(&jwt_with(&json!({})), 300.0, 0));
    }
}
