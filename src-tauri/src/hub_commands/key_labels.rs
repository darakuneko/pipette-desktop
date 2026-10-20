// SPDX-License-Identifier: GPL-2.0-or-later
//! The key labels on the Hub (on `pipette_hub::key_labels`): the search, the
//! detail and the freshness timestamps, the download into the key label store,
//! and the upload, update, sync and delete of a local label linked to its post.
//!
//! The arguments arrive as the renderer sent them; the answers are the
//! handlers' `{success, data?, errorCode?, error?}` as JSON text written by
//! `pipette_js_json`, so the Hub's objects and the labels' maps reach the
//! page in the order they were sent. The local label is read and written
//! through the key label store, which reports its sync unit.

use std::sync::Arc;

use pipette_hub::key_labels;
use pipette_js_json::Value as JsValue;
use pipette_keyboard_stores::StoreContext;
use serde_json::Value;
use tauri::State;
use tauri::ipc::Response;

use super::setup::Hub;
use crate::command_error::CommandError;

/// An argument as the handler gets it: `None` for `undefined`.
type Arg = Option<Value>;

fn js(arg: Arg) -> Result<Option<JsValue>, CommandError> {
    arg.map(|value| Ok(pipette_js_json::parse(&serde_json::to_string(&value)?)?)).transpose()
}

#[tauri::command]
pub async fn key_label_hub_list(hub: State<'_, Arc<Hub>>, params: Arg) -> Result<Response, CommandError> {
    Ok(Response::new(key_labels::list(hub.http(), js(params)?.as_ref()).await))
}

#[tauri::command]
pub async fn key_label_hub_detail(
    hub: State<'_, Arc<Hub>>,
    hub_post_id: Arg,
) -> Result<Response, CommandError> {
    Ok(Response::new(key_labels::detail(hub.http(), js(hub_post_id)?.as_ref()).await))
}

#[tauri::command]
pub async fn key_label_hub_download(
    hub: State<'_, Arc<Hub>>,
    stores: State<'_, StoreContext>,
    hub_post_id: Arg,
) -> Result<Response, CommandError> {
    Ok(Response::new(key_labels::download(hub.http(), &stores, js(hub_post_id)?.as_ref()).await))
}

#[tauri::command]
pub async fn key_label_hub_upload(
    hub: State<'_, Arc<Hub>>,
    stores: State<'_, StoreContext>,
    local_id: Arg,
) -> Result<Response, CommandError> {
    Ok(Response::new(key_labels::upload(hub.token(), &stores, js(local_id)?.as_ref()).await))
}

#[tauri::command]
pub async fn key_label_hub_update(
    hub: State<'_, Arc<Hub>>,
    stores: State<'_, StoreContext>,
    local_id: Arg,
) -> Result<Response, CommandError> {
    Ok(Response::new(key_labels::update(hub.token(), &stores, js(local_id)?.as_ref()).await))
}

#[tauri::command]
pub async fn key_label_hub_sync(
    hub: State<'_, Arc<Hub>>,
    stores: State<'_, StoreContext>,
    local_id: Arg,
) -> Result<Response, CommandError> {
    Ok(Response::new(key_labels::sync(hub.http(), &stores, js(local_id)?.as_ref()).await))
}

#[tauri::command]
pub async fn key_label_hub_timestamps(hub: State<'_, Arc<Hub>>, ids: Arg) -> Result<Response, CommandError> {
    Ok(Response::new(key_labels::timestamps(hub.http(), js(ids)?.as_ref()).await))
}

#[tauri::command]
pub async fn key_label_hub_delete(
    hub: State<'_, Arc<Hub>>,
    stores: State<'_, StoreContext>,
    local_id: Arg,
) -> Result<Response, CommandError> {
    Ok(Response::new(key_labels::delete(hub.token(), &stores, js(local_id)?.as_ref()).await))
}

