// SPDX-License-Identifier: GPL-2.0-or-later
//! Record-start keymap snapshots and the three handlers that save, pick and
//! list them.
//!
//! Each (keyboard uid, machine hash) has a directory of `{savedAt}.json`
//! files under `userData/typing-analytics/keymaps/`, written unindented. A
//! new snapshot is written only when the keymap content differs from the
//! newest one, so the files follow the user's keymap edits rather than the
//! record sessions. They are this device's own and never synced.
//!
//! The files are read as the JSON values they hold, whatever their shape,
//! and handed back as such, as the TypeScript code does with what
//! `JSON.parse` gives.
//!
//! A uid that is not a single path segment (empty, `.`, `..`, or with `/` or
//! `\`) has no snapshot directory, so nothing is saved, picked or listed for
//! it; joined to a path it would resolve to a directory elsewhere. A uid with a
//! lone surrogate counts as no uid.

use std::io;
use std::path::{Path, PathBuf};

use pipette_entry_store::is_safe_path_segment;
use pipette_js_json::{Object, Value};

use crate::identity::IdentityError;
use crate::jsonl::row::js_number_string;

/// `userData/typing-analytics/keymaps/{uid}/{machineHash}`, or `None` for a
/// uid that is not a single path segment.
pub fn snapshot_dir(user_data: &Path, uid: &str, machine_hash: &str) -> Option<PathBuf> {
    is_safe_path_segment(uid)
        .then(|| user_data.join("typing-analytics").join("keymaps").join(uid).join(machine_hash))
}

fn snapshot_path(dir: &Path, saved_at: f64) -> PathBuf {
    dir.join(format!("{}.json", js_number_string(saved_at)))
}

#[derive(Debug, thiserror::Error)]
pub enum KeymapSnapshotError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Identity(#[from] IdentityError),
    /// The newest snapshot has the same `layers` but no `matrix` object to
    /// compare (`isSameContent` throws a TypeError).
    #[error("TypeError: Cannot read properties of the newest snapshot's matrix")]
    NoMatrix,
}

/// The `savedAt` of every `{digits}.json` name in `dir`, ascending; none
/// when the directory is missing. The digits are read as a number, so
/// `007.json` stands for 7 and is then looked up as `7.json`.
fn list_saved_ats(dir: &Path) -> io::Result<Vec<f64>> {
    let read = match std::fs::read_dir(dir) {
        Ok(read) => read,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let mut saved_ats = Vec::new();
    for entry in read {
        let name = entry?.file_name();
        let Some(digits) = name.to_str().and_then(|name| name.strip_suffix(".json")) else { continue };
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        if let Ok(n) = digits.parse::<f64>()
            && n.is_finite()
        {
            saved_ats.push(n);
        }
    }
    saved_ats.sort_by(f64::total_cmp);
    Ok(saved_ats)
}

/// The JSON value of a snapshot file; `None` when it cannot be read or is
/// not JSON.
fn read_snapshot_file(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    pipette_js_json::parse(&String::from_utf8_lossy(&bytes)).ok()
}

/// `value[key]`: `Err` where JavaScript throws (null), `None` for a
/// property that is not there (any other non-object value has none of the
/// keys read here).
fn prop<'a>(value: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>, KeymapSnapshotError> {
    match value {
        Some(Value::Object(object)) => Ok(object.get(key)),
        None | Some(Value::Null) => Err(KeymapSnapshotError::NoMatrix),
        Some(_) => Ok(None),
    }
}

/// `a === b`, an absent property being `undefined`. Two arrays or objects
/// are never the same: one side is always freshly parsed.
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a == b,
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        _ => false,
    }
}

/// `JSON.stringify(a) === JSON.stringify(b)`, `undefined` for an absent
/// property.
fn same_json(a: Option<&Value>, b: Option<&Value>) -> bool {
    a.map(pipette_js_json::stringify) == b.map(pipette_js_json::stringify)
}

/// `isSameContent(latest, snapshot)`: the parts a key heatmap depends on
/// (`layers`, the matrix size, `keymap`, `layout`); `productName` and
/// `savedAt` do not count, so a cosmetic refresh does not cut a snapshot.
fn is_same_content(latest: &Value, snapshot: &Object) -> Result<bool, KeymapSnapshotError> {
    let latest = Some(latest);
    if !strict_eq(prop(latest, "layers")?, snapshot.get("layers")) {
        return Ok(false);
    }
    let (a, b) = (prop(latest, "matrix")?, snapshot.get("matrix"));
    if !strict_eq(prop(a, "rows")?, prop(b, "rows")?) || !strict_eq(prop(a, "cols")?, prop(b, "cols")?) {
        return Ok(false);
    }
    Ok(same_json(prop(latest, "keymap")?, snapshot.get("keymap"))
        && same_json(prop(latest, "layout")?, snapshot.get("layout")))
}

