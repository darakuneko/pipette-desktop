// SPDX-License-Identifier: GPL-2.0-or-later
//
// The development commands of src/dev_commands/tools.rs by name. build.rs
// includes this file to generate their permissions in builds with the
// dev-tools feature only, and tools.rs routes these names to its own
// handler.

/// The development commands on every platform.
pub const DEV_COMMANDS: &[&str] = &[
    "virtual_device_press_key",
    "virtual_device_release_key",
    "virtual_device_release_all",
    "virtual_device_hold_keys",
    "virtual_device_set_unlock_counter_max",
    "virtual_device_get_state",
    "virtual_device_reset",
    "dev_log",
    "dev_dialog_respond",
    "dev_dialog_queued",
    "dev_http_respond",
    "dev_http_queued",
    "dev_typing_analytics_machine_hash",
    "dev_sync_last_auth_url",
];

/// The development commands that exist on Linux only.
pub const LINUX_DEV_COMMANDS: &[&str] = &["dev_screenshot"];
