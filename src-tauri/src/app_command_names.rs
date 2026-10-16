// SPDX-License-Identifier: GPL-2.0-or-later
//
// The app commands by name, the one list of them. build.rs includes this
// file to generate their permissions. The IPC contract tests
// (src/ipc_contract.rs) run every invoke fixture through the handler of
// these commands and export the list for the shim
// (src/tauri-shim/generated/app-command-names.ts); the tests of
// src/dev_commands/tools.rs check that none of these is routed as a
// development command.

/// The commands of `app_commands` in src/main.rs.
pub const APP_COMMANDS: &[&str] = &[
    // src/hid_commands.rs
    "list_devices",
    "open_device",
    "close_device",
    "send_receive",
    "send",
    "is_device_open",
    "hid_probe_open",
    "hid_probe_send_receive",
    "hid_probe_close",
    // src/definition.rs
    "decompress_definition",
    // src/app_config.rs
    "app_config_get_all",
    "app_config_set",
    // src/shell.rs
    "open_external",
    // src/window_commands.rs
    "set_window_zoom",
    "window_show",
    "window_hide",
    "window_started_hidden",
    "window_is_visible",
    // src/store_commands/sync_pending.rs
    "sync_has_pending_changes",
    // src/file_commands.rs
    "file_save_layout",
    "file_load_layout",
    "file_export_keymap_c",
    "file_export_pdf",
    "file_export_csv",
    "file_export_csv_bundle",
    "file_export_json",
    "file_sideload_json",
    // src/store_commands/keyboard_data.rs
    "list_stored_keyboards",
    "keyboard_meta_name_if_missing",
    // src/store_commands/favorites.rs
    "favorite_store_list",
    "favorite_store_save",
    "favorite_store_load",
    "favorite_store_rename",
    "favorite_store_delete",
    "favorite_store_set_hub_post_id",
    "favorite_store_set_hub_private",
    "favorite_store_read_for_export",
    "favorite_store_save_export",
    "favorite_store_open_import",
    "favorite_store_import_batch",
    // src/store_commands/snapshots.rs
    "snapshot_store_list",
    "snapshot_store_save",
    "snapshot_store_load",
    "snapshot_store_update",
    "snapshot_store_rename",
    "snapshot_store_delete",
    "snapshot_store_set_hub_post_id",
    "snapshot_store_set_hub_private",
    // src/store_commands/settings.rs
    "pipette_settings_read",
    "pipette_settings_write",
    "pipette_settings_ensure_dir",
    "pipette_settings_read_all",
    // src/typing_dataset_commands.rs
    "lang_list",
    "lang_get",
    "lang_download",
    "lang_delete",
    "typing_dataset_check",
    "typing_dataset_update",
];
