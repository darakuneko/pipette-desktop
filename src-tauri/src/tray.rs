// SPDX-License-Identifier: GPL-2.0-or-later
//! The tray icon of src/main/app-behavior.ts: created when the config's
//! `trayResident` is on, added and removed as the renderer changes it, and
//! its menu (Show, a separator, Quit). [`TrayState`] tells whether the icon
//! exists; closing the window hides it only then (src/lifecycle.rs), since
//! a hidden window with no tray icon to restore it would be unreachable.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager, Runtime, Wry};

use crate::app_config::AppConfig;
use crate::lifecycle::show_main_window;

/// The tray icon's id.
const TRAY_ID: &str = "main";
/// The tray item ids.
const TRAY_SHOW: &str = "show";
const TRAY_QUIT: &str = "quit";

/// What the tray handlers share.
#[derive(Default)]
pub struct TrayState {
    /// Set once the tray icon exists.
    active: AtomicBool,
}

impl TrayState {
    fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }
}

/// Whether the tray icon exists, so a hidden window can be shown again;
/// false before setup has run.
pub fn is_tray_active<R: Runtime, M: Manager<R>>(manager: &M) -> bool {
    manager.try_state::<TrayState>().is_some_and(|tray| tray.is_active())
}

/// Creates the tray when the config's `trayResident` is on (`Boolean()` of
/// it, as the Electron build reads it). Called from the app's setup hook.
pub fn setup(app: &mut App<Wry>) {
    app.manage(TrayState::default());
    let tray_resident = app.state::<AppConfig>().get("trayResident").unwrap_or_else(|err| {
        log::error!("failed to read trayResident: {err}");
        None
    });
    if tray_resident.as_ref().is_some_and(pipette_app_config::Value::is_truthy) {
        add_tray(app.handle());
    }
}

/// Adds the tray (`on`) or removes it, on the main thread, as `setupTray` /
/// `destroyTray` of src/main/app-behavior.ts do when the renderer changes
/// `trayResident`; nothing happens when the tray already is that way. Called
/// off the main thread, it queues the change there and returns without
/// waiting for it.
pub fn set_tray_resident(app: &AppHandle<Wry>, on: bool) {
    let handle = app.clone();
    let result = app.run_on_main_thread(move || {
        if on {
            add_tray(&handle);
        } else {
            remove_tray(&handle);
        }
    });
    if let Err(err) = result {
        log::error!("failed to update the tray icon: {err}");
    }
}

fn add_tray(app: &AppHandle<Wry>) {
    let tray = app.state::<TrayState>();
    if tray.is_active() {
        return;
    }
    match build_tray(app) {
        Ok(()) => tray.active.store(true, Ordering::Release),
        Err(err) => log::error!("failed to create the tray icon: {err}"),
    }
}

fn remove_tray(app: &AppHandle<Wry>) {
    app.state::<TrayState>().active.store(false, Ordering::Release);
    // The icon goes away with the last handle to it, this one.
    drop(app.remove_tray_by_id(TRAY_ID));
}

/// The tray menu: Show, a separator, Quit. The labels are the fixed English
/// ones of the Electron tray (src/main/app-behavior.ts), which cannot be
/// localized either: the translations live in the renderer.
fn build_tray(app: &AppHandle<Wry>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, TRAY_SHOW, "Show", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &separator, &quit])?;
    // A left click shows the window too, as in the Electron tray. Linux
    // (AppIndicator) reports no clicks; the menu is the only way there.
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Pipette")
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SHOW => show_main_window(app),
            TRAY_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// `TRAY_STATUS_UPDATE` of src/main/index.ts: the connected keyboard's name
/// and the REC counters the renderer reports for the tray. This build does
/// not show them yet, so the status is dropped.
#[tauri::command]
pub fn tray_status_update(status: Option<serde_json::Value>) {
    drop(status);
    log::warn!("[tray] trayStatusUpdate is not implemented");
}
