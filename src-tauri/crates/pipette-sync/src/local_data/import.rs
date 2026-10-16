// SPDX-License-Identifier: GPL-2.0-or-later
//! The Local Data import of src/main/sync/local-data-import.ts: plan,
//! back up, write, roll back.
//!
//! Every unit the file touches (snapshots and settings by keyboard uid,
//! favorites by type) is locked for the whole import, so a plan built from
//! an index is never written over a save that landed in between. Nothing
//! is written until the whole plan is known; each planned write records
//! whether it overwrites a file (with that file's bytes) or creates one.
//! When a write fails, the writes already made are undone in reverse
//! order: an overwritten file gets its bytes back, a created one is
//! removed. A failed undo is reported with the failure, never dropped.
//!
//! Snapshots and favorites keep a local entry unless it is missing or
//! deleted, in which case the file's entry (and its body) replaces it;
//! settings go by the newer `_updatedAt`. Entries are read as v2 entries
//! and bodies are saved under names that carry the entry id; the local
//! store's legacy names are moved first, under the same lock and outside
//! the rollback (the move only copies and renames).

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};

use pipette_entry_store::{
    Entry, EntryGroup, EntryStore, OverwriteOptions, id_body_filename, is_safe_key, is_safe_path,
    normalize_entries, normalize_entry, overwrite_entry, read_index_dir_migrated, touch_clock,
};
use pipette_js_json::{JsString, Object, Value};
use pipette_keyboard_stores::StoreContext;
use pipette_time::date_value_ms;

