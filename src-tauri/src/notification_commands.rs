// SPDX-License-Identifier: GPL-2.0-or-later
//! The command behind the shim's notification member
//! (src/tauri-shim/api/notification.ts): `NOTIFICATION_FETCH` of
//! src/main/notification-store.ts, the startup notices. This build does not
//! fetch them yet and answers as a failed fetch, which the renderer treats
//! as no notices.

use serde_json::{Value, json};

#[tauri::command]
pub fn notification_fetch() -> Value {
    log::warn!("[notification] notificationFetch is not implemented");
    json!({ "success": false, "error": "not implemented" })
}
