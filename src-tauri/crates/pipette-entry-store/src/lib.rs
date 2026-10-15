// SPDX-License-Identifier: GPL-2.0-or-later
//! The groundwork the index-based entry stores (favorites, snapshots,
//! analyze filters, key labels, typing-test texts, run logs, i18n and theme
//! packs) share with the Electron build, which keeps the same files:
//!
//! - the field groups of each store and their clocks (sync format v2):
//!   reading v1 / v2 entries ([`normalize_entry`]) and the clock writers
//!   every write path uses, so `updatedAt` is always [`derived_updated_at`];
//! - the write helpers built on them ([`create_entry`],
//!   [`overwrite_entry`], [`apply_entry_mutation`]);
//! - body filenames that carry the entry id, and the move of legacy names
//!   to them ([`migrate_body_filenames`]);
//! - the per-key write locks of the stores ([`WriteLocks`]);
//! - file-name helpers (UTF-8 truncation, path-segment checks).
//!
//! Entries are JSON objects with JavaScript's property order
//! ([`pipette_js_json::Object`]), so fields this build does not know and
//! the key order survive a read and a write byte for byte. Times are
//! milliseconds since the epoch, passed in (or read from a [`Clock`]).

mod body_filename;
mod canonical;
mod clocks;
mod entry;
mod migration;
mod normalize;
mod runtime;
mod safe_filename;
mod store_groups;
mod text;
mod write;
mod write_lock;

pub use body_filename::{
    MAX_BODY_FILENAME_BYTES, body_filename_has_id, id_body_filename, id_filename_segment,
};
pub use canonical::{body_fields_of, canonical_json, group_values};
pub use clocks::{
    EPOCH_ISO, EntryError, body_hash, clock_ms, derived_updated_at, mark_deleted, new_clocks, revive_entry,
    set_clock, touch_clock, valid_clock,
};
pub use entry::{Entry, EntryGroup, MetaGroup};
pub use migration::{
    EntryList, IndexDirRead, is_body_file_name, migrate_body_filenames, read_index_dir_migrated,
    read_index_migrated, unlink_unreferenced_body_files,
};
pub use normalize::{normalize_entries, normalize_entry};
pub use runtime::{Clock, IdGen, RandomUuid, SystemClock};
#[cfg(feature = "test-util")]
pub use runtime::{FixedClock, SequenceIds};
pub use safe_filename::{
    is_safe_key, is_safe_pack_id, is_safe_path, is_safe_path_segment, safe_filename, ts_for_export_filename,
    ts_for_filename,
};
pub use store_groups::{EntryStore, FilenameIdRule, RESERVED_FIELDS, StoreGroupDef, V1BodyClockRule};
pub use text::{truncate_utf8, truncate_utf8_name_part, utf8_byte_length};
pub use write::{
    EntryMutation, OverwriteOptions, apply_entry_mutation, builtin_entry, create_entry, overwrite_entry,
};
pub use write_lock::{META_LOCK_KEY, WriteLocks};
