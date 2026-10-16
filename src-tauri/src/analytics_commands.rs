// SPDX-License-Identifier: GPL-2.0-or-later
//! The typing analytics (crates/pipette-typing-analytics) in the app: the
//! analytics service and the sync lock the resets, deletes and imports
//! hold, and the commands of each area ([`keymaps`], [`queries`], [`range`]).
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

pub mod keymaps;
pub mod queries;
pub mod range;

/// Manages the analytics of `user_data` and the sync lock. The analytics
/// initialize when a command first waits for them.
pub fn manage<R: Runtime>(app: &AppHandle<R>, user_data: &Path) {
    manage_with_identity(app, user_data, MachineIdentity::system(user_data, Arc::new(RandomUuid)));
}

/// [`manage`] with a fixed machine id, so the machine hash of a test does
/// not depend on the machine it runs on.
#[cfg(test)]
pub(crate) fn manage_with_machine_id<R: Runtime>(
    app: &AppHandle<R>,
    user_data: &Path,
    machine_id: &'static str,
) {
    let identity =
        MachineIdentity::new(user_data, Arc::new(RandomUuid), Box::new(move || Ok(machine_id.into())));
    manage_with_identity(app, user_data, identity);
}

/// Marks the cache of `user_data` up to date for the machine `machine_id`,
/// writing the installation id that hash takes, so the initialization of a
/// test needs no rebuild.
#[cfg(test)]
pub(crate) fn mark_cache_fresh(user_data: &Path, machine_id: &'static str) {
    use pipette_typing_analytics::sync_state::{TypingSyncState, save_sync_state};
    let identity =
        MachineIdentity::new(user_data, Arc::new(RandomUuid), Box::new(move || Ok(machine_id.into())));
    let hash = identity.machine_hash().unwrap();
    save_sync_state(user_data, &TypingSyncState::empty(&hash)).unwrap();
}

fn manage_with_identity<R: Runtime>(app: &AppHandle<R>, user_data: &Path, identity: MachineIdentity) {
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
