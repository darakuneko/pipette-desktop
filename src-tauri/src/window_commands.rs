// SPDX-License-Identifier: GPL-2.0-or-later
//! The window commands behind the shim's window members
//! (src/tauri-shim/api/window.ts): the WINDOW_* IPC handlers of
//! src/main/index.ts for the zoom and the main window's visibility, and
//! those of its `setupWindowIpc` for the Typing Test's view-only window
//! (compact mode, aspect ratio, always on top, opacity, minimum size),
//! which this build does not apply yet: each logs that and answers as a
//! window that cannot be changed.

use pipette_app_config::{Value, clamp_zoom_factor};
use tauri::{AppHandle, Runtime, WebviewWindow};

use crate::main_window;

/// Zooms the calling window to `zoom` percent, clamped as
/// `clampZoomFactor` does; the default zoom for anything but a number.
#[tauri::command]
pub fn set_window_zoom<R: Runtime>(window: WebviewWindow<R>, zoom: Option<serde_json::Value>) {
    let zoom = zoom.as_ref().and_then(serde_json::Value::as_f64).map(Value::Number);
    crate::app_config::set_zoom(&window, clamp_zoom_factor(zoom.as_ref()));
}

/// Shows the main window; whether it was hidden before. False without one.
#[tauri::command]
pub fn window_show<R: Runtime>(app: AppHandle<R>) -> bool {
    main_window::main_window(&app).is_some_and(|window| main_window::reveal(&window))
}

/// Hides the main window, but only while the tray icon is there to show it
/// again.
#[tauri::command]
pub fn window_hide<R: Runtime>(app: AppHandle<R>) {
    if !crate::tray::is_tray_active(&app) {
        return;
    }
    if let Some(window) = main_window::main_window(&app) {
        main_window::conceal(&window);
    }
}

/// Whether this launch opened the main window hidden.
#[tauri::command]
pub fn window_started_hidden<R: Runtime>(app: AppHandle<R>) -> bool {
    main_window::started_hidden(&app)
}

#[tauri::command]
pub fn window_is_visible<R: Runtime>(app: AppHandle<R>) -> bool {
    main_window::main_window(&app).is_some_and(|window| main_window::is_visible(&window))
}

/// Logs that the window member `member` changes nothing in this build.
fn not_implemented(member: &str) {
    log::warn!("[window] {member} is not implemented");
}

/// Leaves the window as it is; the size before compact mode, as the exit
/// from compact mode answers, is unknown, so null either way.
#[tauri::command]
pub fn set_window_compact_mode(
    enabled: Option<serde_json::Value>,
    compact_size: Option<serde_json::Value>,
) -> Option<serde_json::Value> {
    drop((enabled, compact_size));
    not_implemented("setWindowCompactMode");
    None
}

#[tauri::command]
pub fn set_window_aspect_ratio(ratio: Option<serde_json::Value>) {
    drop(ratio);
    not_implemented("setWindowAspectRatio");
}

#[tauri::command]
pub fn set_window_always_on_top(enabled: Option<serde_json::Value>) {
    drop(enabled);
    not_implemented("setWindowAlwaysOnTop");
}

#[tauri::command]
pub fn set_window_opacity(opacity: Option<serde_json::Value>) {
    drop(opacity);
    not_implemented("setWindowOpacity");
}

#[tauri::command]
pub fn set_window_min_size(width: Option<serde_json::Value>, height: Option<serde_json::Value>) {
    drop((width, height));
    not_implemented("setWindowMinSize");
}

/// False: this build cannot keep the window on top.
#[tauri::command]
pub fn is_always_on_top_supported() -> bool {
    false
}
