// SPDX-License-Identifier: GPL-2.0-or-later
//! The tray seen and driven from the e2e tests, which cannot reach the tray
//! icon through WebDriver. Builds with the development tools only. Neither
//! command is available in this build yet: both fail.

use crate::command_error::CommandError;

/// Whether the tray icon exists, its tooltip and its menu items.
#[tauri::command]
pub fn dev_tray_state() -> Result<(), CommandError> {
    Err(CommandError::new("dev_tray_state is not implemented"))
}

/// Runs what a click on the tray menu item `id` runs.
#[tauri::command]
pub fn dev_tray_activate(id: String) -> Result<(), CommandError> {
    Err(CommandError::new(format!("dev_tray_activate({id}) is not implemented")))
}
