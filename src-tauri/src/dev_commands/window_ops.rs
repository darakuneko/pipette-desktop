// SPDX-License-Identifier: GPL-2.0-or-later
//! The main window's geometry as the app applied it, seen from the e2e
//! tests, where the window system cannot be asked (the X server of the
//! tests runs no window manager). Builds with the development tools only.

use tauri::{AppHandle, Wry};

use crate::command_error::CommandError;
use crate::main_window::main_window;
use crate::window_ops::{self, WindowReport};

/// The main window's content size, minimum size, the geometry hints last
/// applied, always-on-top state, whether compact mode is on and the size it
/// goes back to.
#[tauri::command]
pub fn dev_window_state(app: AppHandle<Wry>) -> Result<WindowReport, CommandError> {
    let window = main_window(&app).ok_or_else(|| CommandError::new("the main window is not open"))?;
    window_ops::report(&window).map_err(CommandError::new)
}
