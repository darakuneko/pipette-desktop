// SPDX-License-Identifier: GPL-2.0-or-later
//! The typing analytics (crates/pipette-typing-analytics) in the app: the
//! analytics service, its recorder, the operations of the Data modal on the
//! data, and the sync lock the resets, deletes and imports hold, and the
//! commands of each area ([`data`], [`keymaps`], [`queries`], [`range`],
//! [`record`]).
//!
//! The initialization starts at launch ([`start`]), as
//! `setupTypingAnalytics` does in the Electron main process: the schema
//! migration, the cache rebuild when `sync_state.json` asks for it (a
//! migration that dropped tables commits only with a rebuild that
//! succeeded) and, once it is done, the apply of this device's own deleted
//! ranges, which nothing waits for. The commands wait for the
//! initialization; one that fails is tried again by the next command or
//! flush.

use std::path::Path;
use std::sync::{Arc, Weak};

use pipette_entry_store::{Clock, RandomUuid, SystemClock, WriteLocks};
use pipette_keyboard_stores::StoreContext;
use pipette_typing_analytics::{
    DataOps, MachineIdentity, SyncRuntime, TypingAnalytics, rebuild_from_master_files,
};
use tauri::{AppHandle, Manager, Runtime};

pub mod data;
pub mod keymaps;
pub mod queries;
pub mod range;
pub mod record;

/// Manages the analytics of `user_data`, the operations on its data and the
/// sync lock. The deleted-ranges files are written under the write locks
/// of the stores (keyboard_data.rs), managed before this in the app; a
/// test app without the stores gets locks of its own.
pub fn manage<R: Runtime>(app: &AppHandle<R>, user_data: &Path) {
    manage_with_identity(app, user_data, MachineIdentity::system(user_data, Arc::new(RandomUuid)));
}

/// Starts the initialization of the analytics at launch, without waiting
/// for it. A failure is logged; the next command or flush tries again.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let analytics = app.state::<Arc<TypingAnalytics>>().inner().clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = analytics.ready().await {
            log::error!("Failed to initialize typing analytics: {err}");
        }
    });
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
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let analytics =
        Arc::new(TypingAnalytics::new(user_data, identity, clock.clone(), rebuild_from_master_files(clock)));
    let runtime = SyncRuntime::new();
    let recorder = record::recorder(app, analytics.clone());
    let locks =
        app.try_state::<StoreContext>().map_or_else(|| Arc::new(WriteLocks::new()), |s| s.shared_locks());
    let ops = Arc::new(DataOps::new(recorder.clone(), locks, Arc::new(RandomUuid)));
    analytics.on_initialized(apply_own_deleted_ranges_after_init(Arc::downgrade(&ops), runtime.clone()));
    app.manage(runtime);
    app.manage(recorder);
    app.manage(ops);
    app.manage(analytics);
}

/// What follows each initialization that succeeds: this device's own
/// deleted ranges of every keyboard applied, except to a keyboard a reset
/// holds, without anything waiting for it.
fn apply_own_deleted_ranges_after_init(
    ops: Weak<DataOps>,
    runtime: SyncRuntime,
) -> pipette_typing_analytics::InitializedHook {
    Box::new(move || {
        let (ops, runtime) = (ops.clone(), runtime.clone());
        tauri::async_runtime::spawn(async move {
            if let Some(ops) = ops.upgrade() {
                let holds = Arc::new(move |uid: &str| runtime.reset_holds_keyboard(uid));
                ops.apply_own_deleted_ranges_for_all_keyboards(holds).await;
            }
        });
    })
}

#[cfg(test)]
mod tests {
    use tauri::async_runtime::block_on;
    use tempfile::TempDir;

    use pipette_typing_analytics::Error;

    use super::*;

    /// One minute of a keyboard, as a day file holds it.
    const DAY: &str = concat!(
        r#"{"id":"s","kind":"scope","updated_at":1,"payload":{"id":"sc","machineHash":"h","osPlatform":"linux","osRelease":"6.8.0","osArch":"x64","keyboardUid":"0xA1","keyboardVendorId":1,"keyboardProductId":2,"keyboardProductName":"K"}}"#,
        "\n",
        r#"{"id":"m","kind":"minute-stats","updated_at":1,"payload":{"scopeId":"sc","minuteTs":1776124800000,"keystrokes":3,"activeMs":1,"intervalAvgMs":null,"intervalMinMs":null,"intervalP25Ms":null,"intervalP50Ms":null,"intervalP75Ms":null,"intervalMaxMs":null}}"#,
        "\n",
    );

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
    fn an_existing_installation_is_rebuilt_from_its_day_files() {
        let user_data = TempDir::new().unwrap();
        let day = user_data.path().join("sync/keyboards/0xA1/devices/h/2026-04-14.jsonl");
        std::fs::create_dir_all(day.parent().unwrap()).unwrap();
        std::fs::write(&day, DAY).unwrap();
        let ready = block_on(analytics(&user_data).ready()).unwrap();
        let minutes = block_on(ready.db.call(|db| db.keyboards_with_typing_data().unwrap().len())).unwrap();
        assert_eq!(minutes, 1);
        assert!(pipette_typing_analytics::sync_state::sync_state_path(user_data.path()).exists());
    }

    #[test]
    fn a_database_that_cannot_be_opened_fails_and_leaves_the_state_unwritten() {
        let user_data = TempDir::new().unwrap();
        std::fs::create_dir_all(user_data.path().join("local/typing-analytics.db")).unwrap();
        let failed = block_on(analytics(&user_data).ready()).err().unwrap();
        assert!(matches!(*failed, Error::Db(_)));
        assert!(!pipette_typing_analytics::sync_state::sync_state_path(user_data.path()).exists());
    }
}
