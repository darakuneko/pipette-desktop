// SPDX-License-Identifier: GPL-2.0-or-later
//! The per-keyboard stores under the userData directory, writing the same
//! files as the Electron build:
//!
//! - the key labels (`sync/key-labels`, the sync unit of the same name) of
//!   src/main/key-label-store.ts, kept across keyboards;
//! - the typing test texts (`sync/typing-test-texts`, the sync unit of the
//!   same name) of src/main/typing-test-text-store.ts, kept across
//!   keyboards;
//! - the favorites of each type (`sync/favorites/{type}`, the sync unit of
//!   the same name) of src/main/favorite-store.ts;
//! - the keyboard names (`sync/meta/keyboard-names.json`, the sync unit
//!   `meta/keyboard-names`) of src/main/sync/keyboard-meta.ts: the name a
//!   keyboard gets when it connects, the name a snapshot save, the
//!   stored-keyboard list or the sync's backfill records, and the
//!   tombstones a reset leaves;
//! - the list of stored keyboards (`sync/keyboards/{uid}`) of the
//!   `LIST_STORED_KEYBOARDS` handler in src/main/sync/sync-ipc.ts;
//! - the snapshots of a keyboard (`sync/keyboards/{uid}/snapshots`, the
//!   sync unit of the same name) of src/main/snapshot-store.ts;
//! - the saved Analyze filters of a keyboard
//!   (`sync/keyboards/{uid}/analyze_filters`, the sync unit of the same
//!   name) of src/main/analyze-filter-store.ts;
//! - the keystroke logs of a keyboard's Typing Test runs
//!   (`sync/keyboards/{uid}/runs`, the sync unit of the same name) of
//!   src/main/typing-run-log-store.ts;
//! - the pipette settings of a keyboard
//!   (`sync/keyboards/{uid}/pipette_settings.json`, the sync unit
//!   `keyboards/{uid}/settings`) of src/main/pipette-settings-store.ts,
//!   stored as text whose content rules stay with the caller.
//!
//! Every store works through a [`StoreContext`]: the userData directory,
//! the clock, the ids of new entries, the process-wide write locks shared
//! by all stores, and the [`ChangeNotifier`] each change of a sync unit is
//! reported to. The stores of other crates (the pack stores) work through
//! the same context.

mod analyze_filters;
mod coded_error;
mod entry_files;
mod entry_index;
mod favorites;
mod key_labels;
mod keyboard_index;
mod keyboard_meta;
mod keyboard_meta_backfill;
mod keyboard_meta_sync;
mod response;
mod run_logs;
mod settings;
mod snapshot_filename;
mod snapshots;
mod stored_keyboards;
mod typing_texts;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use pipette_entry_store::{Clock, IdGen, RandomUuid, WriteLocks};

pub use analyze_filters::{
    AnalyzeFilterError, MAX_ANALYZE_FILTERS_PER_KEYBOARD, analyze_filters_sync_unit, delete_analyze_filter,
    list_analyze_filters, load_analyze_filter, rename_analyze_filter, save_analyze_filter,
    set_analyze_filter_hub_post_id, set_analyze_filter_hub_private, update_analyze_filter,
};
pub use coded_error::{CodedStoreError, ErrorCode, coded_store_response};
pub use entry_index::MAX_NAME_LENGTH;
pub use favorites::{
    FavoriteError, FavoriteImport, FavoriteType, ImportCounts, delete_favorite, import_favorites,
    list_favorites, load_favorite, read_favorites_for_export, rename_favorite, save_favorite,
    set_favorite_hub_post_id, set_favorite_hub_private,
};
pub use key_labels::{
    KEY_LABEL_SYNC_UNIT, KeyLabelError, KeyLabelErrorCode, KeyLabelExport, KeyLabelSave, QWERTY_ENTRY_ID,
    delete_key_label, export_key_label, get_key_label, has_key_label_name, import_key_label_files,
    key_label_response, list_key_labels, rename_key_label, reorder_key_labels, save_key_label,
    set_key_label_hub_post_id,
};
pub use keyboard_meta::{
    KEYBOARD_META_SYNC_UNIT, MetaOutcome, TombstoneOutcome, active_keyboard_names,
    extract_device_name_from_filename, keyboard_meta_name_if_missing, name_keyboard_on_connect,
    name_unnamed_keyboards, tombstone_all_keyboard_meta, tombstone_keyboard_meta, upsert_keyboard_meta,
};
pub use keyboard_meta_backfill::{
    keyboard_meta_uids, keyboard_uids_of_drive_names, resolve_device_name_from_local_snapshots,
    snapshot_index_device_name,
};
pub use keyboard_meta_sync::{
    KeyboardMetaMerge, KeyboardMetaMergeError, apply_remote_keyboard_meta_index, read_keyboard_meta_index,
};
pub use response::{CodedError, coded_response, coded_response_json, done, field, response_json};
pub use run_logs::{
    MAX_RUN_LOG_BYTES, MAX_RUN_LOG_EVENTS, MAX_RUN_LOGS_PER_KEYBOARD, RunLogError, get_run_log,
    list_run_logs, run_logs_sync_unit, save_run_log,
};
pub use settings::{
    KeyboardSettingsFile, SETTINGS_ETAG_ABSENT, SettingsError, SettingsFile, SettingsWrite,
    ensure_pipette_settings_dir, keyboard_settings_files_json, read_all_pipette_settings,
    read_pipette_settings, settings_sync_unit, write_pipette_settings,
};
pub use snapshot_filename::{
    MAX_SNAPSHOT_DEVICE_NAME_BYTES, build_snapshot_filename, cap_snapshot_device_name,
};
pub use snapshots::{
    MAX_SNAPSHOTS_PER_KEYBOARD, SnapshotError, delete_snapshot, list_snapshots, load_snapshot,
    rename_snapshot, save_snapshot, set_snapshot_hub_post_id, set_snapshot_hub_private, snapshots_sync_unit,
    update_snapshot,
};
pub use stored_keyboards::{StoredKeyboard, list_stored_keyboards, stored_keyboards_json};
pub use typing_texts::{
    TYPING_TEXT_MAX_FILE_BYTES, TYPING_TEXT_SYNC_UNIT, TypingTextError, TypingTextErrorCode, TypingTextSave,
    TypingTextSource, TypingTextStore, typing_text_response,
};

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
    /// The TypeError JavaScript's strict mode throws where a store sets a
    /// property of an entry that is not an object (its JSON text here).
    #[error("Cannot create property '{0}' on {1}")]
    PrimitiveEntry(&'static str, String),
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

    /// `{userData}/sync`, where the synced stores keep their files.
    pub fn sync_dir(&self) -> PathBuf {
        self.user_data.join("sync")
    }

    /// The clock's time, in milliseconds since the epoch.
    pub fn now_ms(&self) -> i64 {
        self.clock.now_ms()
    }

    /// The id of a new entry.
    pub fn new_id(&self) -> String {
        self.ids.new_id()
    }

    /// Reports a change of the sync unit `unit`.
    pub fn notify(&self, unit: &str) {
        self.notifier.notify_change(unit);
    }

    /// The write locks of the process.
    pub fn locks(&self) -> &WriteLocks {
        &self.locks
    }

    /// The write locks of the process, for a writer outside the stores
    /// (the typing analytics' deleted-ranges files).
    pub fn shared_locks(&self) -> Arc<WriteLocks> {
        self.locks.clone()
    }
}
