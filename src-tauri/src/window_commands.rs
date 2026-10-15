// SPDX-License-Identifier: GPL-2.0-or-later
//! The window commands behind the shim's window members
//! (src/tauri-shim/api/window.ts): the WINDOW_* IPC handlers of
//! src/main/index.ts for the zoom and the main window's visibility.

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
    if !crate::lifecycle::is_tray_active(&app) {
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
