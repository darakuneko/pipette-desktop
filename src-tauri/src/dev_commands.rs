// SPDX-License-Identifier: GPL-2.0-or-later
//! Development tools, compiled only with debug assertions: the virtual
//! keyboard controller (the Electron build exposes the same operations to
//! its E2E tests as `globalThis.__pipetteVirtualDevice`), a log sink, window
//! screenshots, and a script hook that runs a local file in the window after
//! each page load so the UI can be driven without a WebDriver.
//!
//! Their permissions are generated and granted only in these builds (see
//! build.rs and capabilities/dev/).

use pipette_hid::ControllerState;
use serde::Serialize;
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{Runtime, State, Webview};

use crate::hid_commands::Hid;

/// Path of a JavaScript file evaluated in the window after each page load.
const DEV_SCRIPT_ENV: &str = "PIPETTE_DEV_SCRIPT";

/// Directory the screenshots are written to.
#[cfg(target_os = "linux")]
const DEV_SHOT_DIR_ENV: &str = "PIPETTE_DEV_SHOT_DIR";

/// Same shape as `VirtualDeviceControllerState` in
/// src/main/virtual-device/index.ts.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerStateDto {
    open: bool,
    unlocked: bool,
    unlock_in_progress: bool,
    unlock_counter: i32,
}

impl From<ControllerState> for ControllerStateDto {
    fn from(s: ControllerState) -> Self {
        Self {
            open: s.open,
            unlocked: s.unlocked,
            unlock_in_progress: s.unlock_in_progress,
            unlock_counter: s.unlock_counter,
        }
    }
}

/// The unlock countdown length must be a non-negative `i32`: the virtual
/// device decrements the counter from this value, and a negative start
/// could underflow it.
fn unlock_counter_max(n: i64) -> Result<i32, String> {
    i32::try_from(n)
        .ok()
        .filter(|n| *n >= 0)
        .ok_or_else(|| format!("unlock counter max must be in 0..={}, got {n}", i32::MAX))
}

#[tauri::command]
pub fn virtual_device_press_key(hid: State<'_, Hid>, row: i32, col: i32) {
    hid.0.virtual_device().press_key(row, col);
}

#[tauri::command]
pub fn virtual_device_release_key(hid: State<'_, Hid>, row: i32, col: i32) {
    hid.0.virtual_device().release_key(row, col);
}

#[tauri::command]
pub fn virtual_device_release_all(hid: State<'_, Hid>) {
    hid.0.virtual_device().release_all();
}

#[tauri::command]
pub fn virtual_device_hold_keys(hid: State<'_, Hid>, pairs: Vec<(i32, i32)>) {
    hid.0.virtual_device().hold_keys(&pairs);
}

#[tauri::command]
pub fn virtual_device_set_unlock_counter_max(hid: State<'_, Hid>, n: i64) -> Result<(), String> {
    hid.0.virtual_device().set_unlock_counter_max(unlock_counter_max(n)?);
    Ok(())
}

#[tauri::command]
pub fn virtual_device_get_state(hid: State<'_, Hid>) -> ControllerStateDto {
    hid.0.virtual_device().get_state().into()
}

#[tauri::command]
pub fn virtual_device_reset(hid: State<'_, Hid>) {
    hid.0.virtual_device().reset();
}

/// Prints a line from the WebView to stderr; WebKitGTK does not forward the
/// console of the page to the terminal.
#[tauri::command]
pub fn dev_log(message: String) {
    eprintln!("[webview] {message}");
}

/// `<PIPETTE_DEV_SHOT_DIR>/<name>.png`. The name is limited to lowercase
/// letters, digits and dashes so it cannot leave the directory.
#[cfg(target_os = "linux")]
fn shot_path(name: &str) -> Result<std::path::PathBuf, String> {
    let valid = !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !valid {
        return Err(format!("invalid screenshot name: {name:?}"));
    }
    let dir = std::env::var_os(DEV_SHOT_DIR_ENV).ok_or_else(|| format!("{DEV_SHOT_DIR_ENV} is not set"))?;
    Ok(std::path::PathBuf::from(dir).join(format!("{name}.png")))
}

