// SPDX-License-Identifier: GPL-2.0-or-later
//! The Analyze posts and their preview (src/main/hub/hub-ipc-analytics.ts).
//! Each answers `null` until its handler is written.

use serde_json::Value;

#[tauri::command]
pub fn hub_upload_analytics_post() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_update_analytics_post() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_preview_analytics_post() -> Value {
    super::not_implemented()
}

#[tauri::command]
pub fn hub_upload_private_analytics_post() -> Value {
    super::not_implemented()
}
