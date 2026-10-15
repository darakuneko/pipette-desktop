// SPDX-License-Identifier: GPL-2.0-or-later
//! The file's format: `{"version":1,"owner":…,"units":[…],"held":{…}}`,
//! `JSON.stringify` with no indent, as `writePendingNow` of
//! src/main/sync/sync-pending-store.ts writes it, and what `readPending`
//! there keeps of a file an earlier run left.

use std::io::ErrorKind;
use std::path::Path;

use indexmap::IndexSet;
use pipette_entry_store::is_safe_path_segment;
use pipette_js_json::{JsString, Object, Value};

/// The `version` of the file.
const FILE_VERSION: f64 = 1.0;

/// The pending state of a file: the active units with the account they were
/// changed under, and the units held for other accounts, each list in file
/// order without duplicates.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct PendingFile {
    pub owner: Option<JsString>,
    pub units: Vec<JsString>,
    pub held: Vec<(JsString, Vec<JsString>)>,
}

/// The file's text for this state.
pub(crate) fn content<'a>(
    owner: Option<&JsString>,
    units: impl Iterator<Item = &'a JsString>,
    held: &[(JsString, Vec<JsString>)],
) -> String {
    let held: Object = held.iter().map(|(sub, list)| (sub.clone(), string_array(list.iter()))).collect();
    let mut file = Object::new();
    file.insert("version", Value::Number(FILE_VERSION));
    file.insert("owner", owner.map_or(Value::Null, |owner| Value::String(owner.clone())));
    file.insert("units", string_array(units));
    file.insert("held", Value::Object(held));
    pipette_js_json::stringify(&Value::Object(file))
}

fn string_array<'a>(list: impl Iterator<Item = &'a JsString>) -> Value {
    Value::Array(list.map(|unit| Value::String(unit.clone())).collect())
}

/// The pending state the file at `path` holds; `None` when it exists but
/// cannot be read. A missing file, or one that is not JSON of the expected
/// shape, reads as an empty state. Units are checked against
/// `keyboards_dir` (`sync/keyboards` of the userData directory).
pub(crate) fn read(path: &Path, keyboards_dir: &Path) -> Option<PendingFile> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == ErrorKind::NotFound => return Some(PendingFile::default()),
        Err(err) => {
            log::warn!("[sync-pending] cannot read the pending file; changes are kept in memory only: {err}");
            return None;
        }
    };
    // readFileSync(…, 'utf-8') reads each invalid sequence as U+FFFD.
    let text = String::from_utf8_lossy(&bytes);
    let parsed = match pipette_js_json::parse(&text) {
        Ok(parsed) => parsed,
        Err(err) => {
            log::warn!("[sync-pending] ignoring a malformed pending file: {err}");
            return Some(PendingFile::default());
        }
    };
    Some(from_value(&parsed, keyboards_dir))
}

fn from_value(parsed: &Value, keyboards_dir: &Path) -> PendingFile {
    let Some(file) = parsed.as_object() else { return PendingFile::default() };
    if !matches!(file.get("version"), Some(Value::Number(n)) if *n == FILE_VERSION) {
        return PendingFile::default();
    }
    let Some(Value::Array(units)) = file.get("units") else { return PendingFile::default() };

    let mut held = Vec::new();
    if let Some(Value::Object(accounts)) = file.get("held") {
        for (sub, list) in accounts.iter() {
            // `held[sub] = kept` on a plain object sets its prototype for
            // `__proto__` instead of adding a property, so the TypeScript
            // reader drops that account.
            if sub.is_empty() || sub.as_str() == Some("__proto__") {
                continue;
            }
            let kept = live_units(list, keyboards_dir);
            if !kept.is_empty() {
                held.push((sub.clone(), kept));
            }
        }
    }
    let owner = match file.get("owner") {
        Some(Value::String(owner)) if !owner.is_empty() => Some(owner.clone()),
        _ => None,
    };
    PendingFile { owner, units: live_units_of(units, keyboards_dir), held }
}

/// [`live_units_of`] for any value: none unless it is an array.
fn live_units(value: &Value, keyboards_dir: &Path) -> Vec<JsString> {
    match value {
        Value::Array(list) => live_units_of(list, keyboards_dir),
        _ => Vec::new(),
    }
}

/// The strings of `list` whose every segment is a safe path segment (the
/// rule a sync merge applies before it joins a unit into a local path),
/// minus each `keyboards/{uid}/…` unit whose keyboard directory is gone (a
/// keyboard reset or removed by hand while the app was closed): uploading
/// it could bring that keyboard's data back from Drive.
fn live_units_of(list: &[Value], keyboards_dir: &Path) -> Vec<JsString> {
    let mut units = IndexSet::new();
    for value in list {
        let Value::String(unit) = value else { continue };
        // A lone surrogate is neither a separator nor allowed anywhere it
        // matters, and Node's paths read it as U+FFFD too.
        let text = unit.to_string_lossy();
        if !text.split('/').all(is_safe_path_segment) {
            continue;
        }
        let mut segments = text.split('/');
        if segments.next() == Some("keyboards")
            && let Some(uid) = segments.next()
            && !dir_exists(&keyboards_dir.join(uid))
        {
            continue;
        }
        units.insert(unit.clone());
    }
    units.into_iter().collect()
}

/// Only a missing entry counts as absent; any other error as present.
fn dir_exists(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(_) => true,
        Err(err) => err.kind() != ErrorKind::NotFound,
    }
}
