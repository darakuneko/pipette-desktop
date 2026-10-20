// SPDX-License-Identifier: GPL-2.0-or-later
//! The Analyze posts, their preview and the private analytics upload, on
//! `pipette_hub::analytics::AnalyticsPosts`: the export is built from the
//! saved filter and the typing analytics here, and sent with the JWT that
//! stays here.
//!
//! `params` is the text of `JSON.stringify(params)`, read as `JSON.parse`
//! would; no text reads as `null`, and a text that is not JSON is answered
//! `{ success: false, error }` as a handler that throws is. The answers are
//! the handlers' `{ success, … }` objects as JSON text.

use std::sync::Arc;

use pipette_hub::analytics::{AnalyticsPosts, TypingAnalyticsSource};
use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::StoreContext;
use pipette_typing_analytics::TypingAnalytics;
use tauri::State;
use tauri::ipc::Response;

use super::setup::Hub;
use crate::command_error::CommandError;

/// Which handler a command runs.
#[derive(Clone, Copy)]
enum Handler {
    Upload,
    Update,
    Preview,
    UploadPrivate,
}

/// Runs `handler` on the parsed `params` and answers its value as JSON
/// text.
async fn answer(
    hub: &Hub,
    stores: &StoreContext,
    analytics: &Arc<TypingAnalytics>,
    params: Option<String>,
    handler: Handler,
) -> Result<Response, CommandError> {
    let params = match params.as_deref().map(pipette_js_json::parse).transpose() {
        Ok(params) => params.unwrap_or(Value::Null),
        Err(err) => {
            let mut answer = Object::new();
            answer.insert("success", Value::Bool(false));
            answer.insert("error", Value::from(CommandError::from(err).to_string()));
            return Ok(Response::new(pipette_js_json::stringify(&answer.into())));
        }
    };
    let source = TypingAnalyticsSource(Arc::clone(analytics));
    let posts = AnalyticsPosts { token: hub.token(), store: stores, source: &source };
    let answer = match handler {
        Handler::Upload => posts.upload(&params).await,
        Handler::Update => posts.update(&params).await,
        Handler::Preview => posts.preview(&params).await,
        Handler::UploadPrivate => posts.upload_private(&params).await,
    };
    Ok(Response::new(pipette_js_json::stringify(&answer)))
}

#[tauri::command]
pub async fn hub_upload_analytics_post(
    hub: State<'_, Arc<Hub>>,
    stores: State<'_, StoreContext>,
    analytics: State<'_, Arc<TypingAnalytics>>,
    params: Option<String>,
) -> Result<Response, CommandError> {
    answer(&hub, &stores, &analytics, params, Handler::Upload).await
}

#[tauri::command]
pub async fn hub_update_analytics_post(
    hub: State<'_, Arc<Hub>>,
    stores: State<'_, StoreContext>,
    analytics: State<'_, Arc<TypingAnalytics>>,
    params: Option<String>,
) -> Result<Response, CommandError> {
    answer(&hub, &stores, &analytics, params, Handler::Update).await
}

#[tauri::command]
pub async fn hub_preview_analytics_post(
    hub: State<'_, Arc<Hub>>,
    stores: State<'_, StoreContext>,
    analytics: State<'_, Arc<TypingAnalytics>>,
    params: Option<String>,
) -> Result<Response, CommandError> {
    answer(&hub, &stores, &analytics, params, Handler::Preview).await
}

