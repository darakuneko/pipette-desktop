// SPDX-License-Identifier: GPL-2.0-or-later
//! The app config commands behind the shim's `appConfigGetAll` and
//! `appConfigSet` (src/tauri-shim/api/app-config.ts), and what a change the
//! renderer makes does in this process, as the `onAppConfigChange`
//! listeners of src/main/index.ts do. The store itself is
//! crates/pipette-app-config.

use std::path::Path;
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
/// `trayResident` adds or removes the tray, `autoSync` starts or stops the
/// polling and the flush (sync_commands/triggers.rs), `autoLaunch`
/// registers or unregisters the app to start at sign-in (pipette-autostart,
/// which reaches the real entry only in a distributed build without
/// `PIPETTE_USER_DATA_DIR`). Then applies the stored `autoLaunch`, as the
/// Electron build does at every launch.
///
/// The listener runs under the store lock, once per set in the order the
/// sets were saved. The zoom, the tray and the sign-in changes are queued
/// to the main thread without waiting for it, so the main thread applies
/// them in that order and can read the store meanwhile without a deadlock;
/// the sync keeps the value it is told and never reads the store from here.
/// Called from the setup on the main thread, so the launch's `autoLaunch`
/// is applied before any change queued meanwhile, and reads the value
/// those changes saved.
pub fn listen_for_changes(app: &AppHandle) {
    let handle = app.clone();
    let user_data = app.state::<crate::UserDataDir>().0.clone();
    let launch_user_data = user_data.clone();
    app.state::<AppConfig>().subscribe(move |key, value| match key {
        "zoomFactor" => {
            let percent = clamp_zoom_factor(Some(value));
            for window in handle.webview_windows().values() {
                set_zoom(window, percent);
            }
        }
        "trayResident" => crate::tray::set_tray_resident(&handle, value.is_truthy()),
        "autoSync" => crate::sync_commands::triggers::on_auto_sync_changed(&handle, value.is_truthy()),
        "autoLaunch" => {
            let enabled = value.is_truthy();
            let user_data = user_data.clone();
            if let Err(err) = handle.run_on_main_thread(move || apply_auto_launch(enabled, &user_data)) {
                log::error!("[app-config] failed to apply autoLaunch: {err}");
            }
        }
        _ => {}
    });
    match app.state::<AppConfig>().get("autoLaunch") {
        Ok(stored) => apply_auto_launch(stored.is_some_and(|value| value.is_truthy()), &launch_user_data),
        // Not taken as off: that would remove the entry over a read error.
        Err(err) => log::error!("[app-config] failed to read autoLaunch: {err}"),
    }
}

/// Registers the app to start at sign-in, or unregisters it. Only a
/// distributed build counts as packaged (the same build that takes the
/// Electron build's userData directory over); only a build with the
/// development tools reads `PIPETTE_DEV_AUTOSTART_DIR`, which must be
/// inside `user_data`.
fn apply_auto_launch(enabled: bool, user_data: &Path) {
    let env = pipette_autostart::Environment::of_process(
        crate::distributed_build(),
        cfg!(feature = "dev-tools"),
        user_data,
    );
    pipette_autostart::apply(enabled, &env);
}
