// SPDX-License-Identifier: GPL-2.0-or-later
//! The index file of the stores with error codes (the key labels and the
//! typing test texts), read and written as their Electron stores do, and
//! the name rules they share.
//!
//! `index.json` is `{entries}` written as `JSON.stringify(index, null, 2)`.
//! An index that cannot be read, is not an object or has no `entries` list
//! reads as empty and is replaced by the next write; one nested too deeply
//! to parse here (`JSON.parse` reads it) fails the operation instead and is
//! left as it is. The writers read it under the store's lock with the
//! legacy body names moved to id-carrying ones.

use std::fs;
use std::io;
use std::path::Path;

use pipette_entry_store::{
    Entry, EntryList, EntryStore, js_trim, migrate_body_filenames, normalize_entries, utf16_len,
};
use pipette_js_json::{JsString, Object, Value};

use crate::coded_error::{CodedStoreError, ErrorCode};
use crate::entry_files::{body_path_of, name_key, read_text};

/// The longest name of a key label or a typing test text, in UTF-16 code
/// units.
pub const MAX_NAME_LENGTH: usize = 100;

/// How a store reads its index.
pub(crate) struct IndexSpec {
    pub store: EntryStore,
    /// Whether the index's other top-level fields are kept for a write that
    /// changes entries in place (the key labels'), rather than every write
    /// writing `{entries}` alone (the typing test texts').
    pub keeps_other_fields: bool,
    /// What the store's `readIndex` does to each entry it reads.
    pub on_read: fn(&mut Entry),
}

/// The index file: its top-level object, whose `entries` holds the place of
/// [`Self::entries`] (the entries as v2 entries) for a write.
pub(crate) struct EntryIndex {
    root: Object,
    pub entries: Vec<Entry>,
}

impl EntryIndex {
    /// An index of `entries` alone, `{entries}`.
    pub fn bare(entries: Vec<Entry>) -> Self {
        Self { root: std::iter::once(("entries", Value::Array(Vec::new()))).collect(), entries }
    }
}

impl EntryList for EntryIndex {
    fn entries(&self) -> &[Entry] {
        &self.entries
    }

    fn entries_mut(&mut self) -> &mut [Entry] {
        &mut self.entries
    }
}

/// The index in `dir` (`readIndex`): empty when the file is missing,
/// unreadable, not JSON, or not an object with an `entries` list.
pub(crate) fn read_index<C: ErrorCode>(
    spec: &IndexSpec,
    dir: &Path,
) -> Result<EntryIndex, CodedStoreError<C>> {
    let path = dir.join("index.json");
    let Ok(text) = read_text(&path) else { return Ok(EntryIndex::bare(Vec::new())) };
    let root = match pipette_js_json::parse(&text) {
        Ok(Value::Object(root)) if matches!(root.get("entries"), Some(Value::Array(_))) => root,
        Err(err) if err.is_nesting_too_deep() => return Err(CodedStoreError::TooDeep(path)),
        _ => return Ok(EntryIndex::bare(Vec::new())),
    };
    let mut entries = normalize_entries(spec.store, root.get("entries"));
    entries.iter_mut().for_each(spec.on_read);
    if !spec.keeps_other_fields {
        return Ok(EntryIndex::bare(entries));
    }
    let mut root = root;
    // Holds the place of the entries, which a write puts back.
    root.insert("entries", Value::Array(Vec::new()));
    Ok(EntryIndex { root, entries })
}

pub(crate) fn write_index(dir: &Path, index: &EntryIndex) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let mut root = index.root.clone();
    root.insert("entries", Value::Array(index.entries.iter().cloned().map(Value::from).collect()));
    let text = pipette_js_json::stringify_with_gap(&Value::Object(root), "  ");
    pipette_fs::write_file_atomic(&dir.join("index.json"), text.as_bytes())
}

/// The index for a writer holding the store's lock, with the legacy body
/// names moved to id-carrying ones (written back when any moved).
pub(crate) fn read_index_locked<C: ErrorCode>(
    spec: &IndexSpec,
    dir: &Path,
) -> Result<EntryIndex, CodedStoreError<C>> {
    let mut index = read_index(spec, dir)?;
    migrate_body_filenames(spec.store, dir, &mut index, |index| write_index(dir, index))?;
    Ok(index)
}

