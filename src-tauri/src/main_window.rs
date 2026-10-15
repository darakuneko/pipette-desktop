// SPDX-License-Identifier: GPL-2.0-or-later
//! The app's one window. `main_window_builder` is the single place it is
//! configured: the app opens it through `open_main_window`, and the IPC
//! contract tests (ipc_contract.rs) build their windows with it too.
//!
//! It opens as the Electron build's `createWindow` (src/main/index.ts) opens
//! it: hidden, at the saved size and position fitted into a display's work
//! area, with the minimum size that display allows, zoomed, then shown,
//! unless the launch starts in the tray. Its bounds are saved as
//! `windowState` when it closes and when the app exits.
//!
//! Sizes and positions are kept in device-independent pixels (DIP), as the
//! Electron build keeps them: a monitor or window rectangle is converted
//! from physical pixels with its own scale factor. That is the logical
//! coordinate space of Tauri itself, so the builder takes the stored values
//! as they are. On Linux (X11, one scale for every monitor) and macOS this
//! is the Electron space exactly; on Windows with monitors of different
//! scales, a monitor's origin in it can differ from Chromium's, so a
//! position saved by one build can open elsewhere, or centered, in the
//! other. The saved size is the size inside the window frame, which is also
//! what the builder sets, so a window keeps its size from launch to launch.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};

use pipette_app_config::{AppConfigStore, Object, Value};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Monitor, Runtime, WebviewWindow, WebviewWindowBuilder, Window,
};

use crate::navigation;
use crate::window_bounds::{MIN_SIZE, Size, effective_min_size};
use crate::window_state::{self, Display};

/// The label of the main window, the only window the capabilities grant the
/// commands to.
pub const MAIN_WINDOW: &str = "main";

/// The event telling the renderer the main window was shown (`true`) or
/// hidden (`false`): `IpcChannels.WINDOW_VISIBILITY_CHANGED` of
/// src/shared/ipc/channels.ts, which `onWindowVisibilityChanged`
/// (src/tauri-shim/api/window.ts) listens to.
pub const VISIBILITY_CHANGED: &str = "window:visibility-changed";

/// What the window commands and handlers keep about the main window.
#[derive(Default)]
pub struct MainWindowState {
    /// Whether this launch opened the window hidden. Fixed at startup; it
    /// does not follow the window's visibility.
    started_hidden: AtomicBool,
    /// The minimum size last applied, so moves within one display do not
    /// apply it again.
    min_size: Mutex<Option<Size>>,
}

impl MainWindowState {
    pub fn started_hidden(&self) -> bool {
        self.started_hidden.load(Ordering::Acquire)
    }
}

/// The builder of the main window: its entry in tauri.conf.json (which has
/// `create: false`, so Tauri leaves the window to this), held to the app's
/// own pages.
pub fn main_window_builder<R: Runtime, M: Manager<R>>(
    manager: &M,
) -> Result<WebviewWindowBuilder<'_, R, M>, Box<dyn std::error::Error>> {
    let config = manager
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .ok_or("tauri.conf.json has no main window")?;
    let builder = WebviewWindowBuilder::from_config(manager, config)?;
    Ok(navigation::guard(builder, navigation::dev_url(manager.config())))
}

/// Opens the main window, and manages [`MainWindowState`]. The window starts
/// hidden when the config's `startInTray` and `trayResident` are both on
/// (`Boolean()` of each, as the Electron build reads them): the tray, set up
/// from the same `trayResident`, is then the way to show it.
pub fn open_main_window<R: Runtime>(
    app: &AppHandle<R>,
    config: &AppConfigStore,
) -> Result<WebviewWindow<R>, Box<dyn std::error::Error>> {
    let stored = config.get_all().unwrap_or_else(|err| {
        log::error!("[window] failed to read the app config: {err}");
        Object::new()
    });
    let (displays, primary) = displays(app);
    let bounds: Vec<_> = displays.iter().map(|display| display.bounds).collect();
    let saved = window_state::load_window_state(stored.get("windowState"), &bounds);
    let placement = window_state::place(saved, &displays, primary);
    let truthy = |key| stored.get(key).is_some_and(Value::is_truthy);
    let start_hidden = truthy("startInTray") && truthy("trayResident");

    let Size { width: min_width, height: min_height } = placement.min_size;
    let builder = main_window_builder(app)?
        .visible(false)
        .inner_size(placement.bounds.width, placement.bounds.height)
        .min_inner_size(min_width, min_height);
    let builder = if placement.positioned {
        builder.position(placement.bounds.x, placement.bounds.y)
    } else {
        builder.center()
    };
    let window = builder.build()?;
    let state = MainWindowState {
        started_hidden: AtomicBool::new(start_hidden),
        min_size: Mutex::new(Some(placement.min_size)),
    };
    app.manage(state);
    crate::app_config::apply_stored_zoom(config, &window);
    if !start_hidden {
        reveal(&window.as_ref().window());
    }
    Ok(window)
}

/// The config value of `key`; none when the file cannot be read, which is
/// logged.
fn read(config: &AppConfigStore, key: &str) -> Option<Value> {
    config.get(key).unwrap_or_else(|err| {
        log::error!("[window] failed to read {key}: {err}");
        None
    })
}

