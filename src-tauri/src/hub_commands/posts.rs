// SPDX-License-Identifier: GPL-2.0-or-later
//! The keymap posts and the private posts (on `pipette_hub::posts` and
//! `pipette_hub::private`).
//! The arguments arrive as the page sent them, and the answers carry what
//! the Hub sent as it sent it; the JWT stays here.
//!
//! A text input that is not a string reaches the handlers as `None` (see
//! `pipette_hub::posts` for what each makes of it). A page or page size
//! that is not a number is absent. An `expiresInDays` that is neither a
//! number nor null goes to the Hub as `NaN`, which the Hub refuses.

use std::sync::Arc;

use pipette_hub::posts::{self, KeymapPostParams, MyPostsParams};
use pipette_hub::private;
use serde_json::Value;
use tauri::State;
use tauri::ipc::Response;

use super::setup::Hub;
use crate::command_error::CommandError;

fn respond(answer: &pipette_js_json::Value) -> Result<Response, CommandError> {
    Ok(Response::new(pipette_js_json::stringify(answer)))
}

/// `params[key]` when it is a string.
fn text<'a>(params: Option<&'a Value>, key: &str) -> Option<&'a str> {
    params?.get(key)?.as_str()
}

/// `params[key]` when it is a number.
fn number(params: Option<&Value>, key: &str) -> Option<f64> {
    params?.get(key)?.as_f64()
}

/// `HubUploadPostParams` of `params`.
fn keymap_post(params: Option<&Value>) -> KeymapPostParams<'_> {
    KeymapPostParams {
        title: text(params, "title"),
        keyboard_name: text(params, "keyboardName"),
        vil_json: text(params, "vilJson"),
        pipette_json: text(params, "pipetteJson"),
        keymap_c: text(params, "keymapC"),
        pdf_base64: text(params, "pdfBase64"),
        thumbnail_base64: text(params, "thumbnailBase64"),
    }
}

/// `expiresInDays`: `None` when it is null or absent.
fn expires_in_days(params: Option<&Value>) -> Option<f64> {
    match params?.get("expiresInDays")? {
        Value::Null => None,
        value => Some(value.as_f64().unwrap_or(f64::NAN)),
    }
}

/// Runs the checks of an upload and builds its files (base64 decoding and
/// copies of up to tens of MB) on a blocking thread, off the async runtime.
async fn off_runtime<T: Send + 'static>(
    prepare: impl FnOnce() -> T + Send + 'static,
) -> Result<T, CommandError> {
    Ok(tauri::async_runtime::spawn_blocking(prepare).await?)
}

/// `String(value)` (`undefined` for an absent one).
fn js_string(value: Option<&Value>) -> String {
    let value = value
        .map(|value| pipette_js_json::parse(&value.to_string()).expect("serde_json writes JSON that parses"));
    pipette_js_json::js_string(value.as_ref())
}

#[tauri::command]
pub async fn hub_upload_post(
    hub: State<'_, Arc<Hub>>,
    params: Option<Value>,
) -> Result<Response, CommandError> {
    let post = off_runtime(move || posts::prepare_upload(keymap_post(params.as_ref()))).await?;
    respond(&posts::upload_prepared(hub.token(), post).await)
}

#[tauri::command]
pub async fn hub_update_post(
    hub: State<'_, Arc<Hub>>,
    params: Option<Value>,
) -> Result<Response, CommandError> {
    let prepared = off_runtime(move || {
        let params = params.as_ref();
        posts::prepare_update(text(params, "postId"), keymap_post(params))
    })
    .await?;
    respond(&posts::update_prepared(hub.token(), prepared).await)
}

#[tauri::command]
pub async fn hub_patch_post(
    hub: State<'_, Arc<Hub>>,
    params: Option<Value>,
) -> Result<Response, CommandError> {
    let params = params.as_ref();
    respond(&posts::patch_post(hub.token(), text(params, "postId"), text(params, "title")).await)
}

