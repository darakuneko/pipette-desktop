// SPDX-License-Identifier: GPL-2.0-or-later
//! The events the backend sends to the pages, named by the `IpcChannels`
//! strings (src/shared/ipc/channels.ts) the Electron main process sends them
//! on, so the shim's `subscribe` (src/tauri-shim/ipc.ts) listens on the same
//! channel the preload does.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

/// `IpcChannels.SYNC_PENDING_STATUS`: whether any sync unit is pending.
pub const SYNC_PENDING_STATUS: &str = "sync:pending-status";

/// Sends `payload` on `event` to every page, as `broadcastToAllWindows`
/// (src/main/utils/broadcast.ts) does. A failure is logged.
pub fn emit_all<R: Runtime, S: Serialize + Clone>(app: &AppHandle<R>, event: &str, payload: S) {
    if let Err(err) = app.emit(event, payload) {
        log::error!("failed to emit {event}: {err}");
    }
}
