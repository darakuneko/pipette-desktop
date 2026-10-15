// SPDX-License-Identifier: GPL-2.0-or-later
//! The snapshots of a keyboard: `sync/keyboards/{uid}/snapshots`, the store
//! of src/main/snapshot-store.ts, synced as the unit of the same name.
//!
//! `index.json` is `{uid, entries}` written as `JSON.stringify(index, null,
//! 2)`; each body (`{device}_{ts}_{id}.pipette`) is the renderer's text as
//! it is. An index that cannot be read, is not an object, or names another
//! uid reads as empty and is replaced by the next write; one nested too
//! deeply to parse here (`JSON.parse` reads it) fails every operation
//! instead and is left as it is. Fields this build does not know, of the
//! index and of its entries, and their order survive a write.
//!
//! The writes run under the uid's write lock and move legacy body names to
//! id-carrying ones on their read of the index; a save then records the
//! device name in the keyboard names under their own lock (uid, then meta).
//! The list and the load read the index as it is.
//!
//! Every operation answers like its handler: failures are values
//! ([`SnapshotError`], whose text is the handler's `String(err)`), turned
//! into the `{success, …}` response by [`snapshot_response_json`].

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use pipette_entry_store::{
    Entry, EntryError, EntryGroup, EntryList, EntryMutation, EntryStore, MetaGroup, OverwriteOptions,
    apply_entry_mutation, clock_ms, create_entry, is_safe_path_segment, migrate_body_filenames,
    normalize_entries, overwrite_entry, sanitize_filename, set_clock, trim_js_whitespace, ts_for_filename,
};
use pipette_js_json::{JsString, Object, Value};
use pipette_time::{iso_8601_millis, iso_8601_millis_checked};

use crate::keyboard_meta::{KEYBOARD_META_SYNC_UNIT, MetaOutcome, upsert_keyboard_meta};
use crate::snapshot_filename::build_snapshot_filename;
use crate::{StoreContext, StoreError};

/// Live snapshots a keyboard may have; a save past it is refused.
pub const MAX_SNAPSHOTS_PER_KEYBOARD: usize = 30;

const STORE: EntryStore = EntryStore::Snapshots;

/// The sync unit of `uid`'s snapshots.
pub fn snapshots_sync_unit(uid: &str) -> String {
    format!("keyboards/{uid}/snapshots")
}

