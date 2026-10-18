// SPDX-License-Identifier: GPL-2.0-or-later
//! The tray seen and driven from the e2e tests, which cannot reach the tray
//! icon through WebDriver. Builds with the development tools only.

use tauri::{AppHandle, Wry};

use crate::command_error::CommandError;
use crate::tray::{self, TraySnapshot};

/// Whether the tray icon exists, the tooltip it was given and its menu
/// items as `{id, label, enabled, kind}`, read back from the menu.
#[tauri::command]
pub fn dev_tray_state(app: AppHandle<Wry>) -> Result<TraySnapshot, CommandError> {
    Ok(tray::snapshot(&app)?)
}

/// Runs what a click on the tray menu item `id` runs (`show`, `quit`).
#[tauri::command]
pub fn dev_tray_activate(app: AppHandle<Wry>, id: String) -> Result<(), CommandError> {
    tray::activate(&app, &id).map_err(CommandError::new)
}

/// Activates the enabled GTK menu item labelled `label` of the tray's menu,
/// as a click on it in the desktop's tray does: the item sends its menu
/// event, which reaches every menu listener of the app through Tauri's
/// event loop. `dev_tray_activate` calls the handler itself instead, so
/// only this shows how many listeners a click runs. A synchronous command,
/// so it runs on the main thread, where GTK may be used.
///
/// Every GTK menu still alive is searched, a menu the tray dropped when it
/// was rebuilt among them; such a menu's item sends the same menu id as the
/// current one, so activating either is the same click.
#[cfg(target_os = "linux")]
#[tauri::command]
pub fn dev_tray_menu_click(app: AppHandle<Wry>, label: String) -> Result<(), CommandError> {
    use gtk::prelude::*;

    if !tray::is_tray_active(&app) {
        return Err(CommandError::new("the tray icon does not exist"));
    }
    let item = gtk::Window::list_toplevels()
        .into_iter()
        .filter_map(|widget| widget.downcast::<gtk::Window>().ok()?.child()?.downcast::<gtk::Menu>().ok())
        .flat_map(|menu| menu.children())
        .filter_map(|child| child.downcast::<gtk::MenuItem>().ok())
        .find(|item| item.is_sensitive() && item.label().is_some_and(|text| text == label.as_str()))
        .ok_or_else(|| CommandError::new(format!("no enabled tray menu item is labelled {label}")))?;
    item.activate();
    Ok(())
}
