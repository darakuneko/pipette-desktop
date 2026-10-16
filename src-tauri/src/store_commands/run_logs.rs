// SPDX-License-Identifier: GPL-2.0-or-later
//! The run log commands of the shim's `typingRunLog*` members
//! (src/tauri-shim/api/run-logs.ts), on the run log store of
//! crates/pipette-keyboard-stores (managed by store_commands/keyboard_data.rs).
//!
//! Each answers the handler's `{success, …}` object as JSON text written by
//! `pipette_js_json`. A failure of the store is such an answer too; a
//! command fails only when its task cannot run or the log it is sent is not
//! JSON text.

use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::{RunLogError, StoreContext, field};
use tauri::State;
use tauri::ipc::Response;

use super::answer;
use crate::app_config::AppConfig;
use crate::command_error::CommandError;

/// What a store operation answers besides `success`.
type Answer = Result<Object, RunLogError>;

/// The app config key of the recording consent a save needs.
const CONSENT_KEY: &str = "typingRecordingConsentAccepted";

/// Whether the user accepted the recording consent; a config that cannot
/// be read counts as no.
fn consent_accepted(config: &AppConfig) -> bool {
    matches!(config.get(CONSENT_KEY), Ok(Some(Value::Bool(true))))
}

/// `log` is the text of `JSON.stringify(log)`, read as `JSON.parse` would,
/// so the body keeps the log's key order and number forms; no text is no
/// log. The consent is read when the save runs, as the handler reads it.
#[tauri::command]
pub async fn typing_run_log_save(
    stores: State<'_, StoreContext>,
    config: State<'_, AppConfig>,
    uid: String,
    log: Option<String>,
) -> Result<Response, CommandError> {
    let log = log.as_deref().map(pipette_js_json::parse).transpose()?;
    let config = config.inner().clone();
    answer(&stores, move |stores| -> Answer {
        let entry =
            pipette_keyboard_stores::save_run_log(stores, &uid, log.as_ref(), consent_accepted(&config))?;
        Ok(field("entry", entry))
    })
    .await
}

#[tauri::command]
pub async fn typing_run_log_list(
    stores: State<'_, StoreContext>,
    uid: String,
) -> Result<Response, CommandError> {
    answer(&stores, move |stores| -> Answer {
        let entries = pipette_keyboard_stores::list_run_logs(stores, &uid)?;
        Ok(field("entries", Value::Array(entries.into_iter().map(Value::from).collect())))
    })
    .await
}

#[tauri::command]
pub async fn typing_run_log_get(
    stores: State<'_, StoreContext>,
    uid: String,
    run_id: String,
) -> Result<Response, CommandError> {
    answer(&stores, move |stores| -> Answer {
        let data = pipette_keyboard_stores::get_run_log(stores, &uid, &run_id)?;
        Ok(field("data", data))
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use pipette_app_config::AppConfigStore;
    use pipette_keyboard_stores::run_logs_sync_unit;
    use pipette_sync_pending::PendingStore;
    use tauri::Manager;
    use tauri::async_runtime::block_on;
    use tempfile::TempDir;

    use super::*;

    const LOG: &str = r#"{"runId":"run-1","uid":"0xA1","startedAt":"2026-01-01T00:00:00.000Z","durationMs":1,"mode":"words","language":"english","words":[]}"#;

    fn app_on(user_data: &TempDir) -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        crate::store_commands::sync_pending::manage_without_delayed_writes(app.handle(), user_data.path());
        crate::store_commands::keyboard_data::manage(app.handle(), user_data.path());
        let config: AppConfig = Arc::new(AppConfigStore::open(user_data.path()));
        app.manage(config);
        app
    }

    fn save(app: &tauri::App<tauri::test::MockRuntime>, log: Option<&str>) -> Result<Response, CommandError> {
        block_on(typing_run_log_save(
            app.state::<StoreContext>(),
            app.state::<AppConfig>(),
            "0xA1".into(),
            log.map(str::to_owned),
        ))
    }

    fn saved(app: &tauri::App<tauri::test::MockRuntime>) -> usize {
        pipette_keyboard_stores::list_run_logs(&app.state::<StoreContext>(), "0xA1").unwrap().len()
    }

    #[test]
    fn a_save_reads_the_consent_from_the_app_config_and_marks_its_unit_as_pending() {
        let user_data = TempDir::new().unwrap();
        let app = app_on(&user_data);
        assert!(!consent_accepted(&app.state::<AppConfig>()));
        save(&app, Some(LOG)).unwrap();
        assert_eq!(saved(&app), 0);

        app.state::<AppConfig>().set(CONSENT_KEY, Value::Bool(true)).unwrap();
        assert!(consent_accepted(&app.state::<AppConfig>()));
        save(&app, Some(LOG)).unwrap();
        assert_eq!(saved(&app), 1);
        let pending = app.state::<PendingStore>();
        assert_ne!(pending.pending_generation_of(&run_logs_sync_unit("0xA1")), 0);
    }

    #[test]
    fn text_that_is_not_json_fails_the_command() {
        let user_data = TempDir::new().unwrap();
        let app = app_on(&user_data);
        app.state::<AppConfig>().set(CONSENT_KEY, Value::Bool(true)).unwrap();
        assert!(save(&app, None).is_ok());
        assert!(save(&app, Some("{")).is_err());
        assert_eq!(saved(&app), 0);
    }
}