/// What a save answers: `{ saved, savedAt }`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SaveSnapshotResult {
    pub saved: bool,
    pub saved_at: Option<f64>,
}

impl SaveSnapshotResult {
    pub const NOT_SAVED: Self = Self { saved: false, saved_at: None };

    /// The answer as `JSON.stringify` writes it.
    pub fn to_json(&self) -> String {
        let mut object = Object::new();
        object.insert("saved", Value::Bool(self.saved));
        object.insert("savedAt", self.saved_at.map_or(Value::Null, Value::Number));
        pipette_js_json::stringify(&Value::Object(object))
    }
}

/// `saveKeymapSnapshotIfChanged`: writes `snapshot` (as the handler builds
/// it, with a string `uid` and `machineHash` and a number `savedAt`) as
/// `{savedAt}.json` unless the newest snapshot of its directory has the
/// same content; then it answers that snapshot's `savedAt`.
pub fn save_keymap_snapshot_if_changed(
    user_data: &Path,
    snapshot: &Object,
) -> Result<SaveSnapshotResult, KeymapSnapshotError> {
    let text = |key| snapshot.get(key).and_then(Value::as_str).unwrap_or_default();
    let saved_at = match snapshot.get("savedAt") {
        Some(Value::Number(n)) => *n,
        _ => f64::NAN,
    };
    let Some(dir) = snapshot_dir(user_data, text("uid"), text("machineHash")) else {
        return Ok(SaveSnapshotResult::NOT_SAVED);
    };
    if let Some(&latest_saved_at) = list_saved_ats(&dir)?.last() {
        let latest = read_snapshot_file(&snapshot_path(&dir, latest_saved_at));
        if let Some(latest) = latest.filter(Value::is_truthy)
            && is_same_content(&latest, snapshot)?
        {
            return Ok(SaveSnapshotResult { saved: false, saved_at: Some(latest_saved_at) });
        }
    }
    std::fs::create_dir_all(&dir)?;
    let content = pipette_js_json::stringify(&Value::Object(snapshot.clone()));
    pipette_fs::write_file_atomic(&snapshot_path(&dir, saved_at), content.as_bytes())?;
    Ok(SaveSnapshotResult { saved: true, saved_at: Some(saved_at) })
}

/// `getKeymapSnapshotForRange`: the newest snapshot saved inside
/// `[from_ms, to_ms)`, else the newest saved at or before `from_ms`, as
/// the JSON value its file holds; null when there is none or the picked
/// file cannot be read.
pub fn get_keymap_snapshot_for_range(
    user_data: &Path,
    uid: &str,
    machine_hash: &str,
    from_ms: f64,
    to_ms: f64,
) -> io::Result<Value> {
    let Some(dir) = snapshot_dir(user_data, uid, machine_hash) else { return Ok(Value::Null) };
    let saved_ats = list_saved_ats(&dir)?;
    let pick = saved_ats
        .iter()
        .rev()
        .find(|&&s| s >= from_ms && s < to_ms)
        .or_else(|| saved_ats.iter().rev().find(|&&s| s <= from_ms));
    Ok(pick.and_then(|&s| read_snapshot_file(&snapshot_path(&dir, s))).unwrap_or(Value::Null))
}

const SUMMARY_KEYS: [&str; 6] = ["uid", "machineHash", "productName", "savedAt", "layers", "matrix"];

/// `listKeymapSnapshotSummaries`: each readable snapshot without its
/// `keymap` and `layout`, ascending by `savedAt`. A file that cannot be
/// read, is not JSON or holds a falsy value is skipped; a field the file
/// lacks is left out.
pub fn list_keymap_snapshot_summaries(
    user_data: &Path,
    uid: &str,
    machine_hash: &str,
) -> io::Result<Vec<Value>> {
    let Some(dir) = snapshot_dir(user_data, uid, machine_hash) else { return Ok(Vec::new()) };
    Ok(list_saved_ats(&dir)?
        .into_iter()
        .filter_map(|saved_at| read_snapshot_file(&snapshot_path(&dir, saved_at)))
        .filter(Value::is_truthy)
        .map(|snapshot| {
            let mut summary = Object::new();
            if let Value::Object(fields) = &snapshot {
                for key in SUMMARY_KEYS {
                    if let Some(value) = fields.get(key) {
                        summary.insert(key, value.clone());
                    }
                }
            }
            Value::Object(summary)
        })
        .collect())
}

