// SPDX-License-Identifier: GPL-2.0-or-later
//! The account handlers: the Hub origin, the display name of the next token
//! and the account's own record. The answers are
//! `{ success, user?, error? }`, with the Hub's user object as the Hub sent
//! it.

use pipette_js_json::{Object, Value};

use crate::endpoint::Endpoint;
use crate::http::{HubHttp, RequestBody, StatusKind};
use crate::token::{HUB_ERROR_DISPLAY_NAME_CONFLICT, HubFailure, HubToken};
use crate::validate::validate_display_name;

/// `HUB_GET_ORIGIN`: the Hub base the requests go to.
pub fn origin(http: &HubHttp) -> String {
    http.base().to_owned()
}

/// `HUB_SET_AUTH_DISPLAY_NAME`: `None` stands for any value that is not a
/// string.
pub fn set_auth_display_name(token: &HubToken, display_name: Option<&str>) {
    token.set_pending_display_name(display_name.map(str::to_owned));
}

/// `HUB_FETCH_AUTH_ME`.
pub async fn fetch_auth_me(token: &HubToken) -> Value {
    let user = token
        .with_token_retry(|jwt| async move {
            token.http().send(&Endpoint::AuthMe, Some(jwt.as_str()), RequestBody::None).await
        })
        .await;
    user_answer(user)
}

/// `HUB_PATCH_AUTH_ME`: the trimmed display name; a 409 is
/// `DISPLAY_NAME_CONFLICT`. `None` stands for any value that is not a
/// string.
pub async fn patch_auth_me(token: &HubToken, display_name: Option<&str>) -> Value {
    let validated = match validate_display_name(display_name) {
        Ok(validated) => validated,
        Err(err) => return user_answer(Err(err.into())),
    };
    let body = display_name_body(&validated);
    let user = token
        .with_token_retry(|jwt| {
            let body = body.clone();
            async move {
                token.http().send(&Endpoint::PatchAuthMe, Some(jwt.as_str()), RequestBody::Json(body)).await
            }
        })
        .await
        .map_err(|err| {
            if err.is(StatusKind::Conflict) {
                HubFailure::plain(HUB_ERROR_DISPLAY_NAME_CONFLICT)
            } else {
                err
            }
        });
    user_answer(user)
}

/// `JSON.stringify({ display_name })`.
fn display_name_body(display_name: &str) -> String {
    let mut body = Object::new();
    body.insert("display_name", Value::from(display_name));
    pipette_js_json::stringify(&Value::Object(body))
}

/// `{ success: true, user }` (no `user` where the Hub sent none) or
/// `{ success: false, error }`.
fn user_answer(user: Result<Option<Value>, HubFailure>) -> Value {
    let mut answer = Object::new();
    match user {
        Ok(user) => {
            answer.insert("success", Value::Bool(true));
            if let Some(user) = user {
                answer.insert("user", user);
            }
        }
        Err(err) => {
            answer.insert("success", Value::Bool(false));
            answer.insert("error", Value::from(err.message));
        }
    }
    Value::Object(answer)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::sync::Arc;

    use pipette_js_json::stringify;

    use super::*;
    use crate::fake::FakeHub;
    use crate::http::{HubRequesters, SystemTiming};

    fn on_fake_hub(id_token: &'static str) -> (HubToken, Arc<FakeHub>) {
        let hub = Arc::new(FakeHub::new());
        let http =
            HubHttp::new("http://127.0.0.1:9", HubRequesters::single(hub.clone()), Arc::new(SystemTiming));
        (HubToken::new(http, Arc::new(move || Some(id_token.to_owned()))), hub)
    }

    fn display_name(answer: &Value) -> String {
        let user = answer.as_object().unwrap().get("user").unwrap_or_else(|| panic!("{}", stringify(answer)));
        stringify(user.as_object().unwrap().get("display_name").unwrap())
    }

    fn error(answer: &Value) -> &str {
        answer.as_object().unwrap().get("error").unwrap().as_str().unwrap()
    }

    #[tokio::test]
    async fn the_account_on_the_in_memory_hub() {
        let (token, hub) = on_fake_hub("test:alice@example.com");
        hub.set_user("bob@example.com", Some("Bob"), None);
        assert_eq!(origin(token.http()), "http://127.0.0.1:9");

        // A new account takes the display name set for its first token.
        set_auth_display_name(&token, Some("Alice"));
        assert_eq!(display_name(&fetch_auth_me(&token).await), r#""Alice""#);

        assert_eq!(error(&patch_auth_me(&token, Some(" Bob ")).await), HUB_ERROR_DISPLAY_NAME_CONFLICT);
        assert_eq!(display_name(&patch_auth_me(&token, Some(" Carol ")).await), r#""Carol""#);
        assert_eq!(error(&patch_auth_me(&token, None).await), "Display name must not be empty");
        assert_eq!(error(&patch_auth_me(&token, Some(&"x".repeat(51))).await), "Display name too long");

        // A JWT the Hub no longer knows is replaced once.
        hub.revoke_tokens();
        assert_eq!(display_name(&fetch_auth_me(&token).await), r#""Carol""#);

        hub.set_user("alice@example.com", Some("Carol"), Some(false));
        assert_eq!(error(&fetch_auth_me(&token).await), crate::token::HUB_ERROR_ACCOUNT_DEACTIVATED);
    }

    #[tokio::test]
    async fn a_name_taken_by_another_account_fails_the_first_token() {
        let (token, hub) = on_fake_hub("test:alice@example.com");
        hub.set_user("bob@example.com", Some("Bob"), None);
        set_auth_display_name(&token, Some("Bob"));
        assert_eq!(error(&fetch_auth_me(&token).await), HUB_ERROR_DISPLAY_NAME_CONFLICT);
        assert!(!token.snapshot().cached);
    }
}
