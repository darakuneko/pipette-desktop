// SPDX-License-Identifier: GPL-2.0-or-later
//! The main window's geometry as the app applied it, seen from the e2e
//! tests, where the window system cannot be asked. Builds with the
//! development tools only. The command is not available in this build yet:
//! it fails.

use crate::command_error::CommandError;

/// The window's size, minimum size, geometry hints, always-on-top state and
/// compact mode.
#[tauri::command]
pub fn dev_window_state() -> Result<(), CommandError> {
    Err(CommandError::new("dev_window_state is not implemented"))
}
