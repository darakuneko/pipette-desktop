// SPDX-License-Identifier: GPL-2.0-or-later
//! The recording commands of the shim's `typingAnalyticsEvent` and
//! `typingAnalyticsFlush` members (src/tauri-shim/api/typing-analytics-record.ts),
//! on the recorder of crates/pipette-typing-analytics (pipeline/), and what
//! the recorder takes from the app: the pending sync units it records its
//! changed days in, the debounce timer on the async runtime, and the
//! application in focus when Monitor App is on.
//!
//! The renderer sends the events one after another, each after the last
//! one's answer, so the recorder takes them in the order they were typed.
//! An event that is not valid is ignored and a flush for an argument that
//! is not a keyboard uid does nothing, as the Electron handlers do.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use pipette_active_window::ActiveWindow;
use pipette_entry_store::RandomUuid;
use pipette_js_json::{JsString, Value};
use pipette_typing_analytics::fingerprint::OsInfo;
use pipette_typing_analytics::{FlushTimer, Recorder, RecorderDeps};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::app_config::AppConfig;
use crate::command_error::CommandError;
use crate::shutdown::QuitPhase;

/// The app config key of Monitor App.
const MONITOR_APP_KEY: &str = "typingMonitorAppEnabled";

/// Runs the debounced flush on the async runtime.
struct RuntimeTimer;

impl FlushTimer for RuntimeTimer {
    fn schedule(&self, delay: Duration, task: Box<dyn FnOnce() + Send>) {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            task();
        });
    }
}

/// What the recorder of `app` takes from it. The sync it reports changed
/// days to (sync_commands/triggers.rs) and the app config are looked up
/// when used, so the recorder can be built before either is managed.
pub(super) fn recorder_deps<R: Runtime>(app: &AppHandle<R>) -> RecorderDeps {
    let sync = app.clone();
    RecorderDeps {
        ids: Arc::new(RandomUuid),
        os: OsInfo::current(),
        timer: Arc::new(RuntimeTimer),
        notify: Arc::new(move |unit| crate::sync_commands::triggers::notify_change(&sync, unit)),
        app_name: app_name_source(app.clone()),
    }
}

/// `getCurrentAppName`: `None` unless Monitor App is on. One lookup is kept
/// for the app's lifetime, so it warns about a failing OS lookup once.
fn app_name_source<R: Runtime>(app: AppHandle<R>) -> Arc<dyn Fn() -> Option<JsString> + Send + Sync> {
    let window = Mutex::new(ActiveWindow::for_current_os());
    Arc::new(move || {
        let config = app.try_state::<AppConfig>()?;
        match config.get(MONITOR_APP_KEY) {
            Ok(Some(enabled)) if enabled.is_truthy() => {}
            Ok(_) => return None,
            Err(err) => {
                log::warn!("typing-analytics app-name tag failed: {err}");
                return None;
            }
        }
        window.lock().unwrap_or_else(PoisonError::into_inner).app_name()
    })
}

/// The recorder of `analytics`, its flush chain on the app's runtime.
pub(super) fn recorder<R: Runtime>(
    app: &AppHandle<R>,
    analytics: Arc<pipette_typing_analytics::TypingAnalytics>,
) -> Arc<Recorder> {
    Recorder::new(analytics, recorder_deps(app), tauri::async_runtime::handle().inner())
}

/// The quit sequence's preSyncFinalizers phase: when anything is buffered,
/// queued or being written, closes every session and writes everything
/// (`flushTypingAnalyticsBeforeQuit`), before the pending sync units are
/// written so the days it announces go with them. The flush is queued on
/// the recorder's chain, so a deadline that drops this phase does not cut
/// it short. `then` is how long the phase waits afterwards.
pub fn quit_phase(recorder: Arc<Recorder>, name: &'static str, then: Duration) -> QuitPhase {
    QuitPhase::new(name, async move {
        if recorder.has_pending_work() {
            recorder.flush_before_quit().await;
        }
        tokio::time::sleep(then).await;
    })
}

/// An argument as the handler gets it; an absent one is undefined.
fn arg(value: Option<serde_json::Value>) -> Value {
    value.and_then(|value| pipette_js_json::parse(&value.to_string()).ok()).unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn typing_analytics_event(
    recorder: State<'_, Arc<Recorder>>,
    event: Option<serde_json::Value>,
) -> Result<(), CommandError> {
    Ok(recorder.ingest(&arg(event)).await?)
}

#[tauri::command]
pub async fn typing_analytics_flush(
    recorder: State<'_, Arc<Recorder>>,
    uid: Option<serde_json::Value>,
) -> Result<(), CommandError> {
    if let Some(uid) = uid.as_ref().and_then(serde_json::Value::as_str).filter(|uid| !uid.is_empty()) {
        recorder.flush_for_uid(uid).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use pipette_sync_pending::PendingStore;
    use serde_json::json;
    use tauri::async_runtime::block_on;
    use tempfile::TempDir;

    use super::*;
    use crate::analytics_commands::{manage_with_machine_id, mark_cache_fresh};

    fn app(user_data: &TempDir) -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        crate::store_commands::sync_pending::manage_without_delayed_writes(app.handle(), user_data.path());
        mark_cache_fresh(user_data.path(), "machine");
        manage_with_machine_id(app.handle(), user_data.path(), "machine");
        app
    }

    fn event(uid: &str) -> serde_json::Value {
        json!({ "kind": "char", "key": "a", "ts": 1_776_168_000_000_i64,
            "keyboard": { "uid": uid, "vendorId": 1, "productId": 2, "productName": "K" } })
    }

    #[test]
    fn records_an_event_and_writes_it_on_flush_into_the_pending_units() {
        let user_data = TempDir::new().unwrap();
        let app = app(&user_data);
        let recorder = || app.state::<Arc<Recorder>>();
        block_on(typing_analytics_event(recorder(), Some(event("0xA1")))).unwrap();
        block_on(typing_analytics_event(recorder(), Some(json!({ "kind": "char" })))).unwrap();
        block_on(typing_analytics_event(recorder(), None)).unwrap();
        assert!(recorder().has_pending_work());

        block_on(typing_analytics_flush(recorder(), Some(json!(7)))).unwrap();
        block_on(typing_analytics_flush(recorder(), Some(json!("")))).unwrap();
        block_on(typing_analytics_flush(recorder(), None)).unwrap();
        assert!(recorder().has_pending_work());

        block_on(typing_analytics_flush(recorder(), Some(json!("0xA1")))).unwrap();
        assert!(!recorder().has_pending_work());
        assert!(app.state::<PendingStore>().has_pending_changes());
        let devices = user_data.path().join("sync/keyboards/0xA1/devices");
        let hashes: Vec<_> = std::fs::read_dir(devices).unwrap().collect();
        assert_eq!(hashes.len(), 1);
    }

    #[test]
    fn monitor_app_off_or_without_a_config_names_no_application() {
        let user_data = TempDir::new().unwrap();
        let app = tauri::test::mock_app();
        let source = app_name_source(app.handle().clone());
        assert_eq!(source(), None);
        let config: AppConfig = Arc::new(pipette_app_config::AppConfigStore::open(user_data.path()));
        config.set(MONITOR_APP_KEY, Value::Bool(false)).unwrap();
        app.manage(config);
        assert_eq!(source(), None);
    }
}
