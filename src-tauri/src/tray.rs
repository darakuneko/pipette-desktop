// SPDX-License-Identifier: GPL-2.0-or-later
//! The tray icon of src/main/app-behavior.ts: created when the config's
//! `trayResident` is on, added and removed as the renderer changes it, and
//! its menu (Show, the connected keyboard and the REC counters the renderer
//! reports, Quit). [`TrayState`] keeps the last status and tells whether the
//! icon exists; closing the window hides it only then (src/lifecycle.rs),
//! since a hidden window with no tray icon to restore it would be
//! unreachable.
//!
//! On Linux the icon is a StatusNotifierItem through libayatana-appindicator3,
//! which Tauri loads when the first icon is built and panics without. A
//! failed build, panic or error, leaves the app without a tray: the window
//! then neither starts hidden (src/main_window.rs) nor hides on close.

mod status;

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde_json::Value;
#[cfg(any(test, feature = "dev-tools"))]
use tauri::menu::MenuItemKind;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager, Runtime, Wry};

use crate::app_config::AppConfig;
use crate::lifecycle::{request_quit, show_main_window};
#[cfg(test)]
pub(crate) use status::QUIT as QUIT_ITEM;
use status::{Layout, RowKind, TrayStatus};

/// The tray icon's id.
const TRAY_ID: &str = "main";

/// What the tray handlers share.
///
/// Locked on the main thread only: by the setup hook, the tasks
/// [`set_tray_resident`] queues there, the window's close handler, and the
/// synchronous commands, which Tauri runs on the main thread. While it is
/// locked the tray is built and its tooltip and menu are set, GTK calls Tauri
/// makes on the main thread; off the main thread they would wait for it, and
/// a main thread waiting for this lock would never answer. The commands that
/// lock it must therefore stay synchronous (not `async`).
#[derive(Default)]
pub struct TrayState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// The last valid status the renderer reported, kept with no tray icon
    /// too, so an icon created later shows it. Nothing resets it: the
    /// renderer reports a disconnect itself.
    status: TrayStatus,
    live: Option<LiveTray>,
    /// Whether a failed tray build was logged: once Tauri's loading of the
    /// appindicator library has panicked, every later build panics too.
    failure_logged: bool,
}

struct LiveTray {
    icon: TrayIcon<Wry>,
    menu: TrayMenu<Wry>,
    tooltip: String,
}

