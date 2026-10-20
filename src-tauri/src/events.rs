// SPDX-License-Identifier: GPL-2.0-or-later
//! The events the backend sends to the pages, named by the `IpcChannels`
//! strings (src/shared/ipc/channels.ts) the shim's `subscribe`
//! (src/tauri-shim/ipc.ts) listens on.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

/// `IpcChannels.SYNC_PENDING_STATUS`: whether any sync unit is pending.
pub const SYNC_PENDING_STATUS: &str = "sync:pending-status";

/// `IpcChannels.SYNC_FORMAT_STATUS_CHANGED`: the sync-format status of the
/// update banner changed (`None` once forgotten).
pub const SYNC_FORMAT_STATUS_CHANGED: &str = "sync:format-status-changed";

/// `IpcChannels.SYNC_PROGRESS`: a sync pass's progress (`SyncProgress`).
pub const SYNC_PROGRESS: &str = "sync:progress";

/// `IpcChannels.SYNC_UNIT_APPLIED`: a sync merge rewrote a unit's local
/// files (`{ syncUnit }`).
pub const SYNC_UNIT_APPLIED: &str = "sync:unit-applied";

/// `IpcChannels.I18N_PACK_CHANGED`: the language packs changed outside the
/// page's own calls.
pub const I18N_PACK_CHANGED: &str = "i18n-pack:changed";

/// `IpcChannels.THEME_PACK_CHANGED`: a theme pack was imported, renamed,
/// reordered, deleted or linked to the Hub.
pub const THEME_PACK_CHANGED: &str = "theme-pack:changed";

/// Sends `payload` on `event` to every page. A failure is logged.
pub fn emit_all<R: Runtime, S: Serialize + Clone>(app: &AppHandle<R>, event: &str, payload: S) {
    if let Err(err) = app.emit(event, payload) {
        log::error!("failed to emit {event}: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_events_have_the_names_of_their_ipc_channels() {
        let channels = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/shared/ipc/channels.ts"),
        )
        .unwrap();
        for (key, event) in [
            ("SYNC_PENDING_STATUS", SYNC_PENDING_STATUS),
            ("SYNC_FORMAT_STATUS_CHANGED", SYNC_FORMAT_STATUS_CHANGED),
            ("SYNC_PROGRESS", SYNC_PROGRESS),
            ("SYNC_UNIT_APPLIED", SYNC_UNIT_APPLIED),
            ("I18N_PACK_CHANGED", I18N_PACK_CHANGED),
            ("THEME_PACK_CHANGED", THEME_PACK_CHANGED),
            ("UPDATE_PROGRESS", crate::updater::UPDATE_PROGRESS),
        ] {
            let line = format!("  {key}: '{event}',");
            assert!(channels.lines().any(|l| l == line), "channels.ts has no line {line:?}");
        }
    }
}