#[tauri::command]
pub async fn hub_delete_post(
    hub: State<'_, Arc<Hub>>,
    post_id: Option<Value>,
) -> Result<Response, CommandError> {
    respond(&posts::delete_post(hub.token(), post_id.as_ref().and_then(Value::as_str)).await)
}

#[tauri::command]
pub async fn hub_fetch_my_posts(
    hub: State<'_, Arc<Hub>>,
    params: Option<Value>,
) -> Result<Response, CommandError> {
    let params = params.as_ref();
    let params = MyPostsParams { page: number(params, "page"), per_page: number(params, "per_page") };
    respond(&posts::fetch_my_posts(hub.token(), params).await)
}

#[tauri::command]
pub async fn hub_fetch_my_keyboard_posts(
    hub: State<'_, Arc<Hub>>,
    keyboard_name: Option<Value>,
) -> Result<Response, CommandError> {
    respond(
        &posts::fetch_my_keyboard_posts(hub.token(), keyboard_name.as_ref().and_then(Value::as_str)).await,
    )
}

#[tauri::command]
pub async fn hub_upload_private_post(
    hub: State<'_, Arc<Hub>>,
    params: Option<Value>,
) -> Result<Response, CommandError> {
    let expires_in_days = expires_in_days(params.as_ref());
    let post = off_runtime(move || posts::prepare_upload(keymap_post(params.as_ref()))).await?;
    respond(&private::upload_private_prepared(hub.token(), post, expires_in_days).await)
}

/// `kind` goes into the path unchecked.
#[tauri::command]
pub async fn hub_delete_private_post(
    hub: State<'_, Arc<Hub>>,
    kind: Option<Value>,
    id: Option<Value>,
) -> Result<Response, CommandError> {
    let kind = js_string(kind.as_ref());
    respond(&private::delete_private_post(hub.token(), &kind, id.as_ref().and_then(Value::as_str)).await)
}

#[cfg(test)]
mod tests {
    use pipette_hub::HubDestination;
    use pipette_hub::fake::FakeHub;
    use pipette_hub::{HubRequesters, IdTokenSource};
    use serde_json::json;
    use tauri::Manager;
    use tauri::ipc::{InvokeResponseBody, IpcResponse};
    use tauri::test::{MockRuntime, mock_app};

    use super::*;
    use crate::hub_commands::setup::manage_with;

    fn app(fake: &Arc<FakeHub>) -> tauri::App<MockRuntime> {
        let app = mock_app();
        let destination = HubDestination::resolve(true, &|name| {
            (name == "PIPETTE_HUB_URL").then(|| "http://127.0.0.1:9".to_owned())
        });
        let id_tokens: Arc<dyn IdTokenSource> = Arc::new(|| Some("test:alice@example.com".to_owned()));
        manage_with(app.handle(), destination, HubRequesters::single(fake.clone()), id_tokens);
        app
    }

    fn body(response: Result<Response, CommandError>) -> Value {
        match response.unwrap().body().unwrap() {
            InvokeResponseBody::Json(text) => serde_json::from_str(&text).unwrap(),
            InvokeResponseBody::Raw(_) => panic!("not JSON"),
        }
    }

    fn post_params(title: &str) -> Value {
        json!({
            "title": title,
            "keyboardName": " My Board ",
            "vilJson": "{}",
            "pipetteJson": "{}",
            "keymapC": "c",
            "pdfBase64": "JVBERg==",
            "thumbnailBase64": "/9j/",
        })
    }

