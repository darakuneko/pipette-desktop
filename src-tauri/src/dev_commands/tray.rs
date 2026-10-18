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

/// Activates the item `id` of the tray's menu through GTK, as a click on it
/// in the desktop's tray does: the GTK item sends its menu event, which
/// reaches every menu listener of the app through Tauri's event loop.
/// `dev_tray_activate` calls the handler itself instead, so only this shows
/// how many listeners a click runs. A synchronous command, so it runs on the
/// main thread, where GTK may be used.
///
/// Only a GTK menu whose items carry, in order, the labels of the tray's
/// current menu (`dev_tray_state`, separators as empty labels) is used, and
/// in it the item at the position of `id`, which must be enabled. A menu the
/// tray dropped when it was rebuilt can have the same rows; its items send
/// the same menu ids, so activating either is the same click.
#[cfg(target_os = "linux")]
#[tauri::command]
pub fn dev_tray_menu_click(app: AppHandle<Wry>, id: String) -> Result<(), CommandError> {
    use gtk::prelude::*;

    let tray = tray::snapshot(&app)?;
    if !tray.active {
        return Err(CommandError::new("the tray icon does not exist"));
    }
    let index = tray
        .items
        .iter()
        .position(|row| row.id == id && row.enabled)
        .ok_or_else(|| CommandError::new(format!("the tray menu has no enabled item {id}")))?;
    let labels: Vec<&str> = tray.items.iter().map(|row| row.label.as_str()).collect();
    let item = gtk::Window::list_toplevels()
        .into_iter()
        .filter_map(|widget| widget.downcast::<gtk::Window>().ok()?.child()?.downcast::<gtk::Menu>().ok())
        .map(|menu| menu.children())
        .find(|children| {
            children.len() == labels.len()
                && children.iter().zip(&labels).all(|(child, label)| {
                    let text = child.downcast_ref::<gtk::MenuItem>().and_then(|item| item.label());
                    text.as_deref().unwrap_or("") == *label
                })
        })
        .and_then(|children| children.into_iter().nth(index)?.downcast::<gtk::MenuItem>().ok())
        .ok_or_else(|| CommandError::new("no GTK menu holds the tray's current menu"))?;
    if !item.is_sensitive() {
        return Err(CommandError::new(format!("the GTK item of {id} is disabled")));
    }
    item.activate();
    Ok(())
}