/// The monitors in DIP, and which of them is the primary one.
fn displays<R: Runtime>(app: &AppHandle<R>) -> (Vec<Display>, Option<usize>) {
    let monitors = app.available_monitors().unwrap_or_else(|err| {
        log::error!("[window] failed to list the monitors: {err}");
        Vec::new()
    });
    let primary = app.primary_monitor().ok().flatten().and_then(|primary| {
        monitors
            .iter()
            .position(|monitor| monitor.position() == primary.position() && monitor.size() == primary.size())
    });
    (monitors.iter().map(display).collect(), primary)
}

fn display(monitor: &Monitor) -> Display {
    let scale = monitor.scale_factor();
    let (position, size) = (monitor.position(), monitor.size());
    let work_area = monitor.work_area();
    Display {
        bounds: window_state::to_dip(
            position.x.into(),
            position.y.into(),
            size.width.into(),
            size.height.into(),
            scale,
        ),
        work_area: window_state::to_dip(
            work_area.position.x.into(),
            work_area.position.y.into(),
            work_area.size.width.into(),
            work_area.size.height.into(),
            scale,
        ),
    }
}

/// Saves the bounds of `window` as `windowState`, as `saveWindowState` does:
/// directly, without telling the config listeners, and a failure is only
/// logged. A minimized window keeps the state saved before: where a
/// minimized window reports a position (off-screen, on Windows), it is not
/// one to open at.
pub fn save_window_state<R: Runtime>(window: &Window<R>, config: &AppConfigStore) {
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let bounds = window.scale_factor().and_then(|scale| {
        let position = window.outer_position()?;
        let size = window.inner_size()?;
        Ok(window_state::to_dip(
            position.x.into(),
            position.y.into(),
            size.width.into(),
            size.height.into(),
            scale,
        ))
    });
    let current = match bounds {
        Ok(current) => current,
        Err(err) => {
            log::error!("[window] failed to read the window bounds: {err}");
            return;
        }
    };
    let position_known = position_known(window);
    let previous = if position_known { None } else { read(config, "windowState") };
    let state = window_state::state_to_save(current, position_known, previous.as_ref());
    if let Err(err) = config.set("windowState", window_state::to_value(state)) {
        log::error!("[window] failed to save the window state: {err}");
    }
}

/// The main window, while it is open.
pub fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<Window<R>> {
    app.get_webview_window(MAIN_WINDOW).map(|window| window.as_ref().window())
}

/// Saves the main window's state if the window is still open.
pub fn save_main_window_state<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = main_window(app) {
        save_window_state(&window, &app.state::<crate::app_config::AppConfig>());
    }
}

/// Whether the window system lets a window read its own position: not on
/// Wayland, where the window then also opens where the compositor puts it.
#[cfg(target_os = "linux")]
fn position_known<R: Runtime>(window: &Window<R>) -> bool {
    use gtk::gdk::prelude::DisplayExtManual;
    use gtk::prelude::WidgetExt;
    match window.gtk_window() {
        Ok(gtk_window) => !gtk_window.display().backend().is_wayland(),
        Err(err) => {
            log::error!("[window] failed to get the GTK window: {err}");
            true
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn position_known<R: Runtime>(_window: &Window<R>) -> bool {
    true
}

/// Applies the minimum size the window's display allows, when it is not the
/// one applied last: after the window moves, maybe onto another display.
pub fn update_min_size<R: Runtime>(window: &Window<R>) {
    let Some(state) = window.try_state::<MainWindowState>() else {
        return;
    };
    let monitor = match window.current_monitor() {
        Ok(Some(monitor)) => monitor,
        Ok(None) => return,
        Err(err) => {
            log::error!("[window] failed to get the window's monitor: {err}");
            return;
        }
    };
    let min_size = effective_min_size(display(&monitor).work_area.size(), MIN_SIZE.width, MIN_SIZE.height);
    let mut applied = state.min_size.lock().unwrap_or_else(PoisonError::into_inner);
    if *applied == Some(min_size) {
        return;
    }
    match window.set_min_size(Some(LogicalSize::new(min_size.width, min_size.height))) {
        Ok(()) => *applied = Some(min_size),
        Err(err) => log::error!("[window] failed to set the minimum size: {err}"),
    }
}

/// Restores, shows and focuses `window`, as `showWindow` of
/// src/main/app-behavior.ts does. Whether it was hidden before.
pub fn reveal<R: Runtime>(window: &Window<R>) -> bool {
    let was_visible = window.is_visible().unwrap_or(false);
    let result = window.unminimize().and_then(|()| window.show()).and_then(|()| window.set_focus());
    if let Err(err) = result {
        log::error!("[window] failed to show the main window: {err}");
    }
    if !was_visible {
        notify_visibility(window, true);
    }
    !was_visible
}

/// Hides `window`.
pub fn conceal<R: Runtime>(window: &Window<R>) {
    let was_visible = window.is_visible().unwrap_or(true);
    if let Err(err) = window.hide() {
        log::error!("[window] failed to hide the main window: {err}");
        return;
    }
    if was_visible {
        notify_visibility(window, false);
    }
}

/// The Electron window's `show` / `hide` events, pushed to the renderer:
/// `document.visibilityState` does not follow a window that starts hidden.
fn notify_visibility<R: Runtime>(window: &Window<R>, visible: bool) {
    if let Err(err) = window.emit(VISIBILITY_CHANGED, visible) {
        log::error!("[window] failed to send the visibility change: {err}");
    }
}