#[tauri::command]
pub async fn hub_upload_private_analytics_post(
    hub: State<'_, Arc<Hub>>,
    stores: State<'_, StoreContext>,
    analytics: State<'_, Arc<TypingAnalytics>>,
    params: Option<String>,
) -> Result<Response, CommandError> {
    answer(&hub, &stores, &analytics, params, Handler::UploadPrivate).await
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use pipette_app_config::AppConfigStore;
    use pipette_hub::fake::FakeHub;
    use pipette_hub::{AnalyticsSource, HubDestination, HubRequesters, IdTokenSource};
    use tauri::Manager;
    use tauri::ipc::{InvokeResponseBody, IpcResponse};
    use tauri::test::{MockRuntime, mock_app};

    use super::*;
    use crate::app_config::AppConfig;
    use crate::hub_commands::setup::manage_with;

    const UID: &str = "uid-a";
    const ENTRY: &str = "f-own";

    /// An app with the stores, the typing analytics and a Hub on `fake`,
    /// whose Google sign-in answers the Hub test account's id_token.
    fn app(user_data: &Path, fake: &Arc<FakeHub>) -> tauri::App<MockRuntime> {
        let app = mock_app();
        let config: AppConfig = Arc::new(AppConfigStore::open(user_data));
        app.manage(config);
        crate::store_commands::sync_pending::manage_without_delayed_writes(app.handle(), user_data);
        crate::store_commands::keyboard_data::manage(app.handle(), user_data);
        crate::sync_commands::manage_for_tests(app.handle(), user_data);
        crate::analytics_commands::mark_cache_fresh(user_data, "machine");
        crate::analytics_commands::manage_with_machine_id(app.handle(), user_data, "machine");
        let destination = HubDestination::resolve(true, &|name| {
            (name == "PIPETTE_HUB_URL").then(|| "http://127.0.0.1:9".to_owned())
        });
        let id_tokens: Arc<dyn IdTokenSource> = Arc::new(|| Some("test:alice@example.com".to_owned()));
        manage_with(app.handle(), destination, HubRequesters::single(fake.clone()), id_tokens);
        app
    }

    /// The saved filter `f-own` of the Analyze export golden and a keymap
    /// snapshot of its window under this app's machine hash.
    async fn seed(app: &tauri::App<MockRuntime>, user_data: &Path) {
        let golden: Value = pipette_js_json::parse(
            &std::fs::read_to_string(format!(
                "{}/crates/pipette-hub/tests/fixtures/ts_hub_analytics_export.json",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap(),
        )
        .unwrap();
        let source = TypingAnalyticsSource(app.state::<Arc<TypingAnalytics>>().inner().clone());
        let hash = source.machine_hash().await.unwrap();
        let tree = golden.as_object().unwrap().get("tree").unwrap().as_object().unwrap();
        for (path, content) in tree.iter() {
            let path = path.as_str().unwrap();
            let keep = path.ends_with("/index.json")
                || path.ends_with(&format!("/{ENTRY}.json"))
                || path.contains("/keymaps/");
            if !keep {
                continue;
            }
            let path = path.replace(&"f1f0".repeat(16), &hash);
            let target = user_data.join(path);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(target, content.as_str().unwrap()).unwrap();
        }
    }

    fn text(response: Response) -> String {
        match response.body().unwrap() {
            InvokeResponseBody::Json(text) => text,
            InvokeResponseBody::Raw(_) => panic!("not JSON"),
        }
    }

    fn params(extra: &str) -> Option<String> {
        Some(format!(
            r#"{{"uid":"{UID}","entryId":"{ENTRY}","title":"Stats","thumbnailBase64":"/9j/4A==","keyboard":{{"productName":"Alpha","vendorId":1,"productId":2}},"fingerOverrides":{{}},"layoutComparisonInputs":null,"categories":["heatmap"]{extra}}}"#
        ))
    }

    fn linked_post_id(user_data: &Path) -> Option<String> {
        let index = std::fs::read_to_string(
            user_data.join(format!("sync/keyboards/{UID}/analyze_filters/index.json")),
        )
        .unwrap();
        let index = pipette_js_json::parse(&index).unwrap();
        let entries = index.as_object().unwrap().get("entries").unwrap();
        let Value::Array(entries) = entries else { panic!("entries") };
        let entry = entries
            .iter()
            .find(|entry| entry.as_object().unwrap().get("id").and_then(Value::as_str) == Some(ENTRY))
            .unwrap();
        entry.as_object().unwrap().get("hubPostId").and_then(Value::as_str).map(str::to_owned)
    }

    /// The app's cache is empty, so the export has no keystrokes: the
    /// upload sends it anyway (only the preview checks it) and the Hub
    /// refuses it. The scenarios of the handlers on a seeded cache are
    /// crates/pipette-hub's golden tests.
    #[tokio::test]
    async fn the_analyze_post_commands_build_the_export_and_send_it() {
        let user_data = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeHub::new());
        let app = app(user_data.path(), &fake);
        seed(&app, user_data.path()).await;
        let (hub, stores, analytics) =
            (app.state::<Arc<Hub>>(), app.state::<StoreContext>(), app.state::<Arc<TypingAnalytics>>());

        let preview = text(
            hub_preview_analytics_post(hub.clone(), stores.clone(), analytics.clone(), params(""))
                .await
                .unwrap(),
        );
        assert!(
            preview.starts_with(r#"{"success":true,"preview":{"totalKeystrokes":0,"rangeMs":3600000,"#),
            "{preview}"
        );
        assert!(
            preview.ends_with(r#""validation":{"ok":false,"reason":"keystrokes below threshold"}}}"#),
            "{preview}"
        );
        assert!(fake.requests().is_empty());

        let refused = r#"{"success":false,"error":"Hub analytics upload failed: 400 {\"ok\":false,\"error\":\"INVALID_PAYLOAD: keystrokes below threshold\"}"}"#;
        let uploaded = text(
            hub_upload_analytics_post(hub.clone(), stores.clone(), analytics.clone(), params(""))
                .await
                .unwrap(),
        );
        assert_eq!(uploaded, refused);
        let upload = fake.requests().into_iter().find(|request| request.path == "/api/files").unwrap();
        assert_eq!(upload.method.as_str(), "POST");
        assert_eq!(upload.account.as_deref(), Some("alice@example.com"));
        assert_eq!(linked_post_id(user_data.path()), None);

        fake.clear_requests();
        let updated = text(
            hub_update_analytics_post(
                hub.clone(),
                stores.clone(),
                analytics.clone(),
                params(r#","postId":"a b""#),
            )
            .await
            .unwrap(),
        );
        assert_eq!(updated, r#"{"success":false,"error":"Invalid post ID"}"#);
        let private = text(
            hub_upload_private_analytics_post(hub, stores, analytics, params(r#","expiresInDays":7"#))
                .await
                .unwrap(),
        );
        assert!(
            private.starts_with(r#"{"success":false,"error":"Hub private analytics upload failed: 400 "#),
            "{private}"
        );
        let sent: Vec<String> = fake.requests().iter().map(|request| request.path.clone()).collect();
        assert_eq!(sent, ["/api/private/files"]);
    }

    #[tokio::test]
    async fn a_missing_saved_filter_is_answered_before_the_hub() {
        let user_data = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeHub::new());
        let app = app(user_data.path(), &fake);
        let (hub, stores, analytics) =
            (app.state::<Arc<Hub>>(), app.state::<StoreContext>(), app.state::<Arc<TypingAnalytics>>());
        let uploaded = text(
            hub_upload_analytics_post(hub.clone(), stores.clone(), analytics.clone(), params(""))
                .await
                .unwrap(),
        );
        assert_eq!(uploaded, r#"{"success":false,"error":"Saved filter entry not found"}"#);
        let preview = text(hub_preview_analytics_post(hub, stores, analytics, None).await.unwrap());
        assert_eq!(
            preview,
            r#"{"success":true,"preview":{"totalKeystrokes":0,"rangeMs":0,"estimatedBytes":0,"validation":{"ok":false,"reason":"Invalid uid"}}}"#
        );
        assert!(fake.requests().is_empty());
    }

    #[tokio::test]
    async fn params_that_are_not_json_are_a_failed_answer() {
        let user_data = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeHub::new());
        let app = app(user_data.path(), &fake);
        let (hub, stores, analytics) =
            (app.state::<Arc<Hub>>(), app.state::<StoreContext>(), app.state::<Arc<TypingAnalytics>>());
        let answer =
            text(hub_upload_analytics_post(hub, stores, analytics, Some("{".to_owned())).await.unwrap());
        assert!(answer.starts_with(r#"{"success":false,"error":""#), "{answer}");
        assert!(fake.requests().is_empty());
    }
}
