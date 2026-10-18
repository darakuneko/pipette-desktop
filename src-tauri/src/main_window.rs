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
//! as they are.
//!
//! Positions are in Electron's DIP space on Linux (X11, one scale for every
//! monitor) and macOS. On Windows with monitors of different scales, a
//! monitor's origin can differ from Chromium's, so a position saved by one
//! build can open elsewhere, or centered, in the other.
//!
//! The saved size is the size inside the window frame, which is also what
//! the builder sets, so a window keeps its size from launch to launch.
//! Electron's bounds include the frame where the window system draws one
//! into the window (Windows, macOS), so with a config.json shared with the
//! Electron build the window opens one frame larger or smaller once, and
//! keeps that size from then on.

use std::sync::{Mutex, PoisonError};

use pipette_app_config::{AppConfigStore, Object, Value};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, Runtime,
    WebviewWindow, WebviewWindowBuilder, Window,
};

use crate::navigation;
use crate::window_bounds::{MIN_SIZE, Rect, Size, effective_min_size};
use crate::window_state::{self, Display, WindowReadout};

/// The label of the main window, the only window the capabilities grant the
/// commands to.
pub const MAIN_WINDOW: &str = "main";

/// The event telling the renderer the main window was shown (`true`) or
/// hidden (`false`): `IpcChannels.WINDOW_VISIBILITY_CHANGED` of
/// src/shared/ipc/channels.ts, which `onWindowVisibilityChanged`
/// (src/tauri-shim/api/window.ts) listens to.
pub const VISIBILITY_CHANGED: &str = "window:visibility-changed";

/// What the handlers keep about the main window.
struct MainWindowState {
    /// Whether this launch opened the window hidden. Fixed at startup; it
    /// does not follow the window's visibility.
    started_hidden: bool,
    min_size: Mutex<AppliedMinSize>,
}

/// The minimum size last applied, and the monitor it was derived from:
/// moves within that monitor leave it alone.
struct AppliedMinSize {
    /// None until the window first moves: the window opens on the monitor
    /// [`window_state::place`] picked, which is not tied to a [`Monitor`].
    monitor: Option<MonitorKey>,
    min_size: Size,
}

/// What tells monitors apart.
#[derive(PartialEq)]
struct MonitorKey {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    scale: f64,
}

impl MonitorKey {
    fn of(monitor: &Monitor) -> Self {
        Self { position: *monitor.position(), size: *monitor.size(), scale: monitor.scale_factor() }
    }
}

/// Whether this launch opened the main window hidden.
pub fn started_hidden<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<MainWindowState>().is_some_and(|state| state.started_hidden)
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

/// Opens the main window, and keeps what the handlers need about it. The window starts
/// hidden when the config's `startInTray` and `trayResident` are both on
/// (`Boolean()` of each, as the Electron build reads them) and the tray icon,
/// set up before this from the same `trayResident`, exists to show it
/// ([`crate::tray::window_starts_hidden`]).
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
    let start_hidden = crate::tray::window_starts_hidden(app, truthy("startInTray"), truthy("trayResident"));

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
    app.manage(MainWindowState {
        started_hidden: start_hidden,
        min_size: Mutex::new(AppliedMinSize { monitor: None, min_size: placement.min_size }),
    });
    crate::app_config::apply_stored_zoom(config, &window);
    if !start_hidden {
        reveal(&window.as_ref().window());
    }
    Ok(window)
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
    let work_area = monitor.work_area();
    Display {
        bounds: dip_rect(*monitor.position(), *monitor.size(), scale),
        work_area: dip_rect(work_area.position, work_area.size, scale),
    }
}

/// The rectangle at `position` of `size`, physical pixels at `scale`, in DIP.
fn dip_rect(position: PhysicalPosition<i32>, size: PhysicalSize<u32>, scale: f64) -> Rect {
    window_state::to_dip(position.x.into(), position.y.into(), size.width.into(), size.height.into(), scale)
}

/// Saves the bounds of `window` as `windowState`, as `saveWindowState` does:
/// directly, without telling the config listeners, and a failure is only
/// logged. A hidden or minimized window keeps the state saved before
/// ([`window_state::state_to_save`]).
pub fn save_window_state<R: Runtime>(window: &Window<R>, config: &AppConfigStore) {
    let bounds = window
        .scale_factor()
        .and_then(|scale| Ok(dip_rect(window.outer_position()?, window.inner_size()?, scale)));
    let bounds = match bounds {
        Ok(bounds) => bounds,
        Err(err) => {
            log::error!("[window] failed to read the window bounds: {err}");
            return;
        }
    };
    let readout = WindowReadout {
        bounds,
        visible: is_visible(window),
        minimized: window.is_minimized().unwrap_or(false),
        position_known: position_known(window),
    };
    let previous = if readout.position_known {
        None
    } else {
        config.get("windowState").unwrap_or_else(|err| {
            log::error!("[window] failed to read windowState: {err}");
            None
        })
    };
    let Some(state) = window_state::state_to_save(readout, previous.as_ref()) else {
        return;
    };
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

/// Applies the minimum size the window's display allows after the window
/// moved onto another monitor, when it differs from the one applied last.
/// Runs for every move event, so within one monitor it only compares.
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
    let key = MonitorKey::of(&monitor);
    let mut applied = state.min_size.lock().unwrap_or_else(PoisonError::into_inner);
    if applied.monitor.as_ref() == Some(&key) {
        return;
    }
    applied.monitor = Some(key);
    let min_size = effective_min_size(display(&monitor).work_area.size(), MIN_SIZE.width, MIN_SIZE.height);
    if applied.min_size == min_size {
        return;
    }
    match window.set_min_size(Some(LogicalSize::new(min_size.width, min_size.height))) {
        Ok(()) => applied.min_size = min_size,
        Err(err) => {
            // Tried again on the next move.
            applied.monitor = None;
            log::error!("[window] failed to set the minimum size: {err}");
        }
    }
}

/// Restores, shows and focuses `window`, as `showWindow` of
/// src/main/app-behavior.ts does. Whether it was hidden before.
pub fn reveal<R: Runtime>(window: &Window<R>) -> bool {
    let was_visible = is_visible(window);
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
    let was_visible = is_visible(window);
    if let Err(err) = window.hide() {
        log::error!("[window] failed to hide the main window: {err}");
        return;
    }
    if was_visible {
        notify_visibility(window, false);
    }
}

/// Whether `window` is shown; false when that cannot be read, which is
/// logged.
pub fn is_visible<R: Runtime>(window: &Window<R>) -> bool {
    window.is_visible().unwrap_or_else(|err| {
        log::error!("[window] failed to read the window's visibility: {err}");
        false
    })
}

/// The Electron window's `show` / `hide` events, pushed to the renderer:
/// `document.visibilityState` does not follow a window that starts hidden.
fn notify_visibility<R: Runtime>(window: &Window<R>, visible: bool) {
    if let Err(err) = window.emit(VISIBILITY_CHANGED, visible) {
        log::error!("[window] failed to send the visibility change: {err}");
    }
}