/// Why a snapshot operation failed. The text is what the handler answers
/// as `error`: its own messages as they are, a thrown `Error` as
/// `Error: …`. The text of a file-system error is this OS's, not Node's.
#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
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
    /// A body migration found a body other than the one it was computed
    /// from.
    #[error("Entry changed since it was read")]
    Changed,
    #[error("max entries reached")]
    MaxEntries,
    #[error("Error: {0}")]
    Io(#[from] io::Error),
    #[error("{}", entry_error_text(.0))]
    Entry(#[from] EntryError),
    #[error("Error: {}: nested too deeply to read", .0.display())]
    TooDeep(PathBuf),
    /// The keyboard names could not record the device name of a save; the
    /// snapshot itself was saved.
    #[error("{}", meta_error_text(.0))]
    Meta(StoreError),
}

fn entry_error_text(err: &EntryError) -> String {
    match err {
        EntryError::TimeOutOfRange => format!("RangeError: {err}"),
        EntryError::UnattendedRevive => format!("Error: {err}"),
    }
}

fn meta_error_text(err: &StoreError) -> String {
    match err {
        StoreError::NullEntry(_) => format!("TypeError: {err}"),
        StoreError::Io(_) | StoreError::TooDeep(_) => format!("Error: {err}"),
    }
}

/// The handler's response as JSON text: `{"success":true}` with `field`
/// when there is one, or `{"success":false,"error":…}`.
pub fn snapshot_response_json(result: Result<Option<(&str, Value)>, SnapshotError>) -> String {
    let mut response = Object::new();
    match result {
        Ok(field) => {
            response.insert("success", true.into());
            if let Some((key, value)) = field {
                response.insert(key, value);
            }
        }
        Err(err) => {
            response.insert("success", false.into());
            response.insert("error", err.to_string().into());
        }
    }
    pipette_js_json::stringify(&Value::Object(response))
}

/// The index file: its top-level object, whose `entries` holds the place
/// of [`Self::entries`] (the entries as v2 entries) for a write.
#[derive(Clone)]
struct SnapshotIndex {
    root: Object,
    entries: Vec<Entry>,
}

impl EntryList for SnapshotIndex {
    fn entries(&self) -> &[Entry] {
        &self.entries
    }

    fn entries_mut(&mut self) -> &mut [Entry] {
        &mut self.entries
    }
}

fn validate_uid(uid: &str) -> Result<(), SnapshotError> {
    if is_safe_path_segment(uid) { Ok(()) } else { Err(SnapshotError::InvalidUid) }
}

fn snapshot_dir(ctx: &StoreContext, uid: &str) -> PathBuf {
    ctx.sync_dir().join("keyboards").join(uid).join("snapshots")
}

/// The index of `uid` in `dir` (`readIndex`): empty when the file is
/// missing, unreadable, not JSON, not an object naming `uid`, or without an
/// `entries` list.
fn read_index(dir: &Path, uid: &str) -> Result<SnapshotIndex, SnapshotError> {
    let empty = || {
        let mut root = Object::new();
        root.insert("uid", uid.into());
        root.insert("entries", Value::Array(Vec::new()));
        SnapshotIndex { root, entries: Vec::new() }
    };
    let path = dir.join("index.json");
    let Ok(bytes) = fs::read(&path) else { return Ok(empty()) };
    // readFile(…, 'utf-8') reads each invalid sequence as U+FFFD.
    let mut root = match pipette_js_json::parse(&String::from_utf8_lossy(&bytes)) {
        Ok(Value::Object(root)) => root,
        Ok(_) => return Ok(empty()),
        Err(err) if err.is_nesting_too_deep() => return Err(SnapshotError::TooDeep(path)),
        Err(_) => return Ok(empty()),
    };
    let names_uid = matches!(root.get("uid"), Some(Value::String(s)) if s.as_str() == Some(uid));
    if !names_uid || !matches!(root.get("entries"), Some(Value::Array(_))) {
        return Ok(empty());
    }
    let entries = normalize_entries(STORE, root.get("entries"));
    // Holds the place of the entries, which a write puts back.
    root.insert("entries", Value::Array(Vec::new()));
    Ok(SnapshotIndex { root, entries })
}

fn write_index(dir: &Path, index: SnapshotIndex) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let SnapshotIndex { mut root, entries } = index;
    root.insert("entries", Value::Array(entries.into_iter().map(Value::from).collect()));
    let text = pipette_js_json::stringify_with_gap(&Value::Object(root), "  ");
    pipette_fs::write_file_atomic(&dir.join("index.json"), text.as_bytes())
}

/// The index for a writer holding the uid lock, with the legacy body names
/// moved to id-carrying ones (written back when any moved).
fn read_index_locked(dir: &Path, uid: &str) -> Result<SnapshotIndex, SnapshotError> {
    let mut index = read_index(dir, uid)?;
    // The move keeps the index it renamed, so its write takes a copy; this
    // runs only while legacy names are left.
    migrate_body_filenames(STORE, dir, &mut index, |index| write_index(dir, index.clone()))?;
    Ok(index)
}

/// `dir` joined with a body filename that is one path segment.
fn body_path_of(dir: &Path, filename: &str) -> Result<PathBuf, SnapshotError> {
    let mut components = Path::new(filename).components();
    let single = matches!((components.next(), components.next()), (Some(Component::Normal(_)), None));
    if !is_safe_path_segment(filename) || !single {
        return Err(SnapshotError::InvalidFilename);
    }
    Ok(dir.join(filename))
}

/// The body file of `entry` (`getSafeFilePath`). A filename with a lone
/// surrogate maps to the file of its lossy form, as Node's file calls do.
fn body_path(dir: &Path, entry: &Entry) -> Result<PathBuf, SnapshotError> {
    match entry.get("filename") {
        Some(Value::String(name)) => body_path_of(dir, &name.to_string_lossy()),
        Some(value) if value.is_truthy() => Err(SnapshotError::FilenameNotString),
        _ => Err(SnapshotError::InvalidFilename),
    }
}

