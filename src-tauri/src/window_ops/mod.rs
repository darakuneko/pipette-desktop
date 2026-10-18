// SPDX-License-Identifier: GPL-2.0-or-later
//! The main window's geometry as the window system changes it. Every window
//! event but the close request (src/lifecycle.rs) comes here: after a move,
//! the window gets the minimum size of the display it is on
//! (`main_window::update_min_size`). A resize or a change of the scale
//! factor changes nothing here.

use tauri::{Runtime, Window, WindowEvent};

use crate::main_window;

pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::Moved(_) = event {
        main_window::update_min_size(window);
    }
}