/// Why an import failed. The texts are the Electron build's, but for the
/// system's own error texts.
#[derive(Debug, thiserror::Error)]
pub enum LocalDataImportError {
    #[error("Invalid export file format")]
    InvalidFormat,
    #[error("Unsupported export version")]
    UnsupportedVersion,
    /// The local index is not JSON.
    #[error("Corrupted index: {}", .0.display())]
    CorruptedIndex(PathBuf),
    /// The local index could not be read.
    #[error("Cannot read index: {}: {}", .0.display(), .1)]
    UnreadableIndex(PathBuf, io::Error),
    /// Where JavaScript throws a TypeError (a property of `null`).
    #[error("{0}")]
    Type(String),
    /// A planned write failed and so did undoing some of the writes before it.
    #[error("Import failed: {0}; rollback also failed: {1}")]
    RollbackFailed(io::Error, String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

type Result<T, E = LocalDataImportError> = std::result::Result<T, E>;

#[derive(Debug)]
enum WriteKind {
    /// The file existed; these are its bytes.
    Overwrite(Vec<u8>),
    Create,
}

#[derive(Debug)]
struct PlannedWrite {
    path: PathBuf,
    content: String,
    kind: WriteKind,
}

impl PlannedWrite {
    fn new(path: PathBuf, content: String, existing: Option<Vec<u8>>) -> Self {
        let kind = existing.map_or(WriteKind::Create, WriteKind::Overwrite);
        Self { path, content, kind }
    }
}

/// The file at `path`, `None` when it does not exist.
fn read_existing(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// `isRecord`: an object that is not an array.
fn as_record(value: Option<&Value>) -> Option<&Object> {
    match value {
        Some(Value::Object(object)) => Some(object),
        _ => None,
    }
}

fn null_property(key: &str) -> LocalDataImportError {
    LocalDataImportError::Type(format!("Cannot read properties of null (reading '{key}')"))
}

/// The properties every object inherits; `key in object` is true for them
/// whatever the object holds.
const OBJECT_PROTOTYPE_KEYS: &[&str] = &[
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

/// `object[key]` for a key that `key in object` finds: the own value, or
/// for an inherited property a value that is not a string.
fn in_lookup<'a>(object: &'a Object, key: &str) -> Option<Option<&'a Value>> {
    match object.get(key) {
        Some(value) => Some(Some(value)),
        None if OBJECT_PROTOTYPE_KEYS.contains(&key) => Some(None),
        None => None,
    }
}

/// `{...value}`: the own enumerable properties of a parsed JSON value.
fn spread(value: &Value) -> Object {
    match value {
        Value::Object(object) => object.clone(),
        Value::Array(items) => {
            items.iter().enumerate().map(|(at, item)| (at.to_string(), item.clone())).collect()
        }
        Value::String(text) => text
            .utf16_units()
            .into_iter()
            .enumerate()
            .map(|(at, unit)| (at.to_string(), Value::String(JsString::from_utf16(vec![unit]))))
            .collect(),
        _ => Object::new(),
    }
}

/// The local index of a store directory for the plan (`readIndexStrict`):
/// its bytes and parsed value, `None` when it does not exist.
fn read_index_strict(path: &Path) -> Result<Option<(Vec<u8>, Value)>> {
    let bytes = match read_existing(path) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Ok(None),
        Err(err) => return Err(LocalDataImportError::UnreadableIndex(path.to_owned(), err)),
    };
    // An index too deep to parse here is refused like one that is not
    // JSON, so it is never written over.
    let parsed = pipette_js_json::parse(&lossy(&bytes))
        .map_err(|_| LocalDataImportError::CorruptedIndex(path.to_owned()))?;
    Ok(Some((bytes, parsed)))
}

/// The index of an imported bundle (`{index: {entries: [...]}, files: {...}}`).
fn bundle_shape(bundle: &Value) -> Option<(&[Value], &Object)> {
    let bundle = bundle.as_object()?;
    let entries = match as_record(bundle.get("index"))?.get("entries") {
        Some(Value::Array(entries)) => entries.as_slice(),
        _ => return None,
    };
    Some((entries, as_record(bundle.get("files"))?))
}

/// Plans the writes of one snapshots or favorites bundle: an entry the
/// local store lacks or has deleted is taken from the bundle with its body;
/// a live local entry is kept. A tombstone revived by the import gets every
/// clock moved to now; an entry the store lacks gets a new `created` and
/// keeps its other clocks. `seed` gives a new index its fields.
fn plan_index_bundle(
    store: EntryStore,
    dir: &Path,
    bundle: &Value,
    seed: (&str, &str),
    now_ms: i64,
) -> Result<Vec<PlannedWrite>> {
    let (entries, files) = bundle_shape(bundle).ok_or(LocalDataImportError::InvalidFormat)?;
    let index_path = dir.join("index.json");
    // The local bodies carry their ids before the index is read and backed up.
    read_index_dir_migrated(store, dir)?;
    let local_index = read_index_strict(&index_path)?;
    let mut local_entries = match &local_index {
        Some((_, Value::Null)) => return Err(null_property("entries")),
        Some((_, Value::Object(index))) => normalize_entries(store, index.get("entries")),
        _ => Vec::new(),
    };
    // A Map of the entries as read, by id: the last entry of an id wins.
    // It is not updated by the import.
    let by_id: HashMap<JsString, (usize, Entry)> = local_entries
        .iter()
        .enumerate()
        .filter_map(|(at, e)| Some((e.id()?.clone(), (at, e.clone()))))
        .collect();
    let mut replaced: HashSet<usize> = HashSet::new();
    let mut writes = Vec::new();
    let mut changed = false;

    for raw in entries {
        let raw = match raw {
            Value::Null => return Err(null_property("id")),
            Value::Object(raw) => raw,
            _ => continue,
        };
        // A malformed entry is skipped; the others are still imported.
        let (Some(Value::String(id)), Some(Value::String(bundle_filename))) =
            (raw.get("id"), raw.get("filename"))
        else {
            continue;
        };
        if !bundle_filename.as_str().is_some_and(is_safe_path) {
            continue;
        }
        let mut imported = normalize_entry(store, raw);
        let filename = id_body_filename(store, id, bundle_filename);
        if !filename.as_str().is_some_and(is_safe_path) {
            continue;
        }
        imported.set("filename", Value::String(filename.clone()));

        let existing = by_id.get(id);
        // A live local entry is never replaced, nor revived by a tombstone.
        if existing.is_some_and(|(_, e)| !e.is_deleted()) {
            continue;
        }
        let entry = if imported.get("deletedAt").is_some() {
            imported
        } else if let Some((_, existing)) = existing {
            // A restore is the user's explicit save: it brings the tombstone back.
            let options = OverwriteOptions { body: true, explicit: true };
            overwrite_entry(store, Some(existing), imported.into_object(), now_ms, options)
                .map_err(|err| LocalDataImportError::Type(err.to_string()))?
        } else {
            // A new `created`, so a delete made elsewhere before the restore
            // does not remove it again on the next sync.
            touch_clock(&mut imported, EntryGroup::Created, now_ms)
                .map_err(|err| LocalDataImportError::Type(err.to_string()))?;
            imported
        };
        match existing.map(|(at, _)| *at) {
            // A second entry of the same id finds its first one already
            // replaced: the index keeps the first, its body is still written.
            Some(at) if replaced.insert(at) => local_entries[at] = entry,
            Some(_) => {}
            None => local_entries.push(entry),
        }

        if let Some(payload) = in_lookup(files, &bundle_filename.to_string_lossy()) {
            let Some(Value::String(payload)) = payload else {
                return Err(LocalDataImportError::InvalidFormat);
            };
            let path = dir.join(filename.to_string_lossy().as_ref());
            let existing = read_existing(&path)?;
            writes.push(PlannedWrite::new(path, payload.to_string_lossy().into_owned(), existing));
        }
        changed = true;
    }

    if changed {
        let mut index = match &local_index {
            Some((_, parsed)) => spread(parsed),
            None => [seed].into_iter().map(|(key, value)| (key, Value::from(value))).collect(),
        };
        index.insert("entries", Value::Array(local_entries.into_iter().map(Value::from).collect()));
        let content = pipette_js_json::stringify_with_gap(&Value::Object(index), "  ");
        writes.push(PlannedWrite::new(index_path, content, local_index.map(|(bytes, _)| bytes)));
    }
    Ok(writes)
}

/// `new Date(settings._updatedAt).getTime()`, 0 when it is falsy and NaN
/// when it is not a time; `None` where reading it throws (`null`).
fn updated_at_ms(settings: &Value) -> Option<f64> {
    match settings {
        Value::Null => None,
        Value::Object(o) => Some(match o.get("_updatedAt") {
            Some(v) if v.is_truthy() => date_value_ms(v).unwrap_or(f64::NAN),
            _ => 0.0,
        }),
        _ => Some(0.0),
    }
}

/// Plans the write of one keyboard's settings bundle: the file's settings
/// when they are newer by `_updatedAt` than the local ones, or the local
/// file cannot be compared (not JSON, `null`); `None` when the bundle has
/// no settings or they are not newer. Settings that are not JSON fail the
/// import before anything is written; so does a local file that exists
/// but cannot be read, or is too deeply nested to compare.
fn plan_settings_bundle(dir: &Path, bundle: &Value) -> Result<Option<PlannedWrite>> {
    let bundle = as_record(Some(bundle)).ok_or(LocalDataImportError::InvalidFormat)?;
    let files = match bundle.get("files") {
        None => None,
        Some(Value::Object(files)) => Some(files),
        Some(_) => return Err(LocalDataImportError::InvalidFormat),
    };
    let remote_content = match files.and_then(|f| f.get("pipette_settings.json")) {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(content)) => content.to_string_lossy().into_owned(),
        Some(_) => return Err(LocalDataImportError::InvalidFormat),
    };
    let remote = pipette_js_json::parse(&remote_content).map_err(|_| LocalDataImportError::InvalidFormat)?;