// --- the IPC handlers ------------------------------------------------------

/// A non-empty string, as the handlers check `uid`.
fn uid_of(value: Option<&Value>) -> Option<&str> {
    match value {
        Some(Value::String(uid)) if !uid.is_empty() => uid.as_str(),
        _ => None,
    }
}

fn finite(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) if n.is_finite() => Some(*n),
        _ => None,
    }
}

/// The snapshot the save handler builds from what the renderer sent:
/// `productName` a string or `''`, `savedAt` a finite number or `now_ms`,
/// `layers` a number or 0, `matrix` and `layout` as sent unless null or
/// absent (`{ rows: 0, cols: 0 }` and null then), `keymap` an array or
/// `[]`, `vialProtocol` only when a number; the fields in that order,
/// nothing else kept.
fn snapshot_from_request(request: &Object, uid: &str, machine_hash: &str, now_ms: i64) -> Object {
    let present = |key| request.get(key).filter(|v| !matches!(v, Value::Null));
    let mut snapshot = Object::new();
    snapshot.insert("uid", Value::from(uid));
    snapshot.insert("machineHash", Value::from(machine_hash));
    let product_name = match request.get("productName") {
        Some(name @ Value::String(_)) => name.clone(),
        _ => Value::from(""),
    };
    snapshot.insert("productName", product_name);
    // A clock reading is far inside ±2^53 ms, so the conversion is exact.
    let saved_at = request.get("savedAt").and_then(finite).unwrap_or(now_ms as f64);
    snapshot.insert("savedAt", Value::Number(saved_at));
    let layers = match request.get("layers") {
        Some(layers @ Value::Number(_)) => layers.clone(),
        _ => Value::Number(0.0),
    };
    snapshot.insert("layers", layers);
    let matrix = present("matrix").cloned().unwrap_or_else(|| {
        Value::Object([("rows", Value::Number(0.0)), ("cols", Value::Number(0.0))].into_iter().collect())
    });
    snapshot.insert("matrix", matrix);
    let keymap = match request.get("keymap") {
        Some(keymap @ Value::Array(_)) => keymap.clone(),
        _ => Value::Array(Vec::new()),
    };
    snapshot.insert("keymap", keymap);
    snapshot.insert("layout", present("layout").cloned().unwrap_or(Value::Null));
    if let Some(protocol @ Value::Number(_)) = request.get("vialProtocol") {
        snapshot.insert("vialProtocol", protocol.clone());
    }
    snapshot
}

/// The save handler (`typingAnalyticsSaveKeymapSnapshot`): nothing saved
/// for a request that is not an object with a non-empty `uid`; a failure
/// (the machine hash, the file system, a newest snapshot it cannot
/// compare) is logged and answers nothing saved too.
pub fn save_snapshot_request(
    user_data: &Path,
    request: &Value,
    machine_hash: impl FnOnce() -> Result<String, IdentityError>,
    now_ms: i64,
) -> SaveSnapshotResult {
    let Value::Object(request) = request else { return SaveSnapshotResult::NOT_SAVED };
    let Some(uid) = uid_of(request.get("uid")) else { return SaveSnapshotResult::NOT_SAVED };
    let saved = machine_hash().map_err(KeymapSnapshotError::from).and_then(|hash| {
        save_keymap_snapshot_if_changed(user_data, &snapshot_from_request(request, uid, &hash, now_ms))
    });
    saved.unwrap_or_else(|err| {
        log::warn!("[typing-analytics] saveKeymapSnapshot failed: {err}");
        SaveSnapshotResult::NOT_SAVED
    })
}

/// The pick handler (`typingAnalyticsGetKeymapSnapshotForRange`) on this
/// device's snapshots: null for a uid that is not a non-empty string or a
/// bound that is not a finite number.
pub fn snapshot_for_range_request(
    user_data: &Path,
    uid: &Value,
    from_ms: &Value,
    to_ms: &Value,
    machine_hash: impl FnOnce() -> Result<String, IdentityError>,
) -> Result<Value, KeymapSnapshotError> {
    let (Some(uid), Some(from_ms), Some(to_ms)) = (uid_of(Some(uid)), finite(from_ms), finite(to_ms)) else {
        return Ok(Value::Null);
    };
    Ok(get_keymap_snapshot_for_range(user_data, uid, &machine_hash()?, from_ms, to_ms)?)
}