#[cfg(test)]
mod tests {
    use pipette_hub::fake::FakeHub;
    use pipette_hub::{HubDestination, HubRequesters, IdTokenSource};
    use serde_json::json;
    use tauri::Manager;
    use tauri::ipc::{InvokeResponseBody, IpcResponse};
    use tauri::test::{MockRuntime, mock_app};

    use super::*;
    use crate::hub_commands::setup::manage_with;

    /// An app with the stores on `user_data` and a Hub on `fake`, signed in
    /// with the Hub test account of alice.
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

    fn parsed(response: Response) -> Value {
        serde_json::from_str(&text(response)).unwrap()
    }

    #[tokio::test]
    async fn the_commands_download_upload_and_delete_through_the_store() {
        let user_data = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeHub::new());
        fake.set_user("alice@example.com", Some("Alice"), None);
        let seeded = fake.seed_key_label(
            "bob@example.com",
            "Eucalyn",
            pipette_js_json::parse(r#"{"KC_B":"B","KC_A":"A"}"#).unwrap(),
            None,
            false,
            None,
        );
        let post_id = seeded.as_object().unwrap().get("id").unwrap().as_str().unwrap().to_owned();
        let app = app(user_data.path(), &fake);
        let hub = || app.state::<Arc<Hub>>();
        let stores = || app.state::<StoreContext>();

        let listed = text(key_label_hub_list(hub(), Some(json!({ "q": "euc" }))).await.unwrap());
        // The Hub's map keeps the order it was sent in.
        assert!(listed.contains(r#""map":{"KC_B":"B","KC_A":"A"}"#), "{listed}");
        let detail = parsed(key_label_hub_detail(hub(), Some(json!(post_id))).await.unwrap());
        assert_eq!(detail["data"]["uploader_name"], "bob");
        let bad = text(key_label_hub_detail(hub(), Some(json!(5))).await.unwrap());
        assert_eq!(bad, r#"{"success":false,"errorCode":"NOT_FOUND","error":"Invalid hub post id"}"#);

        let downloaded = parsed(key_label_hub_download(hub(), stores(), Some(json!(post_id))).await.unwrap());
        assert_eq!(downloaded["data"]["id"], json!(post_id));
        let stamps = parsed(key_label_hub_timestamps(hub(), Some(json!([post_id, post_id]))).await.unwrap());
        assert_eq!(stamps["data"]["items"].as_array().unwrap().len(), 1);
        let synced = parsed(key_label_hub_sync(hub(), stores(), Some(json!(post_id))).await.unwrap());
        assert_eq!(synced["data"]["name"], "Eucalyn");

        // Alice cannot update or delete bob's post; her own label goes up
        // under another name and comes down again.
        let refused = parsed(key_label_hub_update(hub(), stores(), Some(json!(post_id))).await.unwrap());
        assert_eq!(refused["errorCode"], "IO_ERROR");
        let mine = pipette_keyboard_stores::KeyLabelSave {
            id: Some("mine".into()),
            name: "Mine".into(),
            uploader_name: None,
            map: pipette_js_json::parse("{}").unwrap(),
            composite_labels: None,
            keymap_applicable: true,
            hub_post_id: None,
            hub_updated_at: None,
            keep_current_name: false,
        };
        pipette_keyboard_stores::save_key_label(&stores(), &mine).unwrap();
        let up = parsed(key_label_hub_upload(hub(), stores(), Some(json!("mine"))).await.unwrap());
        assert_eq!(up["data"]["uploaderName"], "Alice");
        let updated = parsed(key_label_hub_update(hub(), stores(), Some(json!("mine"))).await.unwrap());
        assert_eq!(updated["success"], true);
        let deleted = text(key_label_hub_delete(hub(), stores(), Some(json!("mine"))).await.unwrap());
        assert_eq!(deleted, r#"{"success":true}"#);
        let none = text(key_label_hub_delete(hub(), stores(), None).await.unwrap());
        assert_eq!(none, r#"{"success":false,"errorCode":"NOT_FOUND","error":"Invalid id"}"#);
    }
}
