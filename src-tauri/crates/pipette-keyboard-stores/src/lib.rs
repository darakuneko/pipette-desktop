// SPDX-License-Identifier: GPL-2.0-or-later
//! The per-keyboard stores under the userData directory, writing the same
//! files as the Electron build:
//!
//! - the keyboard names (`sync/meta/keyboard-names.json`, the sync unit
//!   `meta/keyboard-names`) of src/main/sync/keyboard-meta.ts: the name a
//!   keyboard gets when it connects, and the name a snapshot save or the
//!   stored-keyboard list records;
//! - the list of stored keyboards (`sync/keyboards/{uid}`) of the
//!   `LIST_STORED_KEYBOARDS` handler in src/main/sync/sync-ipc.ts;
//! - the snapshots of a keyboard (`sync/keyboards/{uid}/snapshots`, the
//!   sync unit of the same name) of src/main/snapshot-store.ts.
//!
//! Every store works through a [`StoreContext`]: the userData directory,
//! the clock, the ids of new entries, the process-wide write locks shared
//! by all stores, and the [`ChangeNotifier`] each change of a sync unit is
//! reported to.

mod keyboard_meta;
mod snapshot_filename;
mod snapshots;
mod stored_keyboards;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use pipette_entry_store::{Clock, IdGen, RandomUuid, WriteLocks};

pub use keyboard_meta::{
    KEYBOARD_META_SYNC_UNIT, MetaOutcome, active_keyboard_names, extract_device_name_from_filename,
    keyboard_meta_name_if_missing, name_keyboard_on_connect, upsert_keyboard_meta,
};
pub use snapshot_filename::{
    MAX_SNAPSHOT_DEVICE_NAME_BYTES, build_snapshot_filename, cap_snapshot_device_name,
};
pub use snapshots::{
    MAX_SNAPSHOTS_PER_KEYBOARD, SnapshotError, delete_snapshot, list_snapshots, load_snapshot,
    rename_snapshot, save_snapshot, set_snapshot_hub_post_id, set_snapshot_hub_private,
    snapshot_response_json, snapshots_sync_unit, update_snapshot,
};
pub use stored_keyboards::{StoredKeyboard, list_stored_keyboards, stored_keyboards_json};

/// Told the sync unit of each change a store makes (`notifyChange` of
/// src/main/sync/sync-flush.ts).
pub trait ChangeNotifier: Send + Sync {
    fn notify_change(&self, unit: &str);
}

impl<F: Fn(&str) + Send + Sync> ChangeNotifier for F {
    fn notify_change(&self, unit: &str) {
        self(unit);
    }
}

/// Why a store operation failed.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// The TypeError JavaScript throws where a store reads a property of a
    /// `null` entry in a file.
    #[error("Cannot read properties of null (reading '{0}')")]
    NullEntry(&'static str),
    /// A file nested deeper than pipette-js-json reads. `JSON.parse` reads
    /// it, so it is never replaced with what could be read of it.
    #[error("{0}: nested too deeply to read")]
    TooDeep(PathBuf),
}

/// What every store works with. Cheap to clone; the clones share the
/// locks, the clock and the notifier.
#[derive(Clone)]
pub struct StoreContext {
    user_data: PathBuf,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn IdGen>,
    locks: Arc<WriteLocks>,
    notifier: Arc<dyn ChangeNotifier>,
}

impl StoreContext {
    /// `locks` must be the one set of write locks of the process, shared by
    /// every store (and the sync merges), so the files of a key are written
    /// one task at a time. New entries get random UUIDs ([`Self::with_ids`]
    /// sets other ids).
    pub fn new(
        user_data: impl Into<PathBuf>,
        clock: Arc<dyn Clock>,
        locks: Arc<WriteLocks>,
        notifier: Arc<dyn ChangeNotifier>,
    ) -> Self {
        Self { user_data: user_data.into(), clock, ids: Arc::new(RandomUuid), locks, notifier }
    }

    /// The context with `ids` as the source of new entry ids.
    #[must_use]
    pub fn with_ids(mut self, ids: Arc<dyn IdGen>) -> Self {
        self.ids = ids;
        self
    }

    pub fn user_data(&self) -> &Path {
        &self.user_data
    }

    fn sync_dir(&self) -> PathBuf {
        self.user_data.join("sync")
    }

    fn now_ms(&self) -> i64 {
        self.clock.now_ms()
    }

    fn new_id(&self) -> String {
        self.ids.new_id()
    }

    fn notify(&self, unit: &str) {
        self.notifier.notify_change(unit);
    }
}