impl TrayState {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Whether the tray icon exists, so a hidden window can be shown again;
/// false before setup has run.
pub fn is_tray_active<R: Runtime, M: Manager<R>>(manager: &M) -> bool {
    manager.try_state::<TrayState>().is_some_and(|tray| tray.lock().live.is_some())
}

/// Creates the tray when the config's `trayResident` is on (`Boolean()` of
/// it, as the Electron build reads it). Called from the app's setup hook,
/// before the main window opens, which looks at whether the icon exists.
pub fn setup(app: &mut App<Wry>) {
    app.manage(TrayState::default());
    // Registered once for the app, not with each tray icon: Tauri keeps the
    // menu handler of every icon built, and an icon added again after
    // `trayResident` was turned off would run each click twice.
    app.on_menu_event(|app, event| {
        on_menu_item(app, event.id().as_ref());
    });
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
    let mut inner = tray.lock();
    if inner.live.is_some() {
        return;
    }
    // The panic of a missing appindicator library is caught here, on the
    // main thread, before it could unwind into the event loop's C frames.
    // The logger's panic hook reports it as DEBUG only: it is logged below.
    let built = pipette_logger::expecting_panics(|| {
        catch_unwind(AssertUnwindSafe(|| build_tray(app, &inner.status)))
    });
    let failure = match built {
        Ok(Ok(live)) => {
            inner.live = Some(live);
            return;
        }
        Ok(Err(err)) => err.to_string(),
        Err(panic) => panic_message(panic.as_ref()),
    };
    let level = inner.failure_level();
    log::log!(level, "failed to create the tray icon, continuing without one: {failure}");
}

impl Inner {
    /// The level to log a failed tray build at: ERROR the first time only,
    /// so turning `trayResident` on again does not repeat it.
    fn failure_level(&mut self) -> log::Level {
        if std::mem::replace(&mut self.failure_logged, true) { log::Level::Debug } else { log::Level::Error }
    }
}

/// Whether the main window opens hidden: with the config's `startInTray`
/// and `trayResident` on (as `createWindow` of src/main/index.ts decides) and
/// the tray icon created, so the window can be shown again. The Electron
/// build does not check the icon: a `Tray` it cannot create fails its
/// startup instead.
pub fn window_starts_hidden<R: Runtime, M: Manager<R>>(
    manager: &M,
    start_in_tray: bool,
    tray_resident: bool,
) -> bool {
    start_in_tray && tray_resident && is_tray_active(manager)
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    panic
        .downcast_ref::<&str>()
        .map(|message| (*message).to_owned())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panicked".to_owned())
}

/// Removes the tray icon, and shows the main window if it is hidden: with no
/// icon nothing could show it again (a close that hid it may have been
/// handled just before).
fn remove_tray(app: &AppHandle<Wry>) {
    // The icon goes away with the last handle to it: the one kept here and
    // the one in the app's resources.
    let live = app.state::<TrayState>().lock().live.take();
    drop(live);
    drop(app.remove_tray_by_id(TRAY_ID));
    if let Some(window) = crate::main_window::main_window(app)
        && !crate::main_window::is_visible(&window)
    {
        crate::main_window::reveal(&window);
    }
}

/// Whether a left click on the icon opens the menu rather than showing the
/// window. As with the Electron tray, macOS opens the menu on any click,
/// and on Windows a left click shows the window and a right click opens the
/// menu. Linux (AppIndicator) reports no clicks: the menu is the only way
/// there.
const MENU_ON_LEFT_CLICK: bool = cfg!(target_os = "macos");

/// The longest tooltip a Windows tray icon takes, in UTF-16 units: its
/// buffer holds 128 with the terminating NUL. The Electron tray cuts a
/// longer one to this; Tauri would fill the buffer and leave out the NUL.
const WINDOWS_TOOLTIP_UNITS: usize = 127;

/// The macOS menu-bar icon: a black eyedropper on a transparent canvas,
/// shown as a template image, so macOS uses only its alpha and tints it like
/// the other menu-bar icons. The tray draws any icon 18pt high, so it is
/// 36x36 pixels (18pt at 2x). Windows and Linux show the app icon.
/// Drawn by scripts/generate-tray-template-icon.ts; embedded as pixels when
/// the crate is compiled.
#[cfg(any(target_os = "macos", test))]
const MACOS_TEMPLATE_ICON: tauri::image::Image<'static> = tauri::include_image!("icons/tray-template.png");

/// `tooltip` as the icon is given it: on Windows, cut to what it holds.
fn os_tooltip(tooltip: &str) -> &str {
    if cfg!(windows) { status::truncate_utf16(tooltip, WINDOWS_TOOLTIP_UNITS) } else { tooltip }
}

/// The tray icon with the menu of `status` (see [`MENU_ON_LEFT_CLICK`] for
/// what the clicks do). The menu's clicks go to the handler [`setup`]
/// registers, by item id, so the menus that replace the first one work too.
fn build_tray(app: &AppHandle<Wry>, status: &TrayStatus) -> tauri::Result<LiveTray> {
    let menu = TrayMenu::build(app, status)?;
    let tooltip = status.tooltip();
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu.menu)
        .tooltip(os_tooltip(&tooltip))
        .show_menu_on_left_click(MENU_ON_LEFT_CLICK)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left, button_state: MouseButtonState::Up, ..
            } = event
                && !MENU_ON_LEFT_CLICK
            {
                show_main_window(tray.app_handle());
            }
        });
    #[cfg(target_os = "macos")]
    {
        builder = builder.icon(MACOS_TEMPLATE_ICON).icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    match app.default_window_icon() {
        Some(icon) => builder = builder.icon(icon.clone()),
        None => log::warn!("the app has no icon for the tray"),
    }
    let icon = builder.build(app)?;
    Ok(LiveTray { icon, menu, tooltip })
}

/// What a click on the menu item `id` does; false for an item that does
/// nothing (the disabled info rows).
fn on_menu_item(app: &AppHandle<Wry>, id: &str) -> bool {
    match id {
        status::SHOW => show_main_window(app),
        status::QUIT => request_quit(app),
        _ => return false,
    }
    true
}

impl LiveTray {
    /// Shows `status`, as `applyCachedTrayStatus` does. Tauri sets no tooltip
    /// on Linux.
    fn apply(&mut self, status: &TrayStatus) {
        self.tooltip = status.tooltip();
        if let Err(err) = self.icon.set_tooltip(Some(os_tooltip(&self.tooltip))) {
            log::error!("failed to set the tray tooltip: {err}");
        }
        match self.menu.update(self.icon.app_handle(), status) {
            Ok(None) => {}
            // The icon keeps its menu when it cannot take the new one, and the
            // next status with other rows than it builds a new one again.
            Ok(Some(replacement)) => match self.icon.set_menu(Some(replacement.menu.clone())) {
                Ok(()) => self.menu = replacement,
                Err(err) => log::error!("failed to set the tray menu: {err}"),
            },
            Err(err) => log::error!("failed to update the tray menu: {err}"),
        }
    }
}