fn read_body(path: &Path) -> Result<String, SnapshotError> {
    Ok(String::from_utf8_lossy(&fs::read(path)?).into_owned())
}

fn find_entry(entries: &[Entry], id: &str) -> Option<usize> {
    entries.iter().position(|entry| entry.id().is_some_and(|own| own.as_str() == Some(id)))
}

/// The live snapshots of `uid` (`SNAPSHOT_STORE_LIST`), newest first.
pub fn list_snapshots(ctx: &StoreContext, uid: &str) -> Result<Vec<Entry>, SnapshotError> {
    validate_uid(uid)?;
    let index = read_index(&snapshot_dir(ctx, uid), uid)?;
    Ok(index.entries.into_iter().filter(|entry| !entry.is_deleted()).collect())
}

/// Saves `json` as a new snapshot of `uid` (`SNAPSHOT_STORE_SAVE`), first
/// in the index, and records `device_name` in the keyboard names. Refused
/// when the keyboard has [`MAX_SNAPSHOTS_PER_KEYBOARD`] live snapshots.
/// Returns the new entry.
pub fn save_snapshot(
    ctx: &StoreContext,
    uid: &str,
    json: &str,
    device_name: &str,
    label: &str,
    vil_version: Option<f64>,
) -> Result<Entry, SnapshotError> {
    validate_uid(uid)?;
    ctx.locks.with_write_lock(uid, || {
        let dir = snapshot_dir(ctx, uid);
        let mut index = read_index_locked(&dir, uid)?;
        let live = index.entries.iter().filter(|entry| !entry.is_deleted()).count();
        if live >= MAX_SNAPSHOTS_PER_KEYBOARD {
            return Err(SnapshotError::MaxEntries);
        }
        fs::create_dir_all(&dir)?;

        let now = ctx.now_ms();
        let id = ctx.new_id();
        let filename = build_snapshot_filename(&sanitize_filename(device_name), &ts_for_filename(now), &id);
        pipette_fs::write_file_atomic(&body_path_of(&dir, &filename)?, json.as_bytes())?;

        let mut fields = Object::new();
        fields.insert("id", id.into());
        fields.insert("label", label.into());
        fields.insert("filename", filename.into());
        fields.insert("savedAt", iso_8601_millis(now).into());
        if let Some(version) = vil_version {
            fields.insert("vilVersion", version.into());
        }
        let entry = create_entry(STORE, fields, now);
        index.entries.insert(0, entry.clone());
        write_index(&dir, index)?;
        ctx.notify(&snapshots_sync_unit(uid));

        let recorded = upsert_keyboard_meta(ctx, uid, &JsString::from(device_name));
        if recorded.map_err(SnapshotError::Meta)? == MetaOutcome::Upserted {
            ctx.notify(KEYBOARD_META_SYNC_UNIT);
        }
        Ok(entry)
    })
}

/// The body of `uid`'s snapshot `id` (`SNAPSHOT_STORE_LOAD`).
pub fn load_snapshot(ctx: &StoreContext, uid: &str, id: &str) -> Result<String, SnapshotError> {
    validate_uid(uid)?;
    let dir = snapshot_dir(ctx, uid);
    let index = read_index(&dir, uid)?;
    let entry = find_entry(&index.entries, id).map(|at| &index.entries[at]).ok_or(SnapshotError::NotFound)?;
    if entry.is_deleted() {
        return Err(SnapshotError::Deleted);
    }
    read_body(&body_path(&dir, entry)?)
}