/// The list handler (`typingAnalyticsListKeymapSnapshots`) on this
/// device's snapshots: none for a uid that is not a non-empty string.
pub fn snapshot_summaries_request(
    user_data: &Path,
    uid: &Value,
    machine_hash: impl FnOnce() -> Result<String, IdentityError>,
) -> Result<Value, KeymapSnapshotError> {
    let Some(uid) = uid_of(Some(uid)) else { return Ok(Value::Array(Vec::new())) };
    Ok(Value::Array(list_keymap_snapshot_summaries(user_data, uid, &machine_hash()?)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "hash-a";

    fn snapshot(saved_at: f64, keymap: &str) -> Object {
        let text = format!(
            r#"{{"uid":"kb-1","machineHash":"{HASH}","productName":"Tester","savedAt":{saved_at},"layers":4,"matrix":{{"rows":5,"cols":12}},"keymap":{keymap},"layout":null}}"#
        );
        match pipette_js_json::parse(&text).unwrap() {
            Value::Object(object) => object,
            _ => unreachable!(),
        }
    }

    fn saved_ats(user_data: &Path) -> Vec<Value> {
        list_keymap_snapshot_summaries(user_data, "kb-1", HASH)
            .unwrap()
            .iter()
            .map(|s| s.as_object().unwrap().get("savedAt").unwrap().clone())
            .collect()
    }

    #[test]
    fn saves_only_a_changed_keymap_and_lists_it() {
        let dir = tempfile::tempdir().unwrap();
        assert!(saved_ats(dir.path()).is_empty());
        let first =
            save_keymap_snapshot_if_changed(dir.path(), &snapshot(1000.0, r#"[[["KC_A"]]]"#)).unwrap();
        assert_eq!(first, SaveSnapshotResult { saved: true, saved_at: Some(1000.0) });
        let same = save_keymap_snapshot_if_changed(dir.path(), &snapshot(1500.0, r#"[[["KC_A"]]]"#)).unwrap();
        assert_eq!(same, SaveSnapshotResult { saved: false, saved_at: Some(1000.0) });
        save_keymap_snapshot_if_changed(dir.path(), &snapshot(2000.0, r#"[[["KC_B"]]]"#)).unwrap();
        assert_eq!(saved_ats(dir.path()), [Value::Number(1000.0), Value::Number(2000.0)]);
        let summary = list_keymap_snapshot_summaries(dir.path(), "kb-1", HASH).unwrap().remove(0);
        assert!(summary.as_object().unwrap().get("keymap").is_none());
    }

    #[test]
    fn picks_the_newest_in_the_range_or_the_one_before_it() {
        let dir = tempfile::tempdir().unwrap();
        for saved_at in [1000.0, 2000.0, 3000.0] {
            let keymap = format!(r#"[[["{saved_at}"]]]"#);
            save_keymap_snapshot_if_changed(dir.path(), &snapshot(saved_at, &keymap)).unwrap();
        }
        let pick = |from, to| {
            let value = get_keymap_snapshot_for_range(dir.path(), "kb-1", HASH, from, to).unwrap();
            value.as_object().and_then(|o| o.get("savedAt").cloned())
        };
        assert_eq!(pick(500.0, 2500.0), Some(Value::Number(2000.0)));
        assert_eq!(pick(2500.0, 2600.0), Some(Value::Number(2000.0)));
        assert_eq!(pick(2000.0, 2000.0), Some(Value::Number(2000.0)));
        assert_eq!(pick(500.0, 900.0), None);
    }

    #[test]
    fn a_uid_that_is_not_one_segment_has_no_directory() {
        let dir = tempfile::tempdir().unwrap();
        for uid in ["", ".", "..", "a/b", "a\\b", "/abs"] {
            assert!(snapshot_dir(dir.path(), uid, HASH).is_none(), "{uid}");
        }
        let mut escaping = snapshot(1.0, "[]");
        escaping.insert("uid", Value::from(".."));
        assert_eq!(
            save_keymap_snapshot_if_changed(dir.path(), &escaping).unwrap(),
            SaveSnapshotResult::NOT_SAVED
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        assert_eq!(get_keymap_snapshot_for_range(dir.path(), "..", HASH, 0.0, 1.0).unwrap(), Value::Null);
    }
}
