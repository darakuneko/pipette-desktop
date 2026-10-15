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
];