    let path = dir.join("pipette_settings.json");
    let local = read_existing(&path)?;
    if let Some(bytes) = &local {
        let newer = match pipette_js_json::parse(&lossy(bytes)) {
            Ok(local) => updated_at_ms(&local).zip(updated_at_ms(&remote)).is_none_or(|(l, r)| r > l),
            Err(err) if err.is_nesting_too_deep() => {
                let text = format!("{}: nested too deeply to read", path.display());
                return Err(LocalDataImportError::Io(io::Error::other(text)));
            }
            // A local file that is not JSON is replaced.
            Err(_) => true,
        };
        if !newer {
            return Ok(None);
        }
    }
    Ok(Some(PlannedWrite::new(path, remote_content, local)))
}

/// The safe keys of `data[category]`, with their bundles, in the object's
/// order.
fn bundles<'a>(data: &'a Object, category: &str) -> Vec<(&'a str, &'a Value)> {
    as_record(data.get(category))
        .map(|bundles| {
            bundles
                .iter()
                .filter_map(|(key, bundle)| key.as_str().filter(|k| is_safe_key(k)).map(|k| (k, bundle)))
                .collect()
        })
        .unwrap_or_default()
}

/// The store lock keys of the units the file touches (`storeLockKey` of
/// the units: the uid for a keyboard's units, `favorites/{type}`).
fn lock_keys(data: &Object) -> Vec<String> {
    let uids =
        ["snapshots", "settings"].into_iter().flat_map(|c| bundles(data, c)).map(|(uid, _)| uid.to_owned());
    let types = bundles(data, "favorites").into_iter().map(|(ty, _)| format!("favorites/{ty}"));
    uids.chain(types).collect()
}

