// SPDX-License-Identifier: GPL-2.0-or-later
// Tauri entry point: one window that loads the renderer build, the HID,
// definition, app config and window commands its vialAPI shim calls, the
// typing analytics, and the tray and quit handling of lifecycle.rs. Before
// any of that it settles the userData directory and refuses to start while
// the Electron build holds it; once no other instance of this build runs, it
// starts the log in the directory and loads the app config.

// Builds in the release profile (the ones that get bundled) must not open a
// console next to the window on Windows. build.rs sets `release_profile`, from
// the same check that keeps the dev-tools feature out of that profile, so
// every build with the development tools keeps its console.
#![cfg_attr(release_profile, windows_subsystem = "windows")]

mod analytics_commands;
mod app_config;
#[cfg(test)]
mod capability_files;
mod command_error;
mod definition;
mod dev_commands;
mod dialog;
mod events;
mod file_commands;
mod hid_commands;
#[cfg(test)]
mod ipc_contract;
mod lifecycle;
mod main_window;
mod navigation;
mod shell;
mod shutdown;
mod store_commands;
mod sync_commands;
mod typing_dataset_commands;
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
        store_commands::sync_pending::sync_has_pending_changes,
        file_commands::file_save_layout,
        file_commands::file_load_layout,
        file_commands::file_export_keymap_c,
        file_commands::file_export_pdf,
        file_commands::file_export_csv,
        file_commands::file_export_csv_bundle,
        file_commands::file_export_json,
        file_commands::file_sideload_json,
        store_commands::keyboard_data::list_stored_keyboards,
        store_commands::keyboard_data::keyboard_meta_name_if_missing,
        store_commands::favorites::favorite_store_list,
        store_commands::favorites::favorite_store_save,
        store_commands::favorites::favorite_store_load,
        store_commands::favorites::favorite_store_rename,
        store_commands::favorites::favorite_store_delete,
        store_commands::favorites::favorite_store_set_hub_post_id,
        store_commands::favorites::favorite_store_set_hub_private,
        store_commands::favorites::favorite_store_read_for_export,
        store_commands::favorites::favorite_store_save_export,
        store_commands::favorites::favorite_store_open_import,
        store_commands::favorites::favorite_store_import_batch,
        store_commands::key_labels::key_label_store_list,
        store_commands::key_labels::key_label_store_list_all,
        store_commands::key_labels::key_label_store_get,
        store_commands::key_labels::key_label_store_rename,
        store_commands::key_labels::key_label_store_delete,
        store_commands::key_labels::key_label_store_import,
        store_commands::key_labels::key_label_store_export,
        store_commands::key_labels::key_label_store_reorder,
        store_commands::key_labels::key_label_store_set_hub_post_id,
        store_commands::key_labels::key_label_store_has_name,
        store_commands::typing_texts::typing_test_text_store_list,
        store_commands::typing_texts::typing_test_text_store_get,
        store_commands::typing_texts::typing_test_text_store_rename,
        store_commands::typing_texts::typing_test_text_store_delete,
        store_commands::typing_texts::typing_test_text_store_import,
        store_commands::typing_texts::typing_test_text_store_import_confirm,
        store_commands::snapshots::snapshot_store_list,
        store_commands::snapshots::snapshot_store_save,
        store_commands::snapshots::snapshot_store_load,
        store_commands::snapshots::snapshot_store_update,
        store_commands::snapshots::snapshot_store_rename,
        store_commands::snapshots::snapshot_store_delete,
        store_commands::snapshots::snapshot_store_set_hub_post_id,
        store_commands::snapshots::snapshot_store_set_hub_private,
        store_commands::analyze_filters::analyze_filter_store_list,
        store_commands::analyze_filters::analyze_filter_store_save,
        store_commands::analyze_filters::analyze_filter_store_load,
        store_commands::analyze_filters::analyze_filter_store_update,
        store_commands::analyze_filters::analyze_filter_store_rename,
        store_commands::analyze_filters::analyze_filter_store_delete,
        store_commands::analyze_filters::analyze_filter_store_set_hub_post_id,
        store_commands::analyze_filters::analyze_filter_store_set_hub_private,
        store_commands::run_logs::typing_run_log_save,
        store_commands::run_logs::typing_run_log_list,
        store_commands::run_logs::typing_run_log_get,
        analytics_commands::keymaps::typing_analytics_save_keymap_snapshot,
        analytics_commands::keymaps::typing_analytics_get_keymap_snapshot_for_range,
        analytics_commands::keymaps::typing_analytics_list_keymap_snapshots,
        analytics_commands::record::typing_analytics_event,
        analytics_commands::record::typing_analytics_flush,
        analytics_commands::data::typing_analytics_delete_items,
        analytics_commands::data::typing_analytics_delete_all,
        analytics_commands::data::typing_analytics_delete_device_data,
        analytics_commands::data::typing_analytics_export,
        analytics_commands::data::typing_analytics_import,
        store_commands::settings::pipette_settings_read,
        store_commands::settings::pipette_settings_write,
        store_commands::settings::pipette_settings_ensure_dir,
        store_commands::settings::pipette_settings_read_all,
        typing_dataset_commands::lang_list,
        typing_dataset_commands::lang_get,
        typing_dataset_commands::lang_download,
        typing_dataset_commands::lang_delete,
        typing_dataset_commands::typing_dataset_check,
        typing_dataset_commands::typing_dataset_update,
        typing_dataset_commands::aozora_import,
        analytics_commands::queries::typing_analytics_list_keyboards,
        analytics_commands::queries::typing_analytics_list_items,
        analytics_commands::queries::typing_analytics_list_items_local,
        analytics_commands::queries::typing_analytics_list_items_for_hash,
        analytics_commands::queries::typing_analytics_list_interval_items,
        analytics_commands::queries::typing_analytics_list_interval_items_local,
        analytics_commands::queries::typing_analytics_list_interval_items_for_hash,
        analytics_commands::queries::typing_analytics_list_activity_grid,
        analytics_commands::queries::typing_analytics_list_activity_grid_local,
        analytics_commands::queries::typing_analytics_list_activity_grid_for_hash,
        analytics_commands::queries::typing_analytics_list_layer_usage,
        analytics_commands::queries::typing_analytics_list_layer_usage_local,
        analytics_commands::queries::typing_analytics_list_layer_usage_for_hash,
        analytics_commands::queries::typing_analytics_list_matrix_cells,
        analytics_commands::queries::typing_analytics_list_matrix_cells_local,
        analytics_commands::queries::typing_analytics_list_matrix_cells_for_hash,
        analytics_commands::queries::typing_analytics_list_matrix_cells_by_day,
        analytics_commands::queries::typing_analytics_list_matrix_cells_by_day_local,
        analytics_commands::queries::typing_analytics_list_matrix_cells_by_day_for_hash,
        analytics_commands::queries::typing_analytics_list_minute_stats,
        analytics_commands::queries::typing_analytics_list_minute_stats_local,
        analytics_commands::queries::typing_analytics_list_minute_stats_for_hash,
        analytics_commands::queries::typing_analytics_list_sessions,
        analytics_commands::queries::typing_analytics_list_sessions_local,
        analytics_commands::queries::typing_analytics_list_sessions_for_hash,
        analytics_commands::queries::typing_analytics_list_bks_minute,
        analytics_commands::queries::typing_analytics_list_bks_minute_local,
        analytics_commands::queries::typing_analytics_list_bks_minute_for_hash,
        analytics_commands::queries::typing_analytics_get_peak_records,
        analytics_commands::queries::typing_analytics_get_peak_records_local,
        analytics_commands::queries::typing_analytics_get_peak_records_for_hash,
        analytics_commands::queries::typing_analytics_get_matrix_heatmap,
        analytics_commands::queries::typing_analytics_list_device_infos,
        analytics_commands::queries::typing_analytics_list_local_device_days,
        analytics_commands::range::typing_analytics_list_apps_for_range,
        analytics_commands::range::typing_analytics_list_typing_tests_for_range,
        analytics_commands::range::typing_analytics_list_typing_test_runs_for_range,
        analytics_commands::range::typing_analytics_get_app_usage_for_range,
        analytics_commands::range::typing_analytics_get_wpm_by_app_for_range,
        analytics_commands::range::typing_analytics_get_matrix_heatmap_for_range,
        analytics_commands::range::typing_analytics_get_bigram_aggregate_for_range,
        analytics_commands::range::typing_analytics_list_rollover_minutes,
        analytics_commands::range::typing_analytics_list_duration_cells,
        analytics_commands::range::typing_analytics_get_layout_comparison_for_range,
        store_commands::i18n_packs::i18n_pack_store_list,
        store_commands::i18n_packs::i18n_pack_store_get,
        store_commands::i18n_packs::i18n_pack_store_rename,
        store_commands::i18n_packs::i18n_pack_store_set_enabled,
        store_commands::i18n_packs::i18n_pack_store_refresh_coverage,
        store_commands::i18n_packs::i18n_pack_store_delete,
        store_commands::i18n_packs::i18n_pack_store_set_hub_post_id,
        store_commands::i18n_packs::i18n_pack_store_has_name,
        store_commands::i18n_packs::i18n_pack_store_reorder,
        store_commands::i18n_packs::i18n_pack_import,
        store_commands::i18n_packs::i18n_pack_import_apply,
        store_commands::i18n_packs::i18n_pack_export,
        store_commands::theme_packs::theme_pack_store_list,
        store_commands::theme_packs::theme_pack_store_get,
        store_commands::theme_packs::theme_pack_store_rename,
        store_commands::theme_packs::theme_pack_store_delete,
        store_commands::theme_packs::theme_pack_store_set_hub_post_id,
        store_commands::theme_packs::theme_pack_store_has_name,
        store_commands::theme_packs::theme_pack_store_reorder,
        store_commands::theme_packs::theme_pack_import,
        store_commands::theme_packs::theme_pack_import_apply,
        store_commands::theme_packs::theme_pack_export,
        sync_commands::auth::sync_auth_status,
        sync_commands::auth::sync_auth_start,
        sync_commands::auth::sync_auth_sign_out,
        sync_commands::password::sync_password_status,
        sync_commands::password::sync_set_password,
        sync_commands::password::sync_replace_password,
        sync_commands::password::sync_check_password_exists,
        sync_commands::preflight::sync_format_status,
        sync_commands::data::export_local_data,
        sync_commands::data::import_local_data,
        sync_commands::execute::sync_execute,
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
            store_commands::sync_pending::manage(app.handle(), &app.state::<UserDataDir>().0);
            dev_commands::manage_dialogs(app.handle());
            dev_commands::manage_http(app.handle());
            sync_commands::manage(app.handle(), &app.state::<UserDataDir>().0);
            dev_commands::manage_auth_browser(app.handle());
            typing_dataset_commands::manage(app.handle(), &app.state::<UserDataDir>().0);
            store_commands::keyboard_data::manage(app.handle(), &app.state::<UserDataDir>().0);
            analytics_commands::manage(app.handle(), &app.state::<UserDataDir>().0);
            sync_commands::preflight::manage(app.handle());
            sync_commands::execute::manage(app.handle());
            sync_commands::adopt_pending_at_startup(app.handle());
            sync_commands::triggers::start(app.handle());
            analytics_commands::start(app.handle());
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