#[cfg(target_os = "linux")]
fn write_png(
    snapshot: Result<cairo::Surface, webkit2gtk::Error>,
    path: &std::path::Path,
) -> Result<(), String> {
    let surface = snapshot.map_err(|err| err.to_string())?;
    let image = cairo::ImageSurface::try_from(surface).map_err(|_| "snapshot is not an image surface")?;
    let mut file = std::fs::File::create(path).map_err(|err| err.to_string())?;
    image.write_to_png(&mut file).map_err(|err| err.to_string())
}

/// Saves the visible part of the page as rendered by WebKit. Capturing the
/// window from outside (an X11 grab on Xwayland, for one) can come back
/// blank, so the snapshot is taken from WebKit itself.
#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn dev_screenshot(window: tauri::WebviewWindow, name: String) -> Result<(), String> {
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

    let path = shot_path(&name)?;
    let (done, result) = std::sync::mpsc::channel();
    window
        .with_webview(move |platform| {
            platform.inner().snapshot(
                SnapshotRegion::Visible,
                SnapshotOptions::NONE,
                None::<&webkit2gtk::gio::Cancellable>,
                move |snapshot| {
                    // The receiver only goes away if the command was dropped.
                    let _ = done.send(write_png(snapshot, &path));
                },
            );
        })
        .map_err(|err| err.to_string())?;
    tauri::async_runtime::spawn_blocking(move || result.recv())
        .await
        .map_err(|err| err.to_string())?
        .map_err(|_| "the snapshot was cancelled".to_string())?
}

/// Evaluates the file named by `PIPETTE_DEV_SCRIPT`, if set, once the page
/// has loaded. The script runs as the page itself and reaches the commands
/// above through `window.__TAURI_INTERNALS__.invoke`.
pub fn run_dev_script<R: Runtime>(webview: &Webview<R>, payload: &PageLoadPayload<'_>) {
    if payload.event() != PageLoadEvent::Finished {
        return;
    }
    let Some(path) = std::env::var_os(DEV_SCRIPT_ENV) else {
        return;
    };
    match std::fs::read_to_string(&path) {
        Ok(script) => {
            if let Err(err) = webview.eval(script) {
                eprintln!("[dev] failed to evaluate {}: {err}", path.to_string_lossy());
            }
        }
        Err(err) => eprintln!("[dev] failed to read {}: {err}", path.to_string_lossy()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unlock_counter_max_accepts_non_negative_i32_values() {
        assert_eq!(unlock_counter_max(0), Ok(0));
        assert_eq!(unlock_counter_max(3), Ok(3));
        assert_eq!(unlock_counter_max(i64::from(i32::MAX)), Ok(i32::MAX));
    }

    #[test]
    fn unlock_counter_max_rejects_negative_and_out_of_range_values() {
        for bad in [-1, i64::from(i32::MIN), i64::from(i32::MAX) + 1] {
            assert!(unlock_counter_max(bad).is_err(), "{bad} was accepted");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shot_names_stay_inside_the_directory() {
        for bad in ["", "../x", "a/b", "A", "x.png", "a b"] {
            let err = super::shot_path(bad).unwrap_err();
            assert!(err.starts_with("invalid screenshot name"), "{bad}: {err}");
        }
    }

    #[test]
    fn controller_state_serializes_in_the_e2e_shape() {
        let state =
            ControllerState { open: true, unlocked: false, unlock_in_progress: true, unlock_counter: 3 };
        assert_eq!(
            serde_json::to_value(ControllerStateDto::from(state)).unwrap(),
            serde_json::json!({ "open": true, "unlocked": false, "unlockInProgress": true, "unlockCounter": 3 })
        );
    }
}
