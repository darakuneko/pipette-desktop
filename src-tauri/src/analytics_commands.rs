// SPDX-License-Identifier: GPL-2.0-or-later
//! The typing analytics (crates/pipette-typing-analytics) in the app: the
//! analytics service, whose initialization starts at launch without being
//! waited for, as `setupTypingAnalytics` runs in the Electron main process,
//! and the sync lock the resets, deletes and imports hold.

use std::path::Path;
use std::sync::Arc;

use pipette_entry_store::{RandomUuid, SystemClock};
use pipette_typing_analytics::{Error, MachineIdentity, RebuildCache, SyncRuntime, TypingAnalytics};
use tauri::{AppHandle, Manager, Runtime};

/// Manages the analytics of `user_data` and the sync lock, and starts the
/// initialization. A failure is logged; the next command that waits for
/// the analytics tries again.
pub fn manage<R: Runtime>(app: &AppHandle<R>, user_data: &Path) {
    let identity = MachineIdentity::system(user_data, Arc::new(RandomUuid));
    let analytics =
        Arc::new(TypingAnalytics::new(user_data, identity, Arc::new(SystemClock), rebuild_unavailable()));
    app.manage(SyncRuntime::new());
    app.manage(analytics.clone());
    tauri::async_runtime::spawn(async move {
        if let Err(err) = analytics.ready().await {
            log::error!("Failed to initialize typing analytics: {err}");
        }
    });
}

/// The app does not rebuild the cache from the JSONL masters: a cache that
/// needs a rebuild fails the initialization, and `sync_state.json` is left
/// as it is, so the rebuild stays due.
fn rebuild_unavailable() -> RebuildCache {
    Arc::new(|_, _, _| Err(Error::CacheRebuild("rebuilding from the JSONL masters is not available".into())))
}