    #[tokio::test]
    async fn the_post_commands_answer_from_the_hub() {
        let fake = Arc::new(FakeHub::new());
        let app = app(&fake);
        let hub = || app.state::<Arc<Hub>>();

        let uploaded = body(hub_upload_post(hub(), Some(post_params(" First "))).await);
        let post_id = uploaded["postId"].as_str().unwrap().to_owned();
        let mut update = post_params("Second");
        update["postId"] = json!(post_id);
        assert_eq!(
            body(hub_update_post(hub(), Some(update)).await),
            json!({ "success": true, "postId": post_id })
        );
        let patch = json!({ "postId": post_id, "title": "Third" });
        assert_eq!(body(hub_patch_post(hub(), Some(patch)).await), json!({ "success": true }));

        let mine = body(hub_fetch_my_posts(hub(), Some(json!({ "page": 0, "per_page": 500 }))).await);
        assert_eq!(mine["pagination"], json!({ "total": 1, "page": 1, "per_page": 100, "total_pages": 1 }));
        assert_eq!(mine["posts"][0]["title"], "Third");
        assert_eq!(body(hub_fetch_my_posts(hub(), None).await)["success"], true);
        // The keyboard name is trimmed for the list but uploaded as it was.
        let board = body(hub_fetch_my_keyboard_posts(hub(), Some(json!(" My Board "))).await);
        assert_eq!(board["success"], true, "{board}");
        assert_eq!(fake.requests().last().unwrap().query, [("name".to_owned(), "My Board".to_owned())]);
        let request = fake.requests().into_iter().find(|request| request.path == "/api/files").unwrap();
        let sent = String::from_utf8_lossy(&request.body.unwrap()).into_owned();
        assert!(sent.contains("name=\"keyboard_name\"\r\n\r\n My Board \r\n"), "{sent}");

        assert_eq!(body(hub_delete_post(hub(), Some(json!(post_id))).await), json!({ "success": true }));
        assert_eq!(
            body(hub_delete_post(hub(), Some(json!(5))).await),
            json!({ "success": false, "error": "Invalid post ID" })
        );
        assert_eq!(
            body(hub_upload_post(hub(), None).await),
            json!({ "success": false, "error": "Title must not be empty" })
        );
    }

    #[tokio::test]
    async fn the_private_commands_answer_from_the_hub() {
        let fake = Arc::new(FakeHub::new());
        let app = app(&fake);
        let hub = || app.state::<Arc<Hub>>();

        let mut params = post_params("Private");
        params["expiresInDays"] = json!(7);
        let uploaded = body(hub_upload_private_post(hub(), Some(params.clone())).await);
        assert_eq!(uploaded["success"], true, "{uploaded}");
        assert!(uploaded["url"].as_str().unwrap().contains(uploaded["id"].as_str().unwrap()));
        assert!(uploaded["expiresAt"].is_string());

        // An expiry that is not a number is refused by the Hub.
        params["expiresInDays"] = json!("7");
        let refused = body(hub_upload_private_post(hub(), Some(params)).await);
        assert_eq!(refused["success"], false, "{refused}");
        let sent = fake.requests().last().unwrap().body.clone().unwrap();
        assert!(String::from_utf8_lossy(&sent).contains("name=\"expires_in_days\"\r\n\r\nNaN\r\n"));

        let id = uploaded["id"].clone();
        let deleted = body(hub_delete_private_post(hub(), Some(json!("files")), Some(id.clone())).await);
        assert_eq!(deleted, json!({ "success": true }));
        // Gone already.
        let again = body(hub_delete_private_post(hub(), Some(json!("files")), Some(id)).await);
        assert_eq!(again, json!({ "success": true }));
        // The kind is not checked: it goes into the path as `String(kind)`.
        body(hub_delete_private_post(hub(), None, Some(json!("x"))).await);
        assert_eq!(fake.requests().last().unwrap().path, "/api/private/undefined/x");
        assert_eq!(
            body(hub_delete_private_post(hub(), Some(json!("files")), Some(json!(""))).await),
            json!({ "success": false, "error": "Invalid id" })
        );
    }

    #[test]
    fn kind_is_written_as_javascript_writes_it() {
        assert_eq!(js_string(None), "undefined");
        assert_eq!(js_string(Some(&json!(null))), "null");
        assert_eq!(js_string(Some(&json!("files"))), "files");
        assert_eq!(js_string(Some(&json!(1.5))), "1.5");
        assert_eq!(js_string(Some(&json!([1, null, "a"]))), "1,,a");
        assert_eq!(js_string(Some(&json!({ "a": 1 }))), "[object Object]");
    }
}
