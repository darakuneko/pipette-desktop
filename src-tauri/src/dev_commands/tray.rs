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
