// SPDX-License-Identifier: GPL-2.0-or-later
//! What the index-based stores of this crate share: the body file an entry
//! names, read as the Electron build reads it, the text of a clock error,
//! and the name comparison of `findActiveByName`.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use pipette_entry_store::{Entry, EntryError, is_safe_path_segment, js_to_lower_case, trim_js_whitespace};
use pipette_js_json::Value;

/// Why an entry names no body file this store may open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BodyPathError {
    /// Missing, empty, `.`, `..`, or with a path separator: the store's
    /// `Error: Invalid filename`.
    Invalid,
    /// A truthy value that is not a string, which Node's `path.join`
    /// refuses with a TypeError.
    NotString,
}

/// `dir` joined with a body filename that is one path segment, `None` for
/// any other name. A name that is not one plain component for this OS (a
/// Windows drive prefix such as `C:x`, which `Path::join` would put in
/// place of `dir`) is refused too.
pub(crate) fn body_path_of(dir: &Path, filename: &str) -> Option<PathBuf> {
    let mut components = Path::new(filename).components();
    let single = matches!((components.next(), components.next()), (Some(Component::Normal(_)), None));
    (is_safe_path_segment(filename) && single).then(|| dir.join(filename))
}

/// The body file of `entry` (the stores' `getSafeFilePath` /
/// `getEntryPath`). A filename with a lone surrogate maps to the file of its
/// lossy form, as Node's file calls do.
pub(crate) fn body_path(dir: &Path, entry: &Entry) -> Result<PathBuf, BodyPathError> {
    match entry.get("filename") {
        Some(Value::String(name)) => body_path_of(dir, &name.to_string_lossy()).ok_or(BodyPathError::Invalid),
        Some(value) if value.is_truthy() => Err(BodyPathError::NotString),
        _ => Err(BodyPathError::Invalid),
    }
}

/// A file's text as `readFile(…, 'utf-8')` reads it: each invalid sequence
/// as U+FFFD, a byte order mark kept.
pub(crate) fn read_text(path: &Path) -> io::Result<String> {
    Ok(String::from_utf8_lossy(&fs::read(path)?).into_owned())
}

/// The text of the error JavaScript throws where the entry helpers fail.
pub(crate) fn entry_error_text(err: &EntryError) -> String {
    match err {
        EntryError::TimeOutOfRange => format!("RangeError: {err}"),
        EntryError::UnattendedRevive => format!("Error: {err}"),
    }
}

/// The text of the TypeError JavaScript throws when it calls the string
/// method `method` on `value` (missing for undefined) read as `receiver`.
pub(crate) fn method_type_error_text(value: Option<&Value>, receiver: &str, method: &str) -> String {
    match value {
        None => format!("Cannot read properties of undefined (reading '{method}')"),
        Some(Value::Null) => format!("Cannot read properties of null (reading '{method}')"),
        Some(_) => format!("{receiver}.{method} is not a function"),
    }
}

/// `value.trim().toLowerCase()` for the name `value` read as `receiver`:
/// the key two names are the same by, or the text of the TypeError of a
/// name that is not a string.
pub(crate) fn name_key(value: Option<&Value>, receiver: &str) -> Result<Vec<u16>, String> {
    match value {
        Some(Value::String(name)) => Ok(js_to_lower_case(trim_js_whitespace(&name.utf16_units()))),
        other => Err(method_type_error_text(other, receiver, "trim")),
    }
}

#[cfg(test)]
mod tests {
    use pipette_js_json::Object;

    use super::*;

    fn entry(filename: Option<Value>) -> Entry {
        let mut object = Object::new();
        if let Some(filename) = filename {
            object.insert("filename", filename);
        }
        Entry::from_object(object)
    }

    #[test]
    fn a_body_path_is_one_segment_under_the_directory() {
        let dir = Path::new("/store");
        assert_eq!(body_path(dir, &entry(Some("a_1.json".into()))), Ok(dir.join("a_1.json")));
        for name in ["", ".", "..", "../x.json", "a/b.json", "a\\b.json"] {
            assert_eq!(body_path(dir, &entry(Some(name.into()))), Err(BodyPathError::Invalid), "{name}");
        }
        assert_eq!(body_path(dir, &entry(None)), Err(BodyPathError::Invalid));
        assert_eq!(body_path(dir, &entry(Some(Value::Null))), Err(BodyPathError::Invalid));
        assert_eq!(body_path(dir, &entry(Some(Value::Number(0.0)))), Err(BodyPathError::Invalid));
        assert_eq!(body_path(dir, &entry(Some(Value::Number(5.0)))), Err(BodyPathError::NotString));
    }
}
