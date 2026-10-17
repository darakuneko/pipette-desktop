// SPDX-License-Identifier: GPL-2.0-or-later
//! The favorite posts (src/main/hub/hub-ipc-favorite.ts) and
//! `hub_favorite_entry`, the read of the favorite entry whose export the page
//! builds. Each answers `null` until its handler is written.

use serde_json::Value;

#[tauri::command]
pub fn hub_upload_favorite_post() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_update_favorite_post() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_upload_private_favorite_post() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_favorite_entry() -> Value {
    super::not_implemented()
}
