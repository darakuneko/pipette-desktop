// SPDX-License-Identifier: GPL-2.0-or-later
//! Reading and writing config.json the way conf (the 0.4 build's config
//! library) does: read as UTF-8 with U+FFFD for bad bytes (Node's `readFileSync(path,
//! 'utf8')`), parsed by `JSON.parse` and copied into a fresh object, written
//! with tab indentation and no final newline, atomically, keeping
//! `__internal__` unless the new content has its own.

use std::io;
use std::path::Path;

use pipette_js_json::{JsString, Object, Value};

use crate::AppConfigError;

/// conf's reserved key, kept across writes that do not set it.
pub const INTERNAL_KEY: &str = "__internal__";

/// The stored object, or an empty one when there is no file (whose
/// directory is created then, as conf does).
pub fn read_store(path: &Path) -> Result<Object, AppConfigError> {
    match read_value(path) {
        Ok(value) => Ok(to_store_object(value)),
        Err(AppConfigError::Io(err)) if err.kind() == io::ErrorKind::NotFound => {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            Ok(Object::new())
        }
        Err(err) => Err(err),
    }
}

fn read_value(path: &Path) -> Result<Value, AppConfigError> {
    let bytes = std::fs::read(path)?;
    Ok(pipette_js_json::parse(&String::from_utf8_lossy(&bytes))?)
}

/// `Object.assign(Object.create(null), parsed)`: an object as it is, the
/// indexes of an array or of a string's UTF-16 code units as keys, nothing
/// for any other value.
fn to_store_object(value: Value) -> Object {
    match value {
        Value::Object(object) => object,
        Value::Array(items) => items.into_iter().enumerate().map(|(i, item)| (i.to_string(), item)).collect(),
        Value::String(s) => s
            .utf16_units()
            .into_iter()
            .enumerate()
            .map(|(i, unit)| (i.to_string(), Value::String(JsString::from_utf16(vec![unit]))))
            .collect(),
        Value::Null | Value::Bool(_) | Value::Number(_) => Object::new(),
    }
}

/// `store` with the current file's `__internal__` (if the file reads)
/// appended when it has none of its own, as conf's `store` setter keeps it
/// for content that does not come from the file.
pub fn with_current_internal(path: &Path, mut store: Object) -> Object {
    if !store.contains_key(INTERNAL_KEY)
        && let Ok(Value::Object(current)) = read_value(path)
        && let Some(internal) = current.get(INTERNAL_KEY)
    {
        store.insert(INTERNAL_KEY, internal.clone());
    }
    store
}

/// Writes `store` as the whole file. Content read from the file already
/// holds its `__internal__`; other content goes through
/// [`with_current_internal`] first.
pub fn write_store(path: &Path, store: Object) -> Result<(), AppConfigError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = pipette_js_json::stringify_with_gap(&Value::Object(store), "\t");
    write_file(path, text.as_bytes())?;
    Ok(())
}

/// conf's write: atomic, except under Snap (`SNAP` set) and when the rename
/// fails with EXDEV, where it writes the file in place. An existing symlink
/// stays and its target gets the content. A new file gets mode
/// 0o666 & ~umask, a replaced one does not keep its mode.
fn write_file(path: &Path, content: &[u8]) -> io::Result<()> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
    if std::env::var_os("SNAP").is_some() {
        return std::fs::write(&target, content);
    }
    match pipette_fs::write_file_atomic_keeping_owner(&target, content) {
        Err(err) if err.kind() == io::ErrorKind::CrossesDevices => std::fs::write(&target, content),
        result => result,
    }
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    #[cfg(unix)]
    #[test]
    fn writes_through_a_symlink() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();
        let real = dir.join("real.json");
        let link = dir.join("config.json");
        std::fs::write(&real, "{}").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        write_store(&link, [("a", Value::Null)].into_iter().collect()).unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "{\n\t\"a\": null\n}");
    }

    #[cfg(unix)]
    #[test]
    fn a_replaced_file_gets_the_mode_of_a_new_one() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();
        let path = dir.join("config.json");
        write_store(&path, Object::new()).unwrap();
        let new_mode = std::fs::metadata(&path).unwrap().permissions().mode();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        write_store(&path, Object::new()).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode(), new_mode);
    }

    #[test]
    fn a_missing_file_reads_as_empty_and_creates_the_directory() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();
        let path = dir.join("sub/config.json");
        assert!(read_store(&path).unwrap().is_empty());
        assert!(dir.join("sub").is_dir());
    }
}
