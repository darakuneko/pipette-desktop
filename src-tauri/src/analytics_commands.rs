// SPDX-License-Identifier: GPL-2.0-or-later
//! The typing analytics (crates/pipette-typing-analytics) in the app: the
//! analytics service, its recorder, and the sync lock the resets, deletes
//! and imports hold, and the commands of each area ([`keymaps`],
//! [`queries`], [`range`], [`record`]).
//!
//! The initialization is not started at launch, unlike
//! `setupTypingAnalytics` in the Electron main process: this build cannot
//! replay the JSONL masters into the cache yet, so an initialization that
//! needs a rebuild succeeds only when there is no day file to replay (a
//! new installation) and fails otherwise. Nothing opens
//! `typing-analytics.db` or reads `sync_state.json` until a command or a
//! recording flush waits for the analytics.

use std::path::Path;
use std::sync::Arc;

use pipette_entry_store::{RandomUuid, SystemClock};
use pipette_typing_analytics::jsonl::list_all_device_day_jsonl_files;
use pipette_typing_analytics::{Error, MachineIdentity, RebuildCache, SyncRuntime, TypingAnalytics};
use tauri::{AppHandle, Manager, Runtime};

pub mod keymaps;
pub mod queries;
pub mod range;
pub mod record;

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
        Arc::new(TypingAnalytics::new(user_data, identity, Arc::new(SystemClock), rebuild_without_masters()));
    app.manage(SyncRuntime::new());
    app.manage(record::recorder(app, analytics.clone()));
    app.manage(analytics);
}

/// The rebuild of a cache with no day file to replay: the data tables
/// emptied, as `rebuildCacheFromMasterFiles` leaves them when it finds no
/// file. With any day file the app does not rebuild: the initialization
/// fails, which rolls back a migration that dropped tables and leaves
/// `sync_state.json` as it is, so the rebuild stays due.
fn rebuild_without_masters() -> RebuildCache {
    Arc::new(|db, user_data, _| {
        if !list_all_device_day_jsonl_files(user_data).is_empty() {
            return Err(Error::CacheRebuild("rebuilding from the JSONL masters is not available".into()));
        }
        Ok(db.truncate_cache()?)
    })
}

#[cfg(test)]
mod tests {
    use tauri::async_runtime::block_on;
    use tempfile::TempDir;

    use super::*;

    fn analytics(user_data: &TempDir) -> Arc<TypingAnalytics> {
        let app = tauri::test::mock_app();
        manage_with_machine_id(app.handle(), user_data.path(), "machine");
        app.state::<Arc<TypingAnalytics>>().inner().clone()
    }

    #[test]
    fn a_new_installation_initializes_with_an_empty_cache() {
        let user_data = TempDir::new().unwrap();
        let ready = block_on(analytics(&user_data).ready()).unwrap();
        assert_eq!(ready.sync_state.lock().unwrap().my_device_id.as_str(), Some(ready.machine_hash.as_str()));
        assert!(pipette_typing_analytics::sync_state::sync_state_path(user_data.path()).exists());
    }

    #[test]
    fn day_files_to_replay_fail_the_initialization_and_leave_the_state_unwritten() {
        let user_data = TempDir::new().unwrap();
        let day = user_data.path().join("sync/keyboards/0xA1/devices/h/2026-04-14.jsonl");
        std::fs::create_dir_all(day.parent().unwrap()).unwrap();
        std::fs::write(&day, "").unwrap();
        let failed = block_on(analytics(&user_data).ready()).err().unwrap();
        assert!(matches!(*failed, Error::CacheRebuild(_)));
        assert!(!pipette_typing_analytics::sync_state::sync_state_path(user_data.path()).exists());
    }
}
