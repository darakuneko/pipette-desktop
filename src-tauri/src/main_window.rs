// SPDX-License-Identifier: GPL-2.0-or-later
//! The app's one window. `main_window_builder` is the single place it is
//! configured: the app builds it in setup, and the IPC contract tests
//! (ipc_contract.rs) build their windows with it too. Further window options
//! (its saved size and position, zoom, ...) belong in this function.

use tauri::{Manager, Runtime, WebviewWindowBuilder};

use crate::navigation;

/// The label of the main window, the only window the capabilities grant the
/// commands to.
pub const MAIN_WINDOW: &str = "main";

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
