// SPDX-License-Identifier: GPL-2.0-or-later
//! The private (unlisted) keymap post handlers of
//! `src/main/hub/hub-ipc-private.ts`: the upload, which answers the share
//! URL and the expiry for the page to keep on its entry, and the delete
//! that Remove and the switch to public share.
//!
//! The upload checks and sends a keymap post as [`crate::posts`] does, to
//! `/api/private/files`, with `expires_in_days` last when there is an
//! expiry. The delete takes the post's `kind` as it is, unchecked, into
//! the path; only the id is checked (`Invalid id` for an empty one). A 404
//! means the post is gone already (expired or removed elsewhere) and counts
//! as deleted.

use pipette_js_json::Value;

use crate::endpoint::Endpoint;
use crate::http::{RequestBody, StatusKind};
use crate::posts::{
    CheckedKeymapPost, KeymapPostParams, answer, keymap_body, prepare_upload, property, send,
};
use crate::token::{HubFailure, HubToken};

/// `HUB_UPLOAD_PRIVATE_POST`: `{ success, id, url, expiresAt }`.
/// `expires_in_days` is `None` for no expiry; it is written as
/// `String(expiresInDays)`. The checks are those of a public upload.
pub async fn upload_private_post(
    token: &HubToken,
    params: KeymapPostParams<'_>,
    expires_in_days: Option<f64>,
) -> Value {
    upload_private_prepared(token, prepare_upload(params), expires_in_days).await
}

/// `HUB_UPLOAD_PRIVATE_POST` of a post [`prepare_upload`] prepared.
pub async fn upload_private_prepared(
    token: &HubToken,
    post: Result<CheckedKeymapPost, HubFailure>,
    expires_in_days: Option<f64>,
) -> Value {
    let result = async {
        let post = post?;
        let data = token
            .with_token_retry(|jwt| {
                let body = RequestBody::Multipart(keymap_body(token, &post, expires_in_days));
                send(token, &Endpoint::UploadPrivatePost, jwt, body)
            })
            .await?;
        // `toPrivateResult`.
        let data = data.as_ref();
        Ok(vec![
            ("id", property(data, "id")?),
            ("url", property(data, "url")?),
            ("expiresAt", property(data, "expires_at")?),
        ])
    }
    .await;
    answer(result)
}

/// `HUB_DELETE_PRIVATE_POST`: `kind` is `String(kind)` of what the page
/// sent; `id` is `None` for a value that is not a string.
pub async fn delete_private_post(token: &HubToken, kind: &str, id: Option<&str>) -> Value {
    let Some(id) = id.filter(|id| !id.is_empty()) else {
        return answer(Err(HubFailure::plain("Invalid id")));
    };
    let endpoint = Endpoint::DeletePrivatePost { kind, id };
    let result = token.with_token_retry(|jwt| send(token, &endpoint, jwt, RequestBody::None)).await;
    match result {
        Err(err) if !err.is(StatusKind::NotFound) => answer(Err(err)),
        _ => answer(Ok(Vec::new())),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::sync::Arc;

    use pipette_js_json::stringify;

    use super::*;
    use crate::fake::FakeHub;
    use crate::http::{HubHttp, HubRequesters, SystemTiming};

    fn on_fake_hub() -> (HubToken, Arc<FakeHub>) {
        let hub = Arc::new(FakeHub::new());
        let http =
            HubHttp::new("http://127.0.0.1:9", HubRequesters::single(hub.clone()), Arc::new(SystemTiming));
        (HubToken::new(http, Arc::new(|| Some("test:alice@example.com".to_owned()))), hub)
    }

    fn params() -> KeymapPostParams<'static> {
        KeymapPostParams {
            title: Some(" Mine "),
            keyboard_name: Some("Board"),
            vil_json: Some("{}"),
            pipette_json: Some("{}"),
            keymap_c: Some("c"),
            pdf_base64: Some("JVBERg=="),
            thumbnail_base64: Some("/9j/"),
        }
    }

    fn field<'a>(answer: &'a Value, key: &str) -> &'a Value {
        answer.as_object().unwrap().get(key).unwrap_or_else(|| panic!("{key} of {}", stringify(answer)))
    }

    #[tokio::test]
    async fn upload_and_delete_on_the_in_memory_hub() {
        let (token, hub) = on_fake_hub();
        let uploaded = upload_private_post(&token, params(), Some(7.0)).await;
        assert_eq!(field(&uploaded, "success"), &Value::Bool(true), "{}", stringify(&uploaded));
        let id = field(&uploaded, "id").as_str().unwrap().to_owned();
        assert!(field(&uploaded, "url").as_str().unwrap().contains(&id));
        assert!(field(&uploaded, "expiresAt").as_str().is_some());

        assert_eq!(stringify(&delete_private_post(&token, "files", Some(&id)).await), r#"{"success":true}"#);
        // Gone already: still deleted.
        assert_eq!(stringify(&delete_private_post(&token, "files", Some(&id)).await), r#"{"success":true}"#);
        assert_eq!(hub.requests().iter().filter(|r| r.path.starts_with("/api/private/files/")).count(), 2);
    }

    #[tokio::test]
    async fn an_upload_without_an_expiry_sends_no_expiry_field() {
        let (token, hub) = on_fake_hub();
        let uploaded = upload_private_post(&token, params(), None).await;
        assert_eq!(field(&uploaded, "success"), &Value::Bool(true), "{}", stringify(&uploaded));
        let request = hub.requests().into_iter().find(|r| r.path == "/api/private/files").unwrap();
        let body = String::from_utf8_lossy(request.body.as_deref().unwrap()).into_owned();
        assert!(body.contains("name=\"keyboard_name\"\r\n\r\nBoard\r\n"), "{body}");
        assert!(!body.contains("expires_in_days"), "{body}");
    }

    #[tokio::test]
    async fn the_checks_and_failures_of_a_private_post() {
        let (token, hub) = on_fake_hub();
        let untitled = upload_private_post(&token, KeymapPostParams { title: None, ..params() }, None).await;
        assert_eq!(stringify(&untitled), r#"{"success":false,"error":"Title must not be empty"}"#);
        let no_c = upload_private_post(&token, KeymapPostParams { keymap_c: None, ..params() }, None).await;
        assert_eq!(stringify(&no_c), r#"{"success":false,"error":"Upload failed"}"#);
        assert_eq!(
            stringify(&delete_private_post(&token, "files", None).await),
            r#"{"success":false,"error":"Invalid id"}"#
        );
        assert!(hub.requests().is_empty());

        // Someone else's post: the 403 is the deactivated account's sentinel,
        // as for any Hub request.
        let other = HubToken::new(token.http().clone(), Arc::new(|| Some("test:bob@example.com".to_owned())));
        let id = field(&upload_private_post(&other, params(), None).await, "id").as_str().unwrap().to_owned();
        let forbidden = delete_private_post(&token, "files", Some(&id)).await;
        assert_eq!(stringify(&forbidden), r#"{"success":false,"error":"ACCOUNT_DEACTIVATED"}"#);
    }
}