/// Writes `json` over the body of `uid`'s snapshot `id`
/// (`SNAPSHOT_STORE_UPDATE`), with `vil_version` when given.
///
/// Without `migrate_from` this is a user save: an explicit overwrite that
/// brings a deleted entry back. With it, it is the mechanical v1 → v2
/// rewrite of a body: refused for a deleted entry and for a stored body
/// other than `migrate_from`, and the body clock moves 1 ms past its old
/// value instead of to now, so a real edit made elsewhere after that body
/// still wins.
pub fn update_snapshot(
    ctx: &StoreContext,
    uid: &str,
    id: &str,
    json: &str,
    vil_version: Option<f64>,
    migrate_from: Option<&str>,
) -> Result<(), SnapshotError> {
    validate_uid(uid)?;
    ctx.locks.with_write_lock(uid, || {
        let dir = snapshot_dir(ctx, uid);
        let mut index = read_index_locked(&dir, uid)?;
        let at = find_entry(&index.entries, id).ok_or(SnapshotError::NotFound)?;
        let entry = &index.entries[at];
        let mut next = entry.clone();
        if let Some(version) = vil_version {
            next.set("vilVersion", version);
        }
        let updated = match migrate_from {
            Some(from) => {
                if entry.is_deleted() {
                    return Err(SnapshotError::Deleted);
                }
                let path = body_path(&dir, entry)?;
                if read_body(&path)? != from {
                    return Err(SnapshotError::Changed);
                }
                pipette_fs::write_file_atomic(&path, json.as_bytes())?;
                let body = clock_ms(entry.clock(EntryGroup::Body)).saturating_add(1);
                set_clock(
                    &mut next,
                    EntryGroup::Body,
                    &iso_8601_millis_checked(body).ok_or(EntryError::TimeOutOfRange)?,
                );
                next
            }
            None => {
                pipette_fs::write_file_atomic(&body_path(&dir, entry)?, json.as_bytes())?;
                let options = OverwriteOptions { body: true, explicit: true };
                overwrite_entry(STORE, Some(entry), next.into_object(), ctx.now_ms(), options)?
            }
        };
        index.entries[at] = updated;
        write_index(&dir, index)?;
        ctx.notify(&snapshots_sync_unit(uid));
        Ok(())
    })
}

/// A meta-only change of `uid`'s snapshot `id` (`updateEntry`): `mutate`
/// edits the entry, then `mutation` moves its clock or tombstones it.
fn change_entry(
    ctx: &StoreContext,
    uid: &str,
    id: &str,
    mutation: EntryMutation,
    mutate: impl FnOnce(&mut Entry),
) -> Result<(), SnapshotError> {
    ctx.locks.with_write_lock(uid, || {
        validate_uid(uid)?;
        let dir = snapshot_dir(ctx, uid);
        let mut index = read_index_locked(&dir, uid)?;
        let id = JsString::from(id);
        if apply_entry_mutation(&mut index.entries, &id, mutation, ctx.now_ms(), mutate)?.is_none() {
            return Err(SnapshotError::NotFound);
        }
        write_index(&dir, index)?;
        ctx.notify(&snapshots_sync_unit(uid));
        Ok(())
    })
}

/// Gives `uid`'s snapshot `id` the label `label` (`SNAPSHOT_STORE_RENAME`).
pub fn rename_snapshot(ctx: &StoreContext, uid: &str, id: &str, label: &str) -> Result<(), SnapshotError> {
    change_entry(ctx, uid, id, EntryMutation::Meta(MetaGroup::Name), |entry| entry.set("label", label))
}

/// Tombstones `uid`'s snapshot `id` (`SNAPSHOT_STORE_DELETE`); its body
/// stays for sync.
pub fn delete_snapshot(ctx: &StoreContext, uid: &str, id: &str) -> Result<(), SnapshotError> {
    change_entry(ctx, uid, id, EntryMutation::Delete, |_| {})
}

/// Links `uid`'s snapshot `id` to a public Hub post
/// (`SNAPSHOT_STORE_SET_HUB_POST_ID`), dropping any private link: the two
/// are exclusive. A post id that is `None` or blank once trimmed clears the
/// link instead.
pub fn set_snapshot_hub_post_id(
    ctx: &StoreContext,
    uid: &str,
    id: &str,
    hub_post_id: Option<&str>,
) -> Result<(), SnapshotError> {
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

/// Links `uid`'s snapshot `id` to a private Hub post
/// (`SNAPSHOT_STORE_SET_HUB_PRIVATE`), dropping any public post id, or
/// clears the private link when `link` is `None`.
pub fn set_snapshot_hub_private(
    ctx: &StoreContext,
    uid: &str,
    id: &str,
    link: Option<Value>,
) -> Result<(), SnapshotError> {
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
