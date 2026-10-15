// SPDX-License-Identifier: GPL-2.0-or-later
//! The app config commands behind the shim's `appConfigGetAll` and
//! `appConfigSet` (src/tauri-shim/api/app-config.ts), and what a change the
//! renderer makes does in this process, as the `onAppConfigChange`
//! listeners of src/main/index.ts do. The store itself is
//! crates/pipette-app-config.

use std::sync::Arc;

use pipette_app_config::{AppConfigStore, Value, clamp_zoom_factor};
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};

use crate::command_error::CommandError;

/// The process-wide store, shared with the blocking I/O tasks.
pub type AppConfig = Arc<AppConfigStore>;

/// Runs `io` on a blocking-task thread: reads and writes (with an fsync) stay
/// off the UI thread and the async runtime.
async fn blocking<T, F>(config: &State<'_, AppConfig>, io: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce(&AppConfigStore) -> Result<T, pipette_app_config::AppConfigError> + Send + 'static,
{
    let store = Arc::clone(config);
    Ok(tauri::async_runtime::spawn_blocking(move || io(&store)).await??)
}

/// The whole config, as JSON text the WebView parses: the bytes of
/// `JSON.stringify`, so the renderer gets the object the Electron build
/// sends, key order and all.
#[tauri::command]
pub async fn app_config_get_all(config: State<'_, AppConfig>) -> Result<Response, CommandError> {
    let text =
        blocking(&config, |store| store.get_all().map(|all| pipette_js_json::stringify(&Value::Object(all))))
            .await?;
    Ok(Response::new(text))
}

/// `value` is the renderer's `JSON.stringify(value)`, absent for
/// `undefined`. A key the renderer may not set is ignored.
#[tauri::command]
pub async fn app_config_set(
    config: State<'_, AppConfig>,
    key: String,
    value: Option<String>,
) -> Result<(), CommandError> {
    blocking(&config, move |store| store.set_from_renderer(&key, value.as_deref())).await
}

/// Applies the stored zoom factor to `window`, as the Electron build does
/// when it creates the window.
pub fn apply_stored_zoom<R: Runtime>(store: &AppConfigStore, window: &WebviewWindow<R>) {
    let zoom = store.get("zoomFactor").unwrap_or_else(|err| {
        log::error!("[app-config] failed to read zoomFactor: {err}");
        None
    });
    set_zoom(window, clamp_zoom_factor(zoom.as_ref()));
}

/// Zooms `window` to `percent` percent.
pub(crate) fn set_zoom<R: Runtime>(window: &WebviewWindow<R>, percent: f64) {
    if let Err(err) = window.set_zoom(percent / 100.0) {
        log::error!("[app-config] failed to set the zoom factor: {err}");
    }
}

/// Reacts to the renderer's changes: `zoomFactor` zooms every window,
/// `trayResident` adds or removes the tray. `autoLaunch` has nothing to
/// apply to: this build does not register itself to start at sign-in.
///
/// The listener runs under the store lock, once per set in the order the
/// sets were saved. The zoom and the tray change are queued to the main
/// thread without waiting for it, so the main thread applies them in that
/// order and can read the store meanwhile without a deadlock.
pub fn listen_for_changes(app: &AppHandle) {
    let handle = app.clone();
    app.state::<AppConfig>().subscribe(move |key, value| match key {
        "zoomFactor" => {
            let percent = clamp_zoom_factor(Some(value));
            for window in handle.webview_windows().values() {
                set_zoom(window, percent);
            }
        }
        "trayResident" => crate::lifecycle::set_tray_resident(&handle, value.is_truthy()),
        "autoLaunch" => {
            log::info!(
                "[app-config] autoLaunch is now {}; this build does not start at sign-in",
                value.is_truthy()
            );
        }
        _ => {}
    });
}
