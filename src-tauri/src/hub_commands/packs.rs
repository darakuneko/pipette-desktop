// SPDX-License-Identifier: GPL-2.0-or-later
//! The language and theme packs on the Hub (the handlers of
//! src/main/hub/hub-ipc-packs.ts, on `pipette_hub::packs`): the search, the
//! download, the upload, update and delete with the local pack's Hub link,
//! and the freshness timestamps.
//!
//! The arguments arrive as the renderer sent them, except the pack of an
//! upload or update: the shim sends it as the text of `JSON.stringify`, so
//! its key order reaches the Hub as Electron sends it. The answers are JSON
//! text written by `pipette_js_json`, so the packs and the Hub's objects
//! reach the page in the order the Hub sent them. The local pack's link is
//! written through the pack store on a blocking-task thread, as every
//! store write; the store reports its sync unit. Like
//! Electron's handlers, these send no `i18n-pack:changed` /
//! `theme-pack:changed`.

use std::sync::Arc;

use pipette_hub::BoxFuture;
use pipette_hub::packs::{self, LinkChange, PackKind, PackLinks};
use pipette_js_json::{Object, Value as JsValue};
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

/// `params` with the pack the shim sent as JSON text put back in it.
fn with_pack(params: Arg, pack: Option<String>) -> Result<Option<JsValue>, CommandError> {
    let mut params = js(params)?;
    if let (Some(JsValue::Object(object)), Some(pack)) = (&mut params, pack) {
        object.insert("pack", pipette_js_json::parse(&pack)?);
    }
    Ok(params)
}

/// `{ success: false, error }`: arguments that cannot be read fail as a
/// handler that throws does, not as a rejected call.
fn failure(error: CommandError) -> JsValue {
    let mut answer = Object::new();
    answer.insert("success", JsValue::Bool(false));
    answer.insert("error", JsValue::from(error.to_string()));
    JsValue::Object(answer)
}

/// The pack store's Hub links, written on a blocking-task thread.
struct BlockingLinks(StoreContext);

impl PackLinks for BlockingLinks {
    fn link(&self, change: LinkChange) -> BoxFuture<'_, ()> {
        let stores = self.0.clone();
        Box::pin(async move {
            if let Err(err) = tauri::async_runtime::spawn_blocking(move || change.apply(&stores)).await {
                log::error!("[hub] writing a pack's Hub link failed: {err}");
            }
        })
    }
}

fn respond(answer: &JsValue) -> Result<Response, CommandError> {
    Ok(Response::new(pipette_js_json::stringify(answer)))
}

async fn timestamps(hub: &Hub, kind: PackKind, ids: Arg) -> Result<Response, CommandError> {
    respond(&packs::timestamps(hub.http(), kind, js(ids)?.as_ref()).await)
}

async fn list(hub: &Hub, kind: PackKind, params: Arg) -> Result<Response, CommandError> {
    respond(&packs::list(hub.http(), kind, js(params)?.as_ref()).await)
}

async fn download(hub: &Hub, kind: PackKind, post_id: Arg) -> Result<Response, CommandError> {
    respond(&packs::download(hub.http(), kind, js(post_id)?.as_ref()).await)
}

async fn upload(
    hub: &Hub,
    stores: &StoreContext,
    kind: PackKind,
    params: Arg,
    pack: Option<String>,
) -> Result<Response, CommandError> {
    let params = match with_pack(params, pack) {
        Ok(params) => params,
        Err(err) => return respond(&failure(err)),
    };
    let links = BlockingLinks(stores.clone());
    respond(&packs::upload(hub.token(), &links, kind, params.as_ref()).await)
}

async fn update(
    hub: &Hub,
    stores: &StoreContext,
    kind: PackKind,
    params: Arg,
    pack: Option<String>,
) -> Result<Response, CommandError> {
    let params = match with_pack(params, pack) {
        Ok(params) => params,
        Err(err) => return respond(&failure(err)),
    };
    let links = BlockingLinks(stores.clone());
    respond(&packs::update(hub.token(), &links, kind, params.as_ref()).await)
}

async fn delete(
    hub: &Hub,
    stores: &StoreContext,
    kind: PackKind,
    post_id: Arg,
    local_pack_id: Arg,
) -> Result<Response, CommandError> {
    let (post_id, local_pack_id) = (js(post_id)?, js(local_pack_id)?);
    let links = BlockingLinks(stores.clone());
    respond(&packs::delete(hub.token(), &links, kind, post_id.as_ref(), local_pack_id.as_ref()).await)
}

#[tauri::command]
pub async fn i18n_pack_hub_timestamps(hub: State<'_, Arc<Hub>>, ids: Arg) -> Result<Response, CommandError> {
    timestamps(&hub, PackKind::I18n, ids).await
}

#[tauri::command]
pub async fn hub_list_i18n_posts(hub: State<'_, Arc<Hub>>, params: Arg) -> Result<Response, CommandError> {
    list(&hub, PackKind::I18n, params).await
}

#[tauri::command]
pub async fn hub_download_i18n_post(
    hub: State<'_, Arc<Hub>>,
    post_id: Arg,
) -> Result<Response, CommandError> {
    download(&hub, PackKind::I18n, post_id).await
}

