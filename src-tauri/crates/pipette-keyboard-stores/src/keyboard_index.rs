// SPDX-License-Identifier: GPL-2.0-or-later
//! The index file of a keyboard's entry stores under
//! `sync/keyboards/{uid}` (the snapshots, the Analyze filters and the run
//! logs), and how it is read and written.
//!
//! `index.json` is `{uid, entries}` written as `JSON.stringify(index, null,
//! 2)`. An index that cannot be read, is not an object, names another uid
//! or has no `entries` list reads as empty and is replaced by the next
//! write; one nested too deeply to parse here (`JSON.parse` reads it) is an
//! error instead and is left as it is. Fields this build does not know, of
//! the index and of its entries, and their order survive a write.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use pipette_entry_store::{Entry, EntryList, EntryStore, migrate_body_filenames, normalize_entries};
use pipette_js_json::{JsString, Object, Value};

/// The index file: its top-level object, whose `entries` holds the place
/// of [`Self::entries`] (the entries as v2 entries) for a write.
#[derive(Clone)]
pub(crate) struct KeyboardIndex {
    root: Object,
    pub entries: Vec<Entry>,
}

impl EntryList for KeyboardIndex {
    fn entries(&self) -> &[Entry] {
        &self.entries
    }

    fn entries_mut(&mut self) -> &mut [Entry] {
        &mut self.entries
    }
}

/// Why an index could not be read.
#[derive(Debug)]
pub(crate) enum IndexError {
    /// The index file, nested too deeply to read.
    TooDeep(PathBuf),
    /// The move of the legacy body names failed.
    Io(io::Error),
}

/// The index of `uid` in `dir`.
pub(crate) fn read_index(store: EntryStore, dir: &Path, uid: &str) -> Result<KeyboardIndex, IndexError> {
    let empty = || {
        let mut root = Object::new();
        root.insert("uid", uid.into());
        root.insert("entries", Value::Array(Vec::new()));
        KeyboardIndex { root, entries: Vec::new() }
    };
    let path = dir.join("index.json");
    let Ok(bytes) = fs::read(&path) else { return Ok(empty()) };
    // readFile(…, 'utf-8') reads each invalid sequence as U+FFFD.
    let mut root = match pipette_js_json::parse(&String::from_utf8_lossy(&bytes)) {
        Ok(Value::Object(root)) => root,
        Ok(_) => return Ok(empty()),
        Err(err) if err.is_nesting_too_deep() => return Err(IndexError::TooDeep(path)),
        Err(_) => return Ok(empty()),
    };
    let names_uid = matches!(root.get("uid"), Some(Value::String(s)) if s.as_str() == Some(uid));
    if !names_uid || !matches!(root.get("entries"), Some(Value::Array(_))) {
        return Ok(empty());
    }
    let entries = normalize_entries(store, root.get("entries"));
    // Holds the place of the entries, which a write puts back.
    root.insert("entries", Value::Array(Vec::new()));
    Ok(KeyboardIndex { root, entries })
}

/// Writes `index` to `dir` (created when missing).
pub(crate) fn write_index(dir: &Path, index: KeyboardIndex) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let KeyboardIndex { mut root, entries } = index;
    root.insert("entries", Value::Array(entries.into_iter().map(Value::from).collect()));
    let text = pipette_js_json::stringify_with_gap(&Value::Object(root), "  ");
    pipette_fs::write_file_atomic(&dir.join("index.json"), text.as_bytes())
}

/// The index for a writer holding the uid lock, with the legacy body names
/// moved to id-carrying ones (written back when any moved).
pub(crate) fn read_index_locked(
    store: EntryStore,
    dir: &Path,
    uid: &str,
) -> Result<KeyboardIndex, IndexError> {
    let mut index = read_index(store, dir, uid)?;
    // The move keeps the index it renamed, so its write takes a copy; this
    // runs only while legacy names are left.
    migrate_body_filenames(store, dir, &mut index, |index| write_index(dir, index.clone()))
        .map_err(IndexError::Io)?;
    Ok(index)
}

/// The position of the first entry whose id is `id`.
pub(crate) fn find_entry(entries: &[Entry], id: &JsString) -> Option<usize> {
    entries.iter().position(|entry| entry.id() == Some(id))
}
