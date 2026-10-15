// SPDX-License-Identifier: GPL-2.0-or-later
// Tauri entry point: one window that loads the renderer build.

// Release builds on Windows must not open a console next to the window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(err) = tauri::Builder::default().run(tauri::generate_context!()) {
        eprintln!("failed to run the application: {err}");
        std::process::exit(1);
    }
}
