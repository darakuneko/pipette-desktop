// SPDX-License-Identifier: GPL-2.0-or-later
//! The keymap snapshot commands of the shim's
//! `typingAnalytics{Save,GetKeymapSnapshotForRange,List}KeymapSnapshot*`
//! members (src/tauri-shim/api/typing-analytics-keymaps.ts), on this
//! device's snapshots (crates/pipette-typing-analytics, keymap_snapshots.rs).
//!
//! Each answers the handler's value as JSON text written by
//! `pipette_js_json`, so a snapshot file reaches the renderer with its keys
//! in their order and its number forms. The arguments arrive as any JSON
//! value and go through the handlers' own checks, so an argument of the
//! wrong type gets the handler's answer (nothing saved, null, none) rather
//! than a failed command. The snapshot to save arrives as the text of
//! `JSON.stringify(snapshot)`, which keeps its key order; text that is not
//! JSON fails the command.

use std::sync::Arc;

use pipette_js_json::Value;
use pipette_typing_analytics::TypingAnalytics;
use pipette_typing_analytics::keymap_snapshots::{
    save_snapshot_request, snapshot_for_range_request, snapshot_summaries_request,
};
use tauri::State;
use tauri::ipc::Response;

use crate::command_error::CommandError;

/// An argument as the handler gets it: an absent one is undefined, which
/// every check treats as null does.
fn arg(value: Option<serde_json::Value>) -> Value {
    value.and_then(|value| pipette_js_json::parse(&value.to_string()).ok()).unwrap_or(Value::Null)
}

/// Runs `io` on a blocking-task thread (file I/O, and the machine hash the
/// first time) and answers its value as JSON text.
async fn answer<F>(analytics: &State<'_, Arc<TypingAnalytics>>, io: F) -> Result<Response, CommandError>
where
    F: FnOnce(&TypingAnalytics) -> Result<Value, CommandError> + Send + 'static,
{
    let analytics = analytics.inner().clone();
    let value = tauri::async_runtime::spawn_blocking(move || io(&analytics)).await??;
    Ok(Response::new(pipette_js_json::stringify(&value)))
}

#[tauri::command]
pub async fn typing_analytics_save_keymap_snapshot(
    analytics: State<'_, Arc<TypingAnalytics>>,
    snapshot: Option<String>,
) -> Result<Response, CommandError> {
    let analytics = analytics.inner().clone();
    let answer = tauri::async_runtime::spawn_blocking(move || -> Result<String, CommandError> {
        let request = snapshot.as_deref().map(pipette_js_json::parse).transpose()?.unwrap_or(Value::Null);
        let now = analytics.now_ms();
        let saved = save_snapshot_request(analytics.user_data(), &request, || analytics.machine_hash(), now);
        Ok(saved.to_json())
    })
    .await??;
    Ok(Response::new(answer))
}

#[tauri::command]
pub async fn typing_analytics_get_keymap_snapshot_for_range(
    analytics: State<'_, Arc<TypingAnalytics>>,
    uid: Option<serde_json::Value>,
    from_ms: Option<serde_json::Value>,
    to_ms: Option<serde_json::Value>,
) -> Result<Response, CommandError> {
    let (uid, from_ms, to_ms) = (arg(uid), arg(from_ms), arg(to_ms));
    answer(&analytics, move |analytics| {
        Ok(snapshot_for_range_request(analytics.user_data(), &uid, &from_ms, &to_ms, || {
            analytics.machine_hash()
        })?)
    })
    .await
}

#[tauri::command]
pub async fn typing_analytics_list_keymap_snapshots(
    analytics: State<'_, Arc<TypingAnalytics>>,
    uid: Option<serde_json::Value>,
) -> Result<Response, CommandError> {
    let uid = arg(uid);
    answer(&analytics, move |analytics| {
        Ok(snapshot_summaries_request(analytics.user_data(), &uid, || analytics.machine_hash())?)
    })
    .await
}

#[cfg(test)]
mod tests {
    use tauri::Manager;
    use tauri::async_runtime::block_on;
    use tauri::ipc::{InvokeResponseBody, IpcResponse};
    use tempfile::TempDir;

    use super::*;

    const SNAPSHOT: &str = r#"{"uid":"0xA1","productName":"P","savedAt":1000,"layers":1,"matrix":{"rows":1,"cols":1},"keymap":[[["KC_A"]]],"layout":{"b":1,"a":2}}"#;

    fn app_on(user_data: &TempDir) -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        crate::analytics_commands::manage_with_machine_id(app.handle(), user_data.path(), "machine");
        app
    }

    fn text(response: Response) -> String {
        match response.body().unwrap() {
            InvokeResponseBody::Json(text) => text,
            InvokeResponseBody::Raw(_) => panic!("not JSON"),
        }
    }

    fn state(app: &tauri::App<tauri::test::MockRuntime>) -> State<'_, Arc<TypingAnalytics>> {
        app.state::<Arc<TypingAnalytics>>()
    }

    #[test]
    fn a_saved_snapshot_is_listed_and_picked_with_its_key_order() {
        let user_data = TempDir::new().unwrap();
        let app = app_on(&user_data);
        let saved =
            block_on(typing_analytics_save_keymap_snapshot(state(&app), Some(SNAPSHOT.into()))).unwrap();
        assert_eq!(text(saved), r#"{"saved":true,"savedAt":1000}"#);

        let uid = Some(serde_json::json!("0xA1"));
        let listed = block_on(typing_analytics_list_keymap_snapshots(state(&app), uid.clone())).unwrap();
        assert!(text(listed).starts_with(r#"[{"uid":"0xA1","machineHash":""#));
        let range = (Some(serde_json::json!(0)), Some(serde_json::json!(2000)));
        let picked =
            block_on(typing_analytics_get_keymap_snapshot_for_range(state(&app), uid, range.0, range.1));
        assert!(text(picked.unwrap()).ends_with(r#""keymap":[[["KC_A"]]],"layout":{"b":1,"a":2}}"#));
    }

    #[test]
    fn arguments_of_the_wrong_type_get_the_handlers_answers() {
        let user_data = TempDir::new().unwrap();
        let app = app_on(&user_data);
        let listed =
            block_on(typing_analytics_list_keymap_snapshots(state(&app), Some(serde_json::json!(5))));
        assert_eq!(text(listed.unwrap()), "[]");
        let picked = block_on(typing_analytics_get_keymap_snapshot_for_range(state(&app), None, None, None));
        assert_eq!(text(picked.unwrap()), "null");
        let saved = block_on(typing_analytics_save_keymap_snapshot(state(&app), None)).unwrap();
        assert_eq!(text(saved), r#"{"saved":false,"savedAt":null}"#);
        assert!(block_on(typing_analytics_save_keymap_snapshot(state(&app), Some("{".into()))).is_err());
        assert!(!user_data.path().join("typing-analytics").exists());
    }
}