struct Plan {
    writes: Vec<PlannedWrite>,
    changed_units: Vec<String>,
}

fn build_plan(ctx: &StoreContext, data: &Object) -> Result<Plan> {
    let now_ms = ctx.now_ms();
    let keyboards = ctx.sync_dir().join("keyboards");
    let mut plan = Plan { writes: Vec::new(), changed_units: Vec::new() };
    for (uid, bundle) in bundles(data, "snapshots") {
        let dir = keyboards.join(uid).join("snapshots");
        let writes = plan_index_bundle(EntryStore::Snapshots, &dir, bundle, ("uid", uid), now_ms)?;
        if !writes.is_empty() {
            plan.writes.extend(writes);
            plan.changed_units.push(format!("keyboards/{uid}/snapshots"));
        }
    }
    for (uid, bundle) in bundles(data, "settings") {
        if let Some(write) = plan_settings_bundle(&keyboards.join(uid), bundle)? {
            plan.writes.push(write);
            plan.changed_units.push(format!("keyboards/{uid}/settings"));
        }
    }
    for (ty, bundle) in bundles(data, "favorites") {
        let dir = ctx.sync_dir().join("favorites").join(ty);
        let writes = plan_index_bundle(EntryStore::Favorites, &dir, bundle, ("type", ty), now_ms)?;
        if !writes.is_empty() {
            plan.writes.extend(writes);
            plan.changed_units.push(format!("favorites/{ty}"));
        }
    }
    Ok(plan)
}

/// How the plan's files are written and undone; the tests make it fail.
pub(crate) trait PlanFs {
    fn write(&self, path: &Path, content: &[u8]) -> io::Result<()>;
    fn remove(&self, path: &Path) -> io::Result<()>;
}

struct RealFs;

impl PlanFs for RealFs {
    fn write(&self, path: &Path, content: &[u8]) -> io::Result<()> {
        pipette_fs::write_file_atomic(path, content)
    }

    fn remove(&self, path: &Path) -> io::Result<()> {
        std::fs::remove_file(path)
    }
}

