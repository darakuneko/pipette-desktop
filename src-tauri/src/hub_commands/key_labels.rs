// SPDX-License-Identifier: GPL-2.0-or-later
//! The key labels on the Hub (src/main/hub/hub-ipc-key-labels.ts). Each
//! answers `null` until its handler is written.

use serde_json::Value;

#[tauri::command]
pub fn key_label_hub_list() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn key_label_hub_detail() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn key_label_hub_download() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn key_label_hub_upload() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn key_label_hub_update() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn key_label_hub_sync() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn key_label_hub_timestamps() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn key_label_hub_delete() -> Value {
    super::not_implemented()
}
