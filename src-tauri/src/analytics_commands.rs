// SPDX-License-Identifier: GPL-2.0-or-later
//! The typing analytics (crates/pipette-typing-analytics) in the app: the
//! analytics service and the sync lock the resets, deletes and imports
//! hold.
//!
//! The initialization is not started at launch, unlike
//! `setupTypingAnalytics` in the Electron main process: this build cannot
//! rebuild the cache from the JSONL masters yet, and an initialization
//! that needs a rebuild only fails. Nothing opens `typing-analytics.db` or
//! reads `sync_state.json` until a command waits for the analytics.

use std::path::Path;
use std::sync::Arc;

use pipette_entry_store::{RandomUuid, SystemClock};
use pipette_typing_analytics::{Error, MachineIdentity, RebuildCache, SyncRuntime, TypingAnalytics};
use tauri::{AppHandle, Manager, Runtime};

/// Manages the analytics of `user_data` and the sync lock. The analytics
/// initialize when a command first waits for them.
pub fn manage<R: Runtime>(app: &AppHandle<R>, user_data: &Path) {
    let identity = MachineIdentity::system(user_data, Arc::new(RandomUuid));
    let analytics =
        Arc::new(TypingAnalytics::new(user_data, identity, Arc::new(SystemClock), rebuild_unavailable()));
    app.manage(SyncRuntime::new());
    app.manage(analytics);
}

/// The app does not rebuild the cache from the JSONL masters: a cache that
/// needs a rebuild fails the initialization, which rolls back a migration
/// that dropped tables and leaves `sync_state.json` as it is, so the
/// rebuild stays due.
fn rebuild_unavailable() -> RebuildCache {
    Arc::new(|_, _, _| Err(Error::CacheRebuild("rebuilding from the JSONL masters is not available".into())))
}
