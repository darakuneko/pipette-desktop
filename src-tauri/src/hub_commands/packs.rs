// SPDX-License-Identifier: GPL-2.0-or-later
//! The language and theme packs on the Hub (src/main/hub/hub-ipc-packs.ts).
//! Each answers `null` until its handler is written.

use serde_json::Value;

#[tauri::command]
pub fn i18n_pack_hub_timestamps() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_list_i18n_posts() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_download_i18n_post() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_upload_i18n_post() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_update_i18n_post() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_delete_i18n_post() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn theme_pack_hub_timestamps() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_list_theme_posts() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_download_theme_post() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_upload_theme_post() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_update_theme_post() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_delete_theme_post() -> Value {
    super::not_implemented()
}
