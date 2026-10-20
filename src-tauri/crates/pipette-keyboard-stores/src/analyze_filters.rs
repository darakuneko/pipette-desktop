// SPDX-License-Identifier: GPL-2.0-or-later
//! The saved Analyze filters of a keyboard:
//! `sync/keyboards/{uid}/analyze_filters`, synced as the unit of the same
//! name.
//!
//! The index is the snapshots' (`{uid, entries}`, see keyboard_index.rs);
//! each body (`{ts}_{id}.json`) is the renderer's filter text as it is.
//! The writes run under the uid's write lock, the lock the keyboard's other
//! stores share, and move legacy body names to id-carrying ones on their
//! read of the index. The list and the load read the index as it is. The
//! Hub links are only recorded here; the Hub requests are not this store's.
//!
//! Every operation answers like its handler: failures are values
//! ([`AnalyzeFilterError`], whose text is the handler's `String(err)`),
//! turned into the `{success, …}` response by [`crate::response_json`].

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use pipette_entry_store::{
    Entry, EntryError, EntryMutation, EntryStore, MetaGroup, OverwriteOptions, apply_entry_mutation,
    create_entry, id_body_filename, is_safe_path_segment, overwrite_entry, trim_js_whitespace,
    ts_for_filename,
};
use pipette_js_json::{JsString, Object, Value};
use pipette_time::iso_8601_millis;

use crate::StoreContext;
use crate::entry_files::{BodyPathError, body_path, body_path_of, entry_error_text, read_text};
use crate::keyboard_index::{self, IndexError, KeyboardIndex, write_index};

/// Live filters a keyboard may have; a save past it is refused
/// (`ANALYZE_FILTER_STORE_MAX_ENTRIES_PER_KEYBOARD`).
pub const MAX_ANALYZE_FILTERS_PER_KEYBOARD: usize = 50;

const STORE: EntryStore = EntryStore::AnalyzeFilters;

/// The sync unit of `uid`'s Analyze filters.
pub fn analyze_filters_sync_unit(uid: &str) -> String {
    format!("keyboards/{uid}/analyze_filters")
}

