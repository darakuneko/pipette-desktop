// SPDX-License-Identifier: GPL-2.0-or-later
//! The Hub account: the Hub origin, the display name of the next Hub token,
//! and the account's own record (the account handlers of
//! src/main/hub/hub-ipc-posts.ts). Each answers `null` until its handler is
//! written.

use serde_json::Value;

#[tauri::command]
pub fn hub_get_origin() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_set_auth_display_name() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_fetch_auth_me() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_patch_auth_me() -> Value {
    super::not_implemented()
}