/// The tray menu and the rows whose text follows the status.
///
/// The Electron tray builds a new menu for every status, up to once a
/// second while REC runs. Here a status with the same [`Layout`] only
/// changes the text of the rows, and the menu is replaced only when rows
/// come or go: replacing an AppIndicator menu closes it if it is open.
struct TrayMenu<R: Runtime> {
    menu: Menu<R>,
    layout: Layout,
    keyboard: Option<MenuItem<R>>,
    count: Option<MenuItem<R>>,
    kpm: Option<MenuItem<R>>,
}

impl<R: Runtime> TrayMenu<R> {
    fn build<M: Manager<R>>(manager: &M, status: &TrayStatus) -> tauri::Result<Self> {
        let mut items: Vec<Box<dyn IsMenuItem<R>>> = Vec::new();
        let (mut keyboard, mut count, mut kpm) = (None, None, None);
        for row in status.menu_rows() {
            if row.kind == RowKind::Separator {
                items.push(Box::new(PredefinedMenuItem::separator(manager)?));
                continue;
            }
            let item = MenuItem::with_id(manager, row.id.as_str(), &row.label, row.enabled, None::<&str>)?;
            match row.id.as_str() {
                status::KEYBOARD => keyboard = Some(item.clone()),
                status::COUNT => count = Some(item.clone()),
                status::KPM => kpm = Some(item.clone()),
                _ => {}
            }
            items.push(Box::new(item));
        }
        let refs: Vec<&dyn IsMenuItem<R>> = items.iter().map(Box::as_ref).collect();
        let menu = Menu::with_items(manager, &refs)?;
        Ok(Self { menu, layout: status.layout(), keyboard, count, kpm })
    }

    /// Shows `status`, or returns the new menu that shows it when it has
    /// other rows; the tray icon must then take it in place of this one.
    fn update<M: Manager<R>>(&self, manager: &M, status: &TrayStatus) -> tauri::Result<Option<Self>> {
        if status.layout() != self.layout {
            return Self::build(manager, status).map(Some);
        }
        if let (Some(item), Some(name)) = (&self.keyboard, &status.keyboard_name) {
            item.set_text(name)?;
        }
        if let Some(item) = &self.count {
            item.set_text(status.count_label())?;
        }
        if let Some(item) = &self.kpm {
            item.set_text(status.kpm_label())?;
        }
        Ok(None)
    }

    /// The menu's rows, read back from its items.
    #[cfg(any(test, feature = "dev-tools"))]
    fn rows(&self) -> tauri::Result<Vec<status::MenuRow>> {
        self.menu
            .items()?
            .into_iter()
            .map(|item| {
                let row = match item {
                    MenuItemKind::MenuItem(item) => status::MenuRow {
                        id: item.id().0.clone(),
                        label: item.text()?,
                        enabled: item.is_enabled()?,
                        kind: RowKind::Normal,
                    },
                    other => status::MenuRow {
                        id: other.id().0.clone(),
                        label: String::new(),
                        enabled: true,
                        kind: RowKind::Separator,
                    },
                };
                Ok(row)
            })
            .collect()
    }
}

/// `TRAY_STATUS_UPDATE` of src/main/index.ts: the connected keyboard's name
/// and the REC counters the renderer reports for the tray. A status that
/// fails the shape check is dropped and the last one stays.
#[tauri::command]
pub fn tray_status_update<R: Runtime>(app: AppHandle<R>, status: Option<Value>) {
    let Some(status) = status.as_ref().and_then(TrayStatus::parse) else {
        return;
    };
    let Some(tray) = app.try_state::<TrayState>() else {
        return;
    };
    let mut inner = tray.lock();
    if let Some(live) = &mut inner.live {
        live.apply(&status);
    }
    inner.status = status;
}

/// The tray as `dev_tray_state` reports it.
#[cfg(feature = "dev-tools")]
#[derive(Debug, serde::Serialize)]
pub struct TraySnapshot {
    pub active: bool,
    /// The tooltip given to the icon; Linux shows none.
    pub tooltip: Option<String>,
    pub items: Vec<status::MenuRow>,
}

