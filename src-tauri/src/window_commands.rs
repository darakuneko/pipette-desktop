// SPDX-License-Identifier: GPL-2.0-or-later
//! The window commands behind the shim's window members
//! (src/tauri-shim/api/window.ts): the zoom and the main window's
//! visibility, and the Typing Test's view-only window (compact mode, aspect
//! ratio, always on top, opacity, minimum size), which src/window_ops/
//! carries out.

use pipette_app_config::{Value, clamp_zoom_factor};
use tauri::{AppHandle, Runtime, WebviewWindow};

use crate::main_window;
use crate::window_bounds::Size;
use crate::window_ops::{self, WindowSize};

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

/// The size of compact mode the renderer sent: an object whose width and
/// height are numbers. Anything else resizes nothing, as a size whose sides
/// are not both positive does not.
fn parse_compact_size(value: Option<&serde_json::Value>) -> Option<Size> {
    let object = value?.as_object()?;
    let side = |key: &str| object.get(key).and_then(serde_json::Value::as_f64);
    Some(Size { width: side("width")?, height: side("height")? })
}

/// Enters compact mode, at `compactSize` (the content size) when given, or
/// leaves it; leaving answers the size before it.
#[tauri::command]
pub async fn set_window_compact_mode<R: Runtime>(
    window: WebviewWindow<R>,
    enabled: bool,
    compact_size: Option<serde_json::Value>,
) -> Option<WindowSize> {
    let window = window.as_ref().window();
    window_ops::set_compact_mode(&window, enabled, parse_compact_size(compact_size.as_ref())).await
}

/// Keeps the window's content at `ratio` (width / height); a ratio of 0 or
/// less releases it.
#[tauri::command]
pub fn set_window_aspect_ratio<R: Runtime>(window: WebviewWindow<R>, ratio: f64) {
    window_ops::set_aspect_ratio(&window.as_ref().window(), ratio);
}

#[tauri::command]
pub fn set_window_always_on_top<R: Runtime>(window: WebviewWindow<R>, enabled: bool) {
    window_ops::set_always_on_top(&window.as_ref().window(), enabled);
}

/// Sets the opacity, clamped as `clampViewOnlyOpacity` does; anything but a
/// number is the default.
#[tauri::command]
pub fn set_window_opacity<R: Runtime>(window: WebviewWindow<R>, opacity: Option<serde_json::Value>) {
    window_ops::opacity::set_opacity(&window.as_ref().window(), &opacity.unwrap_or_default());
}

/// Sets the minimum size, each side at least 1.
#[tauri::command]
pub fn set_window_min_size<R: Runtime>(window: WebviewWindow<R>, width: f64, height: f64) {
    window_ops::set_min_size(&window.as_ref().window(), width, height);
}

/// Whether the session lets a window stay on top.
#[tauri::command]
pub fn is_always_on_top_supported() -> bool {
    window_ops::always_on_top::is_supported_here()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_compact_size_is_an_object_of_two_numbers() {
        assert_eq!(
            parse_compact_size(Some(&json!({ "width": 400, "height": 120.5 }))),
            Some(Size { width: 400.0, height: 120.5 })
        );
        assert_eq!(
            parse_compact_size(Some(&json!({ "width": 0, "height": -1 }))),
            Some(Size { width: 0.0, height: -1.0 })
        );
        for value in
            [json!(null), json!(400), json!({ "width": 400 }), json!({ "width": "400", "height": 120 })]
        {
            assert_eq!(parse_compact_size(Some(&value)), None, "{value}");
        }
        assert_eq!(parse_compact_size(None), None);
    }
}
