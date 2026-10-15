// SPDX-License-Identifier: GPL-2.0-or-later
// Tauri entry point: one window that loads the renderer build, the HID
// and definition commands its vialAPI shim calls, and the tray and quit
// handling of lifecycle.rs.

// Release builds on Windows must not open a console next to the window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The development tools serve debug builds only (see Cargo.toml).
#[cfg(all(feature = "dev-tools", not(debug_assertions)))]
compile_error!("the dev-tools feature is for builds with debug assertions only");

mod definition;
#[cfg(feature = "dev-tools")]
mod dev_commands;
mod fs_atomic;
mod hid_commands;
mod lifecycle;
mod shutdown;

use std::sync::Arc;

use pipette_hid::{HidService, VirtualDeviceMode};
use tauri::Wry;
use tauri::ipc::Invoke;

use crate::hid_commands::Hid;

/// The handler of the app commands; their permissions are listed in
/// build.rs and granted in capabilities/main.json.
fn app_commands() -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        hid_commands::list_devices,
        hid_commands::open_device,
        hid_commands::close_device,
        hid_commands::send_receive,
        hid_commands::send,
        hid_commands::is_device_open,
        definition::decompress_definition,
    ]
}

fn main() {
    let hid = Hid(Arc::new(HidService::new(VirtualDeviceMode::from_env())));
    let builder = tauri::Builder::default()
        .manage(hid)
        .setup(|app| {
            lifecycle::setup(app);
            Ok(())
        })
        .on_window_event(lifecycle::on_window_event);
    #[cfg(feature = "dev-tools")]
    let builder = dev_commands::install(builder, app_commands());
    #[cfg(not(feature = "dev-tools"))]
    let builder = builder.invoke_handler(app_commands());
    match builder.build(tauri::generate_context!()) {
        Ok(app) => app.run(lifecycle::on_run_event),
        Err(err) => {
            eprintln!("failed to run the application: {err}");
            std::process::exit(1);
        }
    }
}
