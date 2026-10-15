// SPDX-License-Identifier: GPL-2.0-or-later
// Tauri entry point: one window that loads the renderer build, the HID,
// definition, app config and window commands its vialAPI shim calls, and the tray
// and quit handling of lifecycle.rs. Before any of that it settles the
// userData directory and refuses to start while the Electron build holds it;
// once no other instance of this build runs, it starts the log in the
// directory and loads the app config.

// Builds in the release profile (the ones that get bundled) must not open a
// console next to the window on Windows. build.rs sets `release_profile`, from
// the same check that keeps the dev-tools feature out of that profile, so
// every build with the development tools keeps its console.
#![cfg_attr(release_profile, windows_subsystem = "windows")]

mod app_config;
#[cfg(test)]
mod capability_files;
mod command_error;
mod definition;
mod dev_commands;
mod hid_commands;
#[cfg(test)]
mod ipc_contract;
mod lifecycle;
mod main_window;
mod navigation;
mod shell;
mod shutdown;
mod window_bounds;
mod window_commands;
mod window_state;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use pipette_hid::{HidService, VirtualDeviceMode};
use tauri::ipc::Invoke;
use tauri::{Manager, Runtime};

use crate::hid_commands::Hid;
use crate::shell::ExternalOpener;

/// The handler of the app commands; their permissions are listed in
/// build.rs and granted in capabilities/main.json. Generic over the runtime
/// so the IPC contract tests (ipc_contract.rs) run these same commands on
/// Tauri's mock runtime.
fn app_commands<R: Runtime>() -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        hid_commands::list_devices,
        hid_commands::open_device,
        hid_commands::close_device,
        hid_commands::send_receive,
        hid_commands::send,
        hid_commands::is_device_open,
        hid_commands::hid_probe_open,
        hid_commands::hid_probe_send_receive,
        hid_commands::hid_probe_close,
        definition::decompress_definition,
        app_config::app_config_get_all,
        app_config::app_config_set,
        shell::open_external,
        window_commands::set_window_zoom,
        window_commands::window_show,
        window_commands::window_hide,
        window_commands::window_started_hidden,
        window_commands::window_is_visible,
    ]
}

/// The userData directory (`pipette_fs::user_data_dir`), the root of all the
/// app keeps on disk.
pub struct UserDataDir(pub PathBuf);

/// The userData directory, or the reason the app cannot start, for stderr.
/// Runs before the log exists, so nothing is written to the directory of a
/// running Electron build.
fn startup_user_data() -> Result<PathBuf, String> {
    let dir = pipette_fs::user_data_dir().map_err(|err| format!("cannot start: {err}"))?;
    refuse_if_electron_holds(&dir)?;
    Ok(dir)
}

fn refuse_if_electron_holds(dir: &Path) -> Result<(), String> {
    match pipette_fs::electron_lock_holder(dir) {
        Some(holder) => Err(format!(
            "cannot start: the Electron build of Pipette (pid {}) is running with the data directory {}. \
             Quit it first.",
            holder.pid,
            dir.display()
        )),
        None => Ok(()),
    }
}

fn main() {
    let user_data = match startup_user_data() {
        Ok(dir) => dir,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    };
    // The single-instance plugin, registered first, runs while the app is
    // built: a second launch hands over to the running app there and exits
    // with 0. So the log, the app config and the HID service, which the
    // running app owns, start only after `build`.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| lifecycle::on_second_launch(app)))
        .setup(|app| {
            main_window::open_main_window(app.handle(), &app.state::<app_config::AppConfig>())?;
            app_config::listen_for_changes(app.handle());
            lifecycle::setup(app);
            Ok(())
        })
        .on_window_event(lifecycle::on_window_event);
    let builder = dev_commands::install_or_passthrough(builder, app_commands(), lifecycle::on_page_load);
    let built = builder.build(tauri::generate_context!());
    start_log(&user_data);
    let app = match built {
        Ok(app) => app,
        Err(err) => {
            log::error!("failed to run the application: {err}");
            std::process::exit(1);
        }
    };
    log::info!("Pipette starting");
    let config: app_config::AppConfig = Arc::new(pipette_app_config::AppConfigStore::open(&user_data));
    app.manage(Hid(Arc::new(HidService::new(VirtualDeviceMode::from_env()))));
    app.manage(UserDataDir(user_data));
    app.manage(config);
    app.manage(ExternalOpener::system());
    app.run(lifecycle::on_run_event);
}

/// Starts the log after `build`, that is after the single-instance check, so
/// a second launch never touches the running app's log; records emitted
/// while the app is built (plugin setup included) are not written to the file.
fn start_log(user_data: &Path) {
    if let Err(err) = pipette_logger::init(user_data.join("logs")) {
        log::error!("the log file is unavailable: {err}");
    }
}
