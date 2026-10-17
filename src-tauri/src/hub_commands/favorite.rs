// SPDX-License-Identifier: GPL-2.0-or-later
//! The favorite posts (src/main/hub/hub-ipc-favorite.ts and the private
//! favorite upload of hub-ipc-private.ts), on `pipette_hub::favorite`. The
//! export JSON is built by the page's worker, so the page checks the post,
//! reads the entry with `hub_favorite_entry`, builds the JSON and sends it
//! with the post's `params` to `hub_upload_favorite_post`,
//! `hub_update_favorite_post` or `hub_upload_private_favorite_post`, which
//! check the post again and send it with the Hub JWT. The answers are the
//! handlers' `{success, …}` objects, written by `pipette_js_json`.

use std::sync::Arc;

use pipette_hub::favorite;
use pipette_js_json::Value as JsValue;
use pipette_keyboard_stores::StoreContext;
use serde_json::Value;
use tauri::State;
use tauri::ipc::Response;

use super::setup::Hub;
use crate::command_error::CommandError;

/// An argument as `JSON.parse` reads it (`None`: missing, `undefined`).
fn js_value(value: Option<Value>) -> Result<Option<JsValue>, CommandError> {
    value.map(|value| Ok(pipette_js_json::parse(&serde_json::to_string(&value)?)?)).transpose()
}

fn respond(answer: &JsValue) -> Response {
    Response::new(pipette_js_json::stringify(answer))
}

#[tauri::command]
pub async fn hub_upload_favorite_post(
    hub: State<'_, Arc<Hub>>,
    params: Option<Value>,
    json: String,
) -> Result<Response, CommandError> {
    let params = js_value(params)?;
    Ok(respond(&favorite::upload(hub.token(), params.as_ref(), &json).await))
}

#[tauri::command]
pub async fn hub_update_favorite_post(
    hub: State<'_, Arc<Hub>>,
    params: Option<Value>,
    json: String,
) -> Result<Response, CommandError> {
    let params = js_value(params)?;
    Ok(respond(&favorite::update(hub.token(), params.as_ref(), &json).await))
}

#[tauri::command]
pub async fn hub_upload_private_favorite_post(
    hub: State<'_, Arc<Hub>>,
    params: Option<Value>,
    json: String,
) -> Result<Response, CommandError> {
    let params = js_value(params)?;
    Ok(respond(&favorite::upload_private(hub.token(), params.as_ref(), &json).await))
}

/// The favorite entry a post is built from: `{success: true, entry:
/// {label?, savedAt?, body}}` or `{success: false, error}`. It reads the
/// store's files as they are, without its write lock, as the Electron
/// handler does.
#[tauri::command]
pub async fn hub_favorite_entry(
    stores: State<'_, StoreContext>,
    favorite_type: Option<Value>,
    entry_id: Option<Value>,
) -> Result<Response, CommandError> {
    let favorite_type = js_value(favorite_type)?;
    let entry_id = js_value(entry_id)?;
    let sync_dir = stores.sync_dir();
    let entry = tauri::async_runtime::spawn_blocking(move || {
        favorite::read_entry(&sync_dir, favorite_type.as_ref(), entry_id.as_ref())
    })
    .await?;
    Ok(respond(&favorite::entry_answer(entry)))
}

#[cfg(test)]
mod tests {
    use pipette_hub::fake::FakeHub;
    use pipette_hub::{HubDestination, HubRequesters, IdTokenSource};
    use tauri::Manager;
    use tauri::ipc::{InvokeResponseBody, IpcResponse};
    use tauri::test::{MockRuntime, mock_app};

    use super::*;
    use crate::hub_commands::setup::manage_with;

    fn app(user_data: &std::path::Path, fake: &Arc<FakeHub>) -> tauri::App<MockRuntime> {
        let app = mock_app();
        crate::store_commands::sync_pending::manage_without_delayed_writes(app.handle(), user_data);
        crate::store_commands::keyboard_data::manage(app.handle(), user_data);
        let destination = HubDestination::resolve(true, &|name| {
            (name == "PIPETTE_HUB_URL").then(|| "http://127.0.0.1:9".to_owned())
        });
        let id_tokens: Arc<dyn IdTokenSource> = Arc::new(|| Some("test:alice@example.com".to_owned()));
        manage_with(app.handle(), destination, HubRequesters::single(fake.clone()), id_tokens);
        app
    }

    fn text(response: Response) -> String {
        match response.body().unwrap() {
            InvokeResponseBody::Json(text) => text,
            InvokeResponseBody::Raw(_) => panic!("not JSON"),
        }
    }

    const PARAMS: &str = r#"{"type":"macro","entryId":"m-1","title":" M ","vialProtocol":6}"#;

    #[tokio::test]
    async fn reads_the_entry_and_posts_the_json_the_page_built() {
        let user_data = tempfile::tempdir().unwrap();
        let dir = user_data.path().join("sync/favorites/macro");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("index.json"),
            r#"{"type":"macro","entries":[{"id":"m-1","label":"M","savedAt":"s","filename":"m.json"}]}"#,
        )
        .unwrap();
        std::fs::write(dir.join("m.json"), r#"{"type":"macro","data":[["tap",4]]}"#).unwrap();
        let fake = Arc::new(FakeHub::new());
        let app = app(user_data.path(), &fake);

        let entry = hub_favorite_entry(app.state::<StoreContext>(), Some("macro".into()), Some("m-1".into()))
            .await
            .unwrap();
        assert_eq!(
            text(entry),
            r#"{"success":true,"entry":{"label":"M","savedAt":"s","body":"{\"type\":\"macro\",\"data\":[[\"tap\",4]]}"}}"#
        );
        let missing =
            hub_favorite_entry(app.state::<StoreContext>(), Some("nope".into()), None).await.unwrap();
        assert_eq!(text(missing), r#"{"success":false,"error":"Invalid favorite type"}"#);

        let params: Value = serde_json::from_str(PARAMS).unwrap();
        let json = r#"{"app":"pipette","version":3,"scope":"fav","exportedAt":"x","vial_protocol":6,"categories":{}}"#;
        let uploaded = text(
            hub_upload_favorite_post(app.state::<Arc<Hub>>(), Some(params.clone()), json.to_owned())
                .await
                .unwrap(),
        );
        assert!(uploaded.starts_with(r#"{"success":true,"postId":""#), "{uploaded}");
        let sent = fake.requests().into_iter().find(|request| request.path == "/api/files").unwrap();
        let body = String::from_utf8(sent.body.unwrap()).unwrap();
        assert!(body.contains("filename=\"macro.json\"\r\nContent-Type: application/json\r\n\r\n"), "{body}");
        assert!(body.contains(json));

        let private = text(
            hub_upload_private_favorite_post(app.state::<Arc<Hub>>(), Some(params.clone()), json.to_owned())
                .await
                .unwrap(),
        );
        assert!(private.starts_with(r#"{"success":true,"id":""#), "{private}");

        let mut update = params;
        update["postId"] = "bad id".into();
        let updated = text(
            hub_update_favorite_post(app.state::<Arc<Hub>>(), Some(update), json.to_owned()).await.unwrap(),
        );
        assert_eq!(updated, r#"{"success":false,"error":"Invalid post ID"}"#);
        let none =
            text(hub_upload_favorite_post(app.state::<Arc<Hub>>(), None, json.to_owned()).await.unwrap());
        assert_eq!(
            none,
            r#"{"success":false,"error":"Cannot read properties of undefined (reading 'type')"}"#
        );
    }
}