/// Why an Analyze filter operation failed. The text is what the handler
/// answers as `error`: its own messages as they are, a thrown `Error` as
/// `Error: …`. The text of a file-system error is this OS's, not Node's.
#[derive(Debug, thiserror::Error)]
pub enum AnalyzeFilterError {
    #[error("Error: Invalid uid")]
    InvalidUid,
    #[error("Error: Invalid filename")]
    InvalidFilename,
    /// An entry whose `filename` is a truthy value that is not a string,
    /// which Node's `path.join` refuses.
    #[error("TypeError: The \"path\" argument must be of type string")]
    FilenameNotString,
    #[error("Entry not found")]
    NotFound,
    #[error("Entry has been deleted")]
    Deleted,
    /// `ANALYZE_FILTER_STORE_ERROR_MAX_ENTRIES`.
    #[error("max entries reached")]
    MaxEntries,
    #[error("Error: {0}")]
    Io(#[from] io::Error),
    #[error("{}", entry_error_text(.0))]
    Entry(#[from] EntryError),
    #[error("Error: {}: nested too deeply to read", .0.display())]
    TooDeep(PathBuf),
}

impl From<BodyPathError> for AnalyzeFilterError {
    fn from(err: BodyPathError) -> Self {
        match err {
            BodyPathError::Invalid => AnalyzeFilterError::InvalidFilename,
            BodyPathError::NotString => AnalyzeFilterError::FilenameNotString,
        }
    }
}

impl From<IndexError> for AnalyzeFilterError {
    fn from(err: IndexError) -> Self {
        match err {
            IndexError::TooDeep(path) => AnalyzeFilterError::TooDeep(path),
            IndexError::Io(err) => AnalyzeFilterError::Io(err),
        }
    }
}

fn validate_uid(uid: &str) -> Result<(), AnalyzeFilterError> {
    if is_safe_path_segment(uid) { Ok(()) } else { Err(AnalyzeFilterError::InvalidUid) }
}

fn filter_dir(ctx: &StoreContext, uid: &str) -> PathBuf {
    ctx.sync_dir().join("keyboards").join(uid).join("analyze_filters")
}

fn read_index(dir: &Path, uid: &str) -> Result<KeyboardIndex, AnalyzeFilterError> {
    Ok(keyboard_index::read_index(STORE, dir, uid)?)
}

fn read_index_locked(dir: &Path, uid: &str) -> Result<KeyboardIndex, AnalyzeFilterError> {
    Ok(keyboard_index::read_index_locked(STORE, dir, uid)?)
}

fn find_entry(entries: &[Entry], id: &str) -> Option<usize> {
    keyboard_index::find_entry(entries, &JsString::from(id))
}

/// The live filters of `uid` (the `analyze_filter_store_list` command), newest first.
pub fn list_analyze_filters(ctx: &StoreContext, uid: &str) -> Result<Vec<Entry>, AnalyzeFilterError> {
    validate_uid(uid)?;
    let index = read_index(&filter_dir(ctx, uid), uid)?;
    Ok(index.entries.into_iter().filter(|entry| !entry.is_deleted()).collect())
}

/// Saves `json` as a new filter of `uid` (the `analyze_filter_store_save` command),
/// first in the index; an empty `summary` is not stored. Refused when the
/// keyboard has [`MAX_ANALYZE_FILTERS_PER_KEYBOARD`] live filters. Returns
/// the new entry.
pub fn save_analyze_filter(
    ctx: &StoreContext,
    uid: &str,
    json: &str,
    label: &str,
    summary: Option<&str>,
) -> Result<Entry, AnalyzeFilterError> {
    validate_uid(uid)?;
    ctx.locks().with_write_lock(uid, || {
        let dir = filter_dir(ctx, uid);
        let mut index = read_index_locked(&dir, uid)?;
        let live = index.entries.iter().filter(|entry| !entry.is_deleted()).count();
        if live >= MAX_ANALYZE_FILTERS_PER_KEYBOARD {
            return Err(AnalyzeFilterError::MaxEntries);
        }
        fs::create_dir_all(&dir)?;

        let now = ctx.now_ms();
        let id = JsString::from(ctx.new_id());
        let filename =
            id_body_filename(STORE, &id, &JsString::from(format!("{}.json", ts_for_filename(now))));
        let path =
            body_path_of(&dir, &filename.to_string_lossy()).ok_or(AnalyzeFilterError::InvalidFilename)?;
        pipette_fs::write_file_atomic(&path, json.as_bytes())?;

        let mut fields = Object::new();
        fields.insert("id", Value::String(id));
        fields.insert("label", label.into());
        if let Some(summary) = summary.filter(|summary| !summary.is_empty()) {
            fields.insert("summary", summary.into());
        }
        fields.insert("filename", Value::String(filename));
        fields.insert("savedAt", iso_8601_millis(now).into());
        let entry = create_entry(STORE, fields, now);
        index.entries.insert(0, entry.clone());
        write_index(&dir, index)?;
        ctx.notify(&analyze_filters_sync_unit(uid));
        Ok(entry)
    })
}

/// The body of `uid`'s filter `id` (the `analyze_filter_store_load` command).
pub fn load_analyze_filter(ctx: &StoreContext, uid: &str, id: &str) -> Result<String, AnalyzeFilterError> {
    validate_uid(uid)?;
    let dir = filter_dir(ctx, uid);
    let index = read_index(&dir, uid)?;
    let entry =
        find_entry(&index.entries, id).map(|at| &index.entries[at]).ok_or(AnalyzeFilterError::NotFound)?;
    if entry.is_deleted() {
        return Err(AnalyzeFilterError::Deleted);
    }
    Ok(read_text(&body_path(&dir, entry)?)?)
}

/// Writes `json` over the body of `uid`'s filter `id`
/// (the `analyze_filter_store_update` command): a user save, which brings a deleted
/// entry back.
pub fn update_analyze_filter(
    ctx: &StoreContext,
    uid: &str,
    id: &str,
    json: &str,
) -> Result<(), AnalyzeFilterError> {
    validate_uid(uid)?;
    ctx.locks().with_write_lock(uid, || {
        let dir = filter_dir(ctx, uid);
        let mut index = read_index_locked(&dir, uid)?;
        let at = find_entry(&index.entries, id).ok_or(AnalyzeFilterError::NotFound)?;
        let entry = &index.entries[at];
        pipette_fs::write_file_atomic(&body_path(&dir, entry)?, json.as_bytes())?;
        let options = OverwriteOptions { body: true, explicit: true };
        index.entries[at] =
            overwrite_entry(STORE, Some(entry), entry.clone().into_object(), ctx.now_ms(), options)?;
        write_index(&dir, index)?;
        ctx.notify(&analyze_filters_sync_unit(uid));
        Ok(())
    })
}

/// A meta-only change of `uid`'s filter `id`: `mutate` edits the entry,
/// then `mutation` moves its clock or tombstones it.
fn change_entry(
    ctx: &StoreContext,
    uid: &str,
    id: &str,
    mutation: EntryMutation,
    mutate: impl FnOnce(&mut Entry),
) -> Result<(), AnalyzeFilterError> {
    // The handler checks the uid inside the lock; the answer is the same,
    // and an invalid uid then never takes a lock.
    validate_uid(uid)?;
    ctx.locks().with_write_lock(uid, || {
        let dir = filter_dir(ctx, uid);
        let mut index = read_index_locked(&dir, uid)?;
        let id = JsString::from(id);
        if apply_entry_mutation(&mut index.entries, &id, mutation, ctx.now_ms(), mutate)?.is_none() {
            return Err(AnalyzeFilterError::NotFound);
        }
        write_index(&dir, index)?;
        ctx.notify(&analyze_filters_sync_unit(uid));
        Ok(())
    })
}

/// Gives `uid`'s filter `id` the label `label`
/// (the `analyze_filter_store_rename` command).
pub fn rename_analyze_filter(
    ctx: &StoreContext,
    uid: &str,
    id: &str,
    label: &str,
) -> Result<(), AnalyzeFilterError> {
    change_entry(ctx, uid, id, EntryMutation::Meta(MetaGroup::Name), |entry| entry.set("label", label))
}

/// Tombstones `uid`'s filter `id` (the `analyze_filter_store_delete` command); its
/// body stays for sync.
pub fn delete_analyze_filter(ctx: &StoreContext, uid: &str, id: &str) -> Result<(), AnalyzeFilterError> {
    change_entry(ctx, uid, id, EntryMutation::Delete, |_| {})
}

/// Links `uid`'s filter `id` to a public Hub post
/// (the `analyze_filter_store_set_hub_post_id` command), dropping any private link: the
/// two are exclusive. A post id that is `None` or blank once trimmed clears
/// the link instead.
pub fn set_analyze_filter_hub_post_id(
    ctx: &StoreContext,
    uid: &str,
    id: &str,
    hub_post_id: Option<&str>,
) -> Result<(), AnalyzeFilterError> {
    let trimmed = hub_post_id
        .map(|post_id| {
            JsString::from_utf16(trim_js_whitespace(&JsString::from(post_id).utf16_units()).to_vec())
        })
        .filter(|post_id| !post_id.is_empty());
    change_entry(ctx, uid, id, EntryMutation::Meta(MetaGroup::Hub), |entry| match trimmed {
        None => {
            entry.remove("hubPostId");
        }
        Some(post_id) => {
            entry.set("hubPostId", Value::String(post_id));
            entry.remove("hubPrivate");
        }
    })
}

/// Links `uid`'s filter `id` to a private Hub post
/// (the `analyze_filter_store_set_hub_private` command), dropping any public post id,
/// or clears the private link when `link` is `None`.
pub fn set_analyze_filter_hub_private(
    ctx: &StoreContext,
    uid: &str,
    id: &str,
    link: Option<Value>,
) -> Result<(), AnalyzeFilterError> {
    change_entry(ctx, uid, id, EntryMutation::Meta(MetaGroup::Hub), |entry| match link {
        None => {
            entry.remove("hubPrivate");
        }
        Some(link) => {
            entry.set("hubPrivate", link);
            entry.remove("hubPostId");
        }
    })
}
