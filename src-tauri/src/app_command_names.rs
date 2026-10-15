// SPDX-License-Identifier: GPL-2.0-or-later
//
// The app commands by name, the one list of them. build.rs includes this
// file to generate their permissions. The IPC contract tests
// (src/ipc_contract.rs) check the invoke fixtures against it and export it
// for the shim's command table (src/tauri-shim/commands.ts); the tests of
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
    // src/definition.rs
    "decompress_definition",
];
