// SPDX-License-Identifier: GPL-2.0-or-later
//! Body files of the index-based entry stores: the move to names that
//! carry the entry id ([`id_body_filename`]), so no two ids ever share a
//! body file, and the removal of body files no entry names.
//!
//! The move runs under the store's write lock, on every locked read of the
//! index; once every name carries its id it does nothing. Files are copied,
//! not renamed: one legacy file can be named by several entries, and each
//! of them gets its own copy. A legacy file is deleted only after the index
//! naming the new files is written and no entry (tombstones included)
//! names it any more. Body clocks do not move: the content is the same.
//!
//! A name with a lone surrogate maps to the file of its lossy form (U+FFFD),
//! the path the Electron build's file calls use for it.

use std::collections::HashSet;
use std::io;
use std::path::{Component, Path, PathBuf};

use pipette_js_json::{JsString, Object, Value, parse, stringify_with_gap};

use crate::body_filename::{body_filename_has_id, id_body_filename};
use crate::entry::Entry;
use crate::normalize::normalize_entries;
use crate::safe_filename::is_safe_path_segment;
use crate::store_groups::EntryStore;

/// An index whose entries the move renames.
pub trait EntryList {
    fn entries(&self) -> &[Entry];
    fn entries_mut(&mut self) -> &mut [Entry];
}

impl EntryList for Vec<Entry> {
    fn entries(&self) -> &[Entry] {
        self
    }

    fn entries_mut(&mut self) -> &mut [Entry] {
        self
    }
}

/// `dir` joined with a file name that [`is_safe_path_segment`] accepted.
/// A name that is not one plain component for this OS (a Windows drive
/// prefix such as `C:x`, which `Path::join` would put in place of `dir`)
/// is refused.
fn join_segment(dir: &Path, name: &JsString) -> io::Result<PathBuf> {
    let name = name.to_string_lossy();
    let mut components = Path::new(name.as_ref()).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Ok(dir.join(name.as_ref())),
        _ => Err(io::Error::new(io::ErrorKind::InvalidInput, format!("not a file name: {name}"))),
    }
}

/// Renames every entry of `list` whose body filename lacks its id, copying
/// the file under `dir` when it exists, then calls `persist` to write the
/// index and deletes the legacy files nothing names any more. Returns
/// whether any entry changed (`persist` is not called otherwise). A copy
/// failure other than a missing source fails before the index is written;
/// the copies already made are overwritten by the next attempt.
pub fn migrate_body_filenames<L: EntryList + ?Sized>(
    store: EntryStore,
    dir: &Path,
    list: &mut L,
    persist: impl FnOnce(&L) -> io::Result<()>,
) -> io::Result<bool> {
    let mut moves: Vec<(usize, JsString, JsString)> = Vec::new();
    for (at, entry) in list.entries().iter().enumerate() {
        let (Some(id), Some(from)) = (entry.id(), entry.filename()) else { continue };
        if !is_safe_path_segment(&from.to_string_lossy()) || body_filename_has_id(store, id, from) {
            continue;
        }
        let to = id_body_filename(store, id, from);
        if is_safe_path_segment(&to.to_string_lossy()) {
            moves.push((at, from.clone(), to));
        }
    }
    if moves.is_empty() {
        return Ok(false);
    }

    for (_, from, to) in &moves {
        match std::fs::copy(join_segment(dir, from)?, join_segment(dir, to)?) {
            // No legacy file (a tombstone whose body is gone): only the name changes.
            Ok(_) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
    }
    let entries = list.entries_mut();
    for (at, _, to) in &moves {
        entries[*at].set("filename", Value::String(to.clone()));
    }
    persist(list)?;

    let named: HashSet<&JsString> = list.entries().iter().filter_map(Entry::filename).collect();
    let mut removed = HashSet::new();
    for (_, from, _) in &moves {
        if named.contains(from) || !removed.insert(from) {
            continue;
        }
        // Best effort: an unnamed leftover file is never read.
        if let Ok(path) = join_segment(dir, from) {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(true)
}

/// A store's locked read of its index: `read`, then the body filename move
/// with `write` as the persist step.
pub fn read_index_migrated<I: EntryList>(
    store: EntryStore,
    dir: &Path,
    read: impl FnOnce() -> io::Result<I>,
    write: impl FnOnce(&I) -> io::Result<()>,
) -> io::Result<I> {
    let mut index = read()?;
    migrate_body_filenames(store, dir, &mut index, write)?;
    Ok(index)
}

/// `{dir}/index.json` as the sync merge and the Local Data import see it.
#[derive(Clone, Debug, PartialEq)]
pub enum IndexDirRead {
    Missing,
    /// Present but unreadable, not JSON, or without an `entries` array.
    Corrupt,
    /// `index` as read; `entries` its entries as v2 entries with the body
    /// filenames moved.
    Ok {
        index: Object,
        entries: Vec<Entry>,
    },
}

/// Reads `{dir}/index.json` for a caller that holds the store's lock and
/// moves its body filenames; the index is written back (normalized, two
/// space indented) only when a name changed.
pub fn read_index_dir_migrated(store: EntryStore, dir: &Path) -> io::Result<IndexDirRead> {
    let path = dir.join("index.json");
    let raw = match std::fs::read(&path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(IndexDirRead::Missing),
        Err(_) => return Ok(IndexDirRead::Corrupt),
    };
    // Valid JSON without an `entries` array is not an empty index: reading
    // it as one would let the merge overwrite it and remove the bodies it
    // names.
    let Ok(Value::Object(index)) = parse(&raw) else {
        return Ok(IndexDirRead::Corrupt);
    };
    if !matches!(index.get("entries"), Some(Value::Array(_))) {
        return Ok(IndexDirRead::Corrupt);
    }
    let mut entries = normalize_entries(store, index.get("entries"));
    migrate_body_filenames(store, dir, &mut entries, |entries| {
        let mut out = index.clone();
        out.insert("entries", Value::Array(entries.iter().cloned().map(Value::from).collect()));
        pipette_fs::write_file_atomic(&path, stringify_with_gap(&Value::Object(out), "  ").as_bytes())
    })?;
    Ok(IndexDirRead::Ok { index, entries })
}

/// Whether `name` is shaped like one of `store`'s id-carrying body files:
/// a safe single segment with the body extension and a `_` (every
/// id-carrying name has one). `index.json`, the temp files of an atomic
/// write and anything else are never body files.
pub fn is_body_file_name(store: EntryStore, name: &str) -> bool {
    name != "index.json"
        && name.ends_with(store.groups().body_ext)
        && name.contains('_')
        && is_safe_path_segment(name)
}

/// Unlinks the body files under `dir` that no entry names. Returns how many
/// were removed; failures are skipped. Names that are not UTF-8 are taken
/// in their lossy form, as the Electron build lists them.
pub fn unlink_unreferenced_body_files(
    store: EntryStore,
    dir: &Path,
    referenced: &HashSet<JsString>,
) -> usize {
    let Ok(listing) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for item in listing.flatten() {
        let text = item.file_name().to_string_lossy().into_owned();
        if !is_body_file_name(store, &text) {
            continue;
        }
        let name = JsString::from(text);
        if referenced.contains(&name) {
            continue;
        }
        if join_segment(dir, &name).and_then(std::fs::remove_file).is_ok() {
            removed += 1;
        }
    }
    removed
}
