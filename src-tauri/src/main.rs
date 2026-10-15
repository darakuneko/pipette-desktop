// SPDX-License-Identifier: GPL-2.0-or-later
// Tauri entry point: one window that loads the renderer build, and the HID
// commands its vialAPI shim calls.

// Release builds on Windows must not open a console next to the window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(debug_assertions)]
mod dev_commands;
mod hid_commands;

use std::sync::Arc;

use pipette_hid::{HidService, VirtualDeviceMode};

use crate::hid_commands::Hid;

fn main() {
    let hid = Hid(Arc::new(HidService::new(VirtualDeviceMode::from_env())));
    let builder = tauri::Builder::default().manage(hid);
    #[cfg(debug_assertions)]
    let builder = builder.on_page_load(dev_commands::run_dev_script);
    let builder = builder.invoke_handler(tauri::generate_handler![
        hid_commands::list_devices,
        hid_commands::open_device,
        hid_commands::close_device,
        hid_commands::send_receive,
        hid_commands::send,
        hid_commands::is_device_open,
        #[cfg(debug_assertions)]
        dev_commands::virtual_device_press_key,
        #[cfg(debug_assertions)]
        dev_commands::virtual_device_release_key,
        #[cfg(debug_assertions)]
        dev_commands::virtual_device_release_all,
        #[cfg(debug_assertions)]
        dev_commands::virtual_device_hold_keys,
        #[cfg(debug_assertions)]
        dev_commands::virtual_device_set_unlock_counter_max,
        #[cfg(debug_assertions)]
        dev_commands::virtual_device_get_state,
        #[cfg(debug_assertions)]
        dev_commands::virtual_device_reset,
        #[cfg(debug_assertions)]
        dev_commands::dev_log,
        #[cfg(all(debug_assertions, target_os = "linux"))]
        dev_commands::dev_screenshot,
    ]);
    if let Err(err) = builder.run(tauri::generate_context!()) {
        eprintln!("failed to run the application: {err}");
        std::process::exit(1);
    }
}