/// Writes the plan in order; on a failure, undoes the writes already made
/// (in reverse order) and fails.
fn write_plan(fs: &dyn PlanFs, writes: &[PlannedWrite]) -> Result<()> {
    let mut dirs: Vec<&Path> = Vec::new();
    for dir in writes.iter().filter_map(|w| w.path.parent()) {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    for dir in dirs {
        std::fs::create_dir_all(dir)?;
    }

    for (done, write) in writes.iter().enumerate() {
        let Err(err) = fs.write(&write.path, write.content.as_bytes()) else { continue };
        let undo_errors: Vec<String> = writes[..done]
            .iter()
            .rev()
            .filter_map(|w| {
                match &w.kind {
                    WriteKind::Overwrite(bytes) => fs.write(&w.path, bytes),
                    WriteKind::Create => fs.remove(&w.path),
                }
                .err()
                .map(|e| e.to_string())
            })
            .collect();
        if undo_errors.is_empty() {
            return Err(err.into());
        }
        return Err(LocalDataImportError::RollbackFailed(err, undo_errors.join("; ")));
    }
    Ok(())
}

pub(crate) fn import_with(ctx: &StoreContext, file: &Value, fs: &dyn PlanFs) -> Result<Vec<String>> {
    let data = as_record(Some(file)).ok_or(LocalDataImportError::InvalidFormat)?;
    if data.get("version") != Some(&Value::Number(1.0)) {
        return Err(LocalDataImportError::UnsupportedVersion);
    }
    let keys = lock_keys(data);
    let keys: Vec<&str> = keys.iter().map(String::as_str).collect();
    ctx.locks().with_write_locks(&keys, || {
        let plan = build_plan(ctx, data)?;
        if plan.writes.is_empty() {
            return Ok(Vec::new());
        }
        write_plan(fs, &plan.writes)?;
        Ok(plan.changed_units)
    })
}

/// Imports the parsed export file `file` (`importLocalData`) and answers
/// the units it changed, for the caller to report for sync.
pub fn import_local_data(ctx: &StoreContext, file: &Value) -> Result<Vec<String>> {
    import_with(ctx, file, &RealFs)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use pipette_entry_store::{FixedClock, WriteLocks};

    use super::*;

    /// Fails the `fail_write`-th write (1-based) and, when `fail_remove`,
    /// every removal; anything else goes to the disk.
    struct FailingFs {
        writes: AtomicUsize,
        fail_write: usize,
        fail_remove: bool,
    }

    impl PlanFs for FailingFs {
        fn write(&self, path: &Path, content: &[u8]) -> io::Result<()> {
            if self.writes.fetch_add(1, Ordering::SeqCst) + 1 == self.fail_write {
                return Err(io::Error::other("disk full"));
            }
            RealFs.write(path, content)
        }

        fn remove(&self, path: &Path) -> io::Result<()> {
            if self.fail_remove {
                return Err(io::Error::other("unlink denied"));
            }
            RealFs.remove(path)
        }
    }

    const ORIGINAL_INDEX: &str = r#"{"uid":"uid1","entries":[{"id":"e0","label":"Existing","filename":"s_e0.pipette","savedAt":"2019-01-01T00:00:00.000Z"}]}"#;

    fn setup() -> (tempfile::TempDir, StoreContext, PathBuf, Value) {
        let root = tempfile::tempdir().unwrap();
        let ctx = StoreContext::new(
            root.path(),
            Arc::new(FixedClock::new(1_792_108_800_000)),
            Arc::new(WriteLocks::new()),
            Arc::new(|_: &str| {}),
        );
        let dir = root.path().join("sync/keyboards/uid1/snapshots");
        std::fs::create_dir_all(&dir).unwrap();
        // `s_{id}` names carry their ids already, so nothing is moved.
        std::fs::write(dir.join("index.json"), ORIGINAL_INDEX).unwrap();
        std::fs::write(dir.join("s_e0.pipette"), "ORIGINAL").unwrap();
        let file = pipette_js_json::parse(
            r#"{"version":1,"snapshots":{"uid1":{"index":{"entries":[
                {"id":"e1","label":"New1","filename":"s_e1.pipette","savedAt":"2020-01-01T00:00:00.000Z"},
                {"id":"e2","label":"New2","filename":"s_e2.pipette","savedAt":"2020-01-02T00:00:00.000Z"}
            ]},"files":{"s_e1.pipette":"PAYLOAD1","s_e2.pipette":"PAYLOAD2"}}}}"#,
        )
        .unwrap();
        (root, ctx, dir, file)
    }

    #[test]
    fn a_failed_write_undoes_the_writes_before_it() {
        let (_root, ctx, dir, file) = setup();
        let before = std::fs::read(dir.join("index.json")).unwrap();
        let fs = FailingFs { writes: AtomicUsize::new(0), fail_write: 2, fail_remove: false };
        let err = import_with(&ctx, &file, &fs).unwrap_err();
        assert_eq!(err.to_string(), "disk full");
        assert!(!dir.join("s_e1.pipette").exists());
        assert!(!dir.join("s_e2.pipette").exists());
        assert_eq!(std::fs::read(dir.join("index.json")).unwrap(), before);
        assert_eq!(std::fs::read_to_string(dir.join("s_e0.pipette")).unwrap(), "ORIGINAL");
    }

    #[test]
    fn a_failed_undo_is_reported_with_the_failure() {
        let (_root, ctx, dir, file) = setup();
        let fs = FailingFs { writes: AtomicUsize::new(0), fail_write: 2, fail_remove: true };
        let err = import_with(&ctx, &file, &fs).unwrap_err();
        assert_eq!(err.to_string(), "Import failed: disk full; rollback also failed: unlink denied");
        // The write that could not be undone is left, and the caller is told.
        assert!(dir.join("s_e1.pipette").exists());
    }

    #[test]
    fn an_overwritten_file_gets_its_bytes_back() {
        let (_root, ctx, dir, _) = setup();
        // A tombstone whose body is not UTF-8: the undo restores its bytes.
        std::fs::write(
            dir.join("index.json"),
            r#"{"uid":"uid1","entries":[{"id":"e0","filename":"s_e0.pipette","savedAt":"2019-01-01T00:00:00.000Z","deletedAt":"2019-02-01T00:00:00.000Z"}]}"#,
        )
        .unwrap();
        std::fs::write(dir.join("s_e0.pipette"), b"\xff\xfe old").unwrap();
        let file = pipette_js_json::parse(
            r#"{"version":1,"snapshots":{"uid1":{"index":{"entries":[
                {"id":"e0","filename":"s_e0.pipette","savedAt":"2019-01-01T00:00:00.000Z"}
            ]},"files":{"s_e0.pipette":"BACK"}}}}"#,
        )
        .unwrap();
        let fs = FailingFs { writes: AtomicUsize::new(0), fail_write: 2, fail_remove: false };
        import_with(&ctx, &file, &fs).unwrap_err();
        assert_eq!(std::fs::read(dir.join("s_e0.pipette")).unwrap(), b"\xff\xfe old");
    }

    #[test]
    fn local_files_too_deep_to_read_are_never_written_over() {
        let (root, ctx, dir, _) = setup();
        let deep = format!(
            "{}{}",
            "[".repeat(pipette_js_json::MAX_DEPTH + 1),
            "]".repeat(pipette_js_json::MAX_DEPTH + 1)
        );
        let settings = root.path().join("sync/keyboards/uid1/pipette_settings.json");
        std::fs::write(&settings, format!(r#"{{"_updatedAt":"2030-01-01T00:00:00.000Z","x":{deep}}}"#))
            .unwrap();
        std::fs::write(dir.join("index.json"), format!(r#"{{"uid":"uid1","entries":[],"x":{deep}}}"#))
            .unwrap();
        let before = read_existing(&settings).unwrap();
        let settings_only = pipette_js_json::parse(
            r#"{"version":1,"settings":{"uid1":{"files":{"pipette_settings.json":"{}"}}}}"#,
        )
        .unwrap();
        assert!(import_local_data(&ctx, &settings_only).is_err());
        assert_eq!(read_existing(&settings).unwrap(), before);
        let snapshots = pipette_js_json::parse(
            r#"{"version":1,"snapshots":{"uid1":{"index":{"entries":[{"id":"e1","filename":"s_e1.pipette"}]},"files":{}}}}"#,
        )
        .unwrap();
        assert!(matches!(import_local_data(&ctx, &snapshots), Err(LocalDataImportError::CorruptedIndex(_))));
    }
}
