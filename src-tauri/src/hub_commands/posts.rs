// SPDX-License-Identifier: GPL-2.0-or-later
//! The keymap posts and the private posts (src/main/hub/hub-ipc-posts.ts and
//! hub-ipc-private.ts). Each answers `null` until its handler is written.

use serde_json::Value;

#[tauri::command]
pub fn hub_upload_post() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_update_post() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_patch_post() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_delete_post() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_fetch_my_posts() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_fetch_my_keyboard_posts() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_upload_private_post() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_delete_private_post() -> Value {
    super::not_implemented()
}
