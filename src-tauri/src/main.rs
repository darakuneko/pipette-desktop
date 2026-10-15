// SPDX-License-Identifier: GPL-2.0-or-later
// Tauri entry point: one window that loads the renderer build, the HID
// and definition commands its vialAPI shim calls, and the tray and quit
// handling of lifecycle.rs.

// Builds in the release profile (the ones that get bundled) must not open a
// console next to the window on Windows. build.rs sets `release_profile`, from
// the same check that keeps the dev-tools feature out of that profile, so
// every build with the development tools keeps its console.
#![cfg_attr(release_profile, windows_subsystem = "windows")]

mod definition;
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
    let builder = dev_commands::install_or_passthrough(builder, app_commands());
    match builder.build(tauri::generate_context!()) {
        Ok(app) => app.run(lifecycle::on_run_event),
        Err(err) => {
            eprintln!("failed to run the application: {err}");
            std::process::exit(1);
        }
    }
}