#[tauri::command]
pub async fn hub_upload_i18n_post(
    hub: State<'_, Arc<Hub>>,
    stores: State<'_, StoreContext>,
    params: Arg,
    pack: Option<String>,
) -> Result<Response, CommandError> {
    upload(&hub, &stores, PackKind::I18n, params, pack).await
}

#[tauri::command]
pub async fn hub_update_i18n_post(
    hub: State<'_, Arc<Hub>>,
    stores: State<'_, StoreContext>,
    params: Arg,
    pack: Option<String>,
) -> Result<Response, CommandError> {
    update(&hub, &stores, PackKind::I18n, params, pack).await
}

#[tauri::command]
pub async fn hub_delete_i18n_post(
    hub: State<'_, Arc<Hub>>,
    stores: State<'_, StoreContext>,
    post_id: Arg,
    local_pack_id: Arg,
) -> Result<Response, CommandError> {
    delete(&hub, &stores, PackKind::I18n, post_id, local_pack_id).await
}

#[tauri::command]
pub async fn theme_pack_hub_timestamps(hub: State<'_, Arc<Hub>>, ids: Arg) -> Result<Response, CommandError> {
    timestamps(&hub, PackKind::Theme, ids).await
}

#[tauri::command]
pub async fn hub_list_theme_posts(hub: State<'_, Arc<Hub>>, params: Arg) -> Result<Response, CommandError> {
    list(&hub, PackKind::Theme, params).await
}

#[tauri::command]
pub async fn hub_download_theme_post(
    hub: State<'_, Arc<Hub>>,
    post_id: Arg,
) -> Result<Response, CommandError> {
    download(&hub, PackKind::Theme, post_id).await
}

#[tauri::command]
pub async fn hub_upload_theme_post(
    hub: State<'_, Arc<Hub>>,
    stores: State<'_, StoreContext>,
    params: Arg,
    pack: Option<String>,
) -> Result<Response, CommandError> {
    upload(&hub, &stores, PackKind::Theme, params, pack).await
}

#[tauri::command]
pub async fn hub_update_theme_post(
    hub: State<'_, Arc<Hub>>,
    stores: State<'_, StoreContext>,
    params: Arg,
    pack: Option<String>,
) -> Result<Response, CommandError> {
    update(&hub, &stores, PackKind::Theme, params, pack).await
}

#[tauri::command]
pub async fn hub_delete_theme_post(
    hub: State<'_, Arc<Hub>>,
    stores: State<'_, StoreContext>,
    post_id: Arg,
    local_pack_id: Arg,
) -> Result<Response, CommandError> {
    delete(&hub, &stores, PackKind::Theme, post_id, local_pack_id).await
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

    /// An app with the stores on `user_data` and a Hub on `fake`, signed in
    /// as the Hub test account.
    fn app(user_data: &std::path::Path, fake: &Arc<FakeHub>) -> tauri::App<MockRuntime> {
        let app = mock_app();
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

    const PACK: &str = r#"{"name":"Japanese","version":"1.2.0","z":"last","a":"first"}"#;

    #[tokio::test]
    async fn a_pack_keeps_its_key_order_up_and_down_and_links_the_local_pack() {
        let user_data = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeHub::new());
        let app = app(user_data.path(), &fake);
        let stores = app.state::<StoreContext>().inner().clone();
        let input = pipette_pack_stores::i18n::SavePackInput {
            id: Some("pack-ja".into()),
            pack: Some(pipette_js_json::parse(PACK).unwrap()),
            ..Default::default()
        };
        pipette_pack_stores::i18n::save_pack(&stores, input).unwrap();

        let params = Some(json!({ "entryId": "pack-ja" }));
        let uploaded = text(
            hub_upload_i18n_post(app.state(), app.state(), params, Some(PACK.to_owned())).await.unwrap(),
        );
        let post_id =
            serde_json::from_str::<Value>(&uploaded).unwrap()["postId"].as_str().unwrap().to_owned();
        let index = std::fs::read_to_string(user_data.path().join("sync/i18n/index.json")).unwrap();
        assert!(index.contains(&format!(r#""hubPostId": "{post_id}""#)), "{index}");

        let downloaded = text(hub_download_i18n_post(app.state(), Some(json!(post_id))).await.unwrap());
        assert!(downloaded.ends_with(&format!(r#""pack":{PACK}}}}}"#)), "{downloaded}");

        let unreadable = text(
            hub_update_i18n_post(
                app.state(),
                app.state(),
                Some(json!({ "postId": "p" })),
                Some("{".to_owned()),
            )
            .await
            .unwrap(),
        );
        assert!(unreadable.starts_with(r#"{"success":false,"error":""#), "{unreadable}");

        let refused =
            text(hub_upload_theme_post(app.state(), app.state(), Some(json!("x")), None).await.unwrap());
        assert_eq!(refused, r#"{"success":false,"error":"Invalid params"}"#);
        let stamps = text(theme_pack_hub_timestamps(app.state(), Some(json!([]))).await.unwrap());
        assert_eq!(stamps, r#"{"success":true,"data":{"items":[]}}"#);
    }
}