#[cfg(feature = "dev-tools")]
pub fn snapshot(app: &AppHandle<Wry>) -> tauri::Result<TraySnapshot> {
    let tray = app.state::<TrayState>();
    let inner = tray.lock();
    Ok(match &inner.live {
        Some(live) => {
            TraySnapshot { active: true, tooltip: Some(live.tooltip.clone()), items: live.menu.rows()? }
        }
        None => TraySnapshot { active: false, tooltip: None, items: Vec::new() },
    })
}

/// Runs what a click on the menu item `id` runs; an error when the tray
/// icon does not exist or the item does nothing.
#[cfg(feature = "dev-tools")]
pub fn activate(app: &AppHandle<Wry>, id: &str) -> Result<(), String> {
    if !is_tray_active(app) {
        return Err("the tray icon does not exist".to_owned());
    }
    if on_menu_item(app, id) { Ok(()) } else { Err(format!("the tray menu has no item {id} that acts")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tauri::test::{MockRuntime, mock_app};

    fn status(name: Option<&str>, recording: bool, count: f64, kpm: f64) -> TrayStatus {
        TrayStatus { keyboard_name: name.map(str::to_owned), recording, count, kpm }
    }

    fn template(menu: &TrayMenu<MockRuntime>) -> Value {
        status::as_template(&menu.rows().unwrap())
    }

    #[test]
    #[cfg_attr(
        target_os = "macos",
        ignore = "muda makes menus on the main thread only, and libtest runs tests on others"
    )]
    fn a_menu_holds_the_rows_of_its_status() {
        let app = mock_app();
        let rec = status(Some("GPK60-63R"), true, 1234.0, 57.5);
        let menu = TrayMenu::build(&app, &rec).unwrap();
        assert_eq!(template(&menu), status::as_template(&rec.menu_rows()));
        let rows = menu.rows().unwrap();
        let ids: Vec<_> =
            rows.iter().filter(|row| row.kind == RowKind::Normal).map(|row| row.id.as_str()).collect();
        assert_eq!(ids, ["show", "keyboard", "recording", "count", "kpm", "quit"]);
        let enabled: Vec<_> = rows
            .iter()
            .filter(|row| row.kind == RowKind::Normal && row.enabled)
            .map(|row| row.id.as_str())
            .collect();
        assert_eq!(enabled, ["show", "quit"]);
    }

    /// A template image is read for its alpha only: every pixel is black,
    /// and the dropper covers part of the canvas, not all of it, with an
    /// opaque core and partly covered pixels along its anti-aliased edge.
    #[test]
    fn the_macos_icon_is_a_black_alpha_mask_of_the_menu_bar_size() {
        let icon = &MACOS_TEMPLATE_ICON;
        assert_eq!((icon.width(), icon.height()), (36, 36));
        let pixels = icon.rgba();
        assert_eq!(pixels.len(), 36 * 36 * 4);
        assert!(pixels.chunks_exact(4).all(|pixel| pixel[..3] == [0, 0, 0]));
        let alphas: Vec<u8> = pixels.chunks_exact(4).map(|pixel| pixel[3]).collect();
        let covered = alphas.iter().filter(|&&alpha| alpha > 0).count();
        assert!((36 * 36 / 8..36 * 36 / 2).contains(&covered), "{covered} pixels drawn");
        let opaque = alphas.iter().filter(|&&alpha| alpha == 255).count();
        assert!(opaque * 2 >= covered, "{opaque} of {covered} pixels opaque");
        let partial = alphas.iter().filter(|&&alpha| alpha > 0 && alpha < 255).count();
        assert!(partial >= 50, "{partial} partly covered pixels");
        // The canvas keeps a clear border so the icon does not touch the
        // menu bar's edges.
        let edge = |x: usize, y: usize| alphas[y * 36 + x];
        assert!((0..36).all(|i| edge(i, 0) == 0 && edge(i, 35) == 0 && edge(0, i) == 0 && edge(35, i) == 0));
    }

    #[test]
    fn a_failed_build_is_an_error_once_then_debug() {
        let mut inner = Inner::default();
        assert_eq!(inner.failure_level(), log::Level::Error);
        assert_eq!(inner.failure_level(), log::Level::Debug);
        assert_eq!(inner.failure_level(), log::Level::Debug);
    }

    /// With no tray icon (it could not be created, or setup has not run)
    /// the window does not start hidden, whatever the config says.
    #[test]
    fn the_window_starts_hidden_only_with_a_tray_icon() {
        let app = mock_app();
        assert!(!window_starts_hidden(&app, true, true));
        app.manage(TrayState::default());
        assert!(!window_starts_hidden(&app, true, true));
        assert!(!window_starts_hidden(&app, false, true));
        assert!(!window_starts_hidden(&app, true, false));
    }

    /// The golden's first scenario on one menu: every status leaves the
    /// menu as the Electron tray's, and only a status that adds or removes
    /// rows replaces it.
    #[test]
    #[cfg_attr(
        target_os = "macos",
        ignore = "muda makes menus on the main thread only, and libtest runs tests on others"
    )]
    fn a_menu_changes_text_and_is_replaced_only_when_rows_come_or_go() {
        let app = mock_app();
        let mut menu = TrayMenu::build(&app, &TrayStatus::default()).unwrap();
        let steps = [
            (status(Some("GPK60-63R"), false, 0.0, 0.0), true),
            (status(Some("GPK60-63R"), true, 1234.0, 56.0), true),
            (status(Some("GPK60-63R"), true, 1235.0, 57.5), false),
            (status(Some("Other keyboard"), true, 1235.0, 57.5), false),
            (status(Some("Other keyboard"), false, 1235.0, 57.5), true),
            (status(Some(""), true, 10.0, 2.0), true),
            (status(Some(""), false, 10.0, 2.0), true),
            (status(None, true, 3.0, 1.0), true),
            (status(None, true, 4.0, 1.25), false),
            (status(None, false, 0.0, 0.0), true),
        ];
        for (next, replaced) in steps {
            if let Some(replacement) = menu.update(&app, &next).unwrap() {
                assert!(replaced, "{next:?}");
                menu = replacement;
            } else {
                assert!(!replaced, "{next:?}");
            }
            assert_eq!(template(&menu), status::as_template(&next.menu_rows()), "{next:?}");
        }
    }

    /// A menu with other rows is built aside: the one the icon holds stays
    /// as it was until the icon takes the new one.
    #[test]
    #[cfg_attr(
        target_os = "macos",
        ignore = "muda makes menus on the main thread only, and libtest runs tests on others"
    )]
    fn a_new_layout_leaves_the_current_menu_alone() {
        let app = mock_app();
        let menu = TrayMenu::build(&app, &status(Some("K"), false, 0.0, 0.0)).unwrap();
        let before = template(&menu);
        assert!(menu.update(&app, &status(Some("K"), true, 5.0, 1.0)).unwrap().is_some());
        assert_eq!(template(&menu), before);
        assert_eq!(menu.layout, Layout { name: true, recording: false });
    }

    #[test]
    #[cfg_attr(
        target_os = "macos",
        ignore = "muda makes menus on the main thread only, and libtest runs tests on others"
    )]
    fn a_replaced_menu_keeps_the_ids_its_handler_goes_by() {
        let app = mock_app();
        let menu = TrayMenu::build(&app, &TrayStatus::default()).unwrap();
        let menu = menu.update(&app, &status(Some("K"), true, 1.0, 1.0)).unwrap().unwrap();
        let rows = menu.rows().unwrap();
        assert_eq!(rows.first().map(|row| row.id.as_str()), Some(status::SHOW));
        assert_eq!(rows.last().map(|row| row.id.as_str()), Some(status::QUIT));
        assert!(menu.menu.get(status::SHOW).is_some());
        assert!(menu.menu.get(status::QUIT).is_some());
    }

    #[test]
    fn statuses_are_cached_without_a_tray_and_a_bad_one_is_dropped() {
        let app = mock_app();
        app.manage(TrayState::default());
        let good = json!({"keyboardName": "K", "recording": true, "count": 2, "kpm": 3});
        tray_status_update(app.handle().clone(), Some(good));
        let cached = || app.state::<TrayState>().lock().status.clone();
        assert_eq!(cached(), status(Some("K"), true, 2.0, 3.0));

        tray_status_update(app.handle().clone(), Some(json!({"keyboardName": "x"})));
        tray_status_update(app.handle().clone(), Some(Value::Null));
        tray_status_update(app.handle().clone(), None);
        assert_eq!(cached(), status(Some("K"), true, 2.0, 3.0));
        assert!(!is_tray_active(&app));
    }

    #[test]
    fn a_status_before_setup_is_ignored() {
        let app = mock_app();
        tray_status_update(
            app.handle().clone(),
            Some(json!({"keyboardName": null, "recording": false, "count": 0, "kpm": 0})),
        );
        assert!(!is_tray_active(&app));
    }

    #[test]
    fn a_panic_message_is_read_from_its_payload() {
        let caught = catch_unwind(|| panic!("no {}", "library")).unwrap_err();
        assert_eq!(panic_message(caught.as_ref()), "no library");
        let caught = catch_unwind(|| std::panic::panic_any(7)).unwrap_err();
        assert_eq!(panic_message(caught.as_ref()), "panicked");
    }
}