pub(crate) fn has_id(entry: &Entry, id: &JsString) -> bool {
    entry.id() == Some(id)
}

/// The first live entry other than `exclude_id` whose name is `name`,
/// ignoring case and surrounding whitespace (`findActiveByName`). Fails as
/// JavaScript does on a name that is not a string: `name` read as `name`,
/// or a checked entry's.
pub(crate) fn find_active_by_name<'a, C: ErrorCode>(
    entries: &'a [Entry],
    name: &Value,
    exclude_id: Option<&JsString>,
) -> Result<Option<&'a Entry>, CodedStoreError<C>> {
    let target = name_key(Some(name), "name").map_err(CodedStoreError::Type)?;
    for entry in entries {
        if entry.is_deleted() || exclude_id.is_some_and(|id| has_id(entry, id)) {
            continue;
        }
        if name_key(entry.get("name"), "e.name").map_err(CodedStoreError::Type)? == target {
            return Ok(Some(entry));
        }
    }
    Ok(None)
}

/// `validateName`: the name trimmed, refused when empty or longer than
/// [`MAX_NAME_LENGTH`] code units.
pub(crate) fn validate_name<C: ErrorCode>(name: &JsString) -> Result<JsString, CodedStoreError<C>> {
    let name = js_trim(name);
    if name.is_empty() {
        return Err(CodedStoreError::invalid_name("name must not be empty"));
    }
    if utf16_len(&name) > MAX_NAME_LENGTH {
        return Err(CodedStoreError::invalid_name(&format!(
            "name must be at most {MAX_NAME_LENGTH} characters"
        )));
    }
    Ok(name)
}

/// The JSON of a body or an imported file, as `JSON.parse(readFile(…))`
/// reads it.
pub(crate) fn read_json<C: ErrorCode>(path: &Path) -> Result<Value, CodedStoreError<C>> {
    pipette_js_json::parse(&read_text(path)?).map_err(|err| {
        if err.is_nesting_too_deep() {
            CodedStoreError::TooDeep(path.to_path_buf())
        } else {
            CodedStoreError::Syntax(err.to_string())
        }
    })
}

/// Writes the body of an entry whose filename the store made, with
/// two-space indentation.
pub(crate) fn write_body<C: ErrorCode>(
    dir: &Path,
    filename: &JsString,
    body: &Object,
) -> Result<(), CodedStoreError<C>> {
    fs::create_dir_all(dir)?;
    let path = body_path_of(dir, &filename.to_string_lossy()).ok_or(CodedStoreError::InvalidFilename)?;
    let text = pipette_js_json::stringify_with_gap(&Value::Object(body.clone()), "  ");
    Ok(pipette_fs::write_file_atomic(&path, text.as_bytes())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::KeyLabelErrorCode;

    #[test]
    fn names_are_trimmed_and_at_most_100_code_units() {
        let validate = validate_name::<KeyLabelErrorCode>;
        assert_eq!(validate(&"  Alpha \u{3000}".into()).unwrap(), JsString::from("Alpha"));
        let empty = validate(&" \u{feff}\n".into()).unwrap_err();
        assert_eq!(empty.to_string(), "name must not be empty");
        let hundred = format!("{}😀", "b".repeat(98));
        assert_eq!(validate(&hundred.as_str().into()).unwrap(), JsString::from(hundred.as_str()));
        let long = validate(&format!("{}😀", "a".repeat(99)).into()).unwrap_err();
        assert_eq!(long.to_string(), "name must be at most 100 characters");
        assert_eq!(long.code(), "INVALID_NAME");
    }

    #[test]
    fn a_name_that_is_not_a_string_fails_the_lookup_with_its_type_error() {
        let entries = [Entry::from_object(
            [("id", Value::from("a")), ("name", Value::Number(5.0))].into_iter().collect(),
        )];
        let err = find_active_by_name::<KeyLabelErrorCode>(&entries, &Value::from("x"), None).unwrap_err();
        assert_eq!(err.to_string(), "TypeError: e.name.trim is not a function");
        let err = find_active_by_name::<KeyLabelErrorCode>(&[], &Value::Null, None).unwrap_err();
        assert_eq!(err.to_string(), "TypeError: Cannot read properties of null (reading 'trim')");
    }
}
