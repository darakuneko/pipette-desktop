// SPDX-License-Identifier: GPL-2.0-or-later
//! The merge of an index-based store (favorites, snapshots, analyze
//! filters, key labels, typing-test texts, run logs): the entries merge by
//! their group clocks ([`merge_entries`]), remote bodies are saved under
//! id-carrying names, then the index is written, the run logs past the
//! retention go, and the body files no entry names are removed.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use pipette_entry_store::{
    BodyPolicy, Entry, EntryStore, IndexDirRead, MergeOptions, MergeSide, body_hash, id_body_filename,
    is_safe_path_segment, merge_entries, read_index_dir_migrated, unlink_unreferenced_body_files,
};
use pipette_js_json::{JsString, Object, Value};
use pipette_keyboard_stores::{KEY_LABEL_SYNC_UNIT, MAX_RUN_LOGS_PER_KEYBOARD};

use super::{MergeEnv, MergeError, opt_prop, prop};
use crate::units::{entry_store_for_sync_unit, store_lock_key};

pub(super) fn merge_index_store(
    env: &MergeEnv<'_>,
    unit: &str,
    parts: &[&str],
    bundle: &Value,
) -> Result<bool, MergeError> {
    let dir = parts.iter().fold(env.ctx.sync_dir(), |dir, part| dir.join(part));
    std::fs::create_dir_all(&dir)?;
    env.ctx.locks().with_write_lock(&store_lock_key(unit), || {
        let store = entry_store_for_sync_unit(unit).ok_or_else(|| MergeError::Malformed(unit.to_owned()))?;
        merge_locked(env, store, unit, bundle, &dir)
    })
}

/// A remote entry the merge reads: an object with a string `id` and a
/// string `filename`.
fn entry_shaped(value: &Value) -> Option<Entry> {
    let object = value.as_object()?;
    match (object.get("id"), object.get("filename")) {
        (Some(Value::String(_)), Some(Value::String(_))) => Some(Entry::from_object(object.clone())),
        _ => None,
    }
}

fn safe(name: &JsString) -> bool {
    name.as_str().is_some_and(is_safe_path_segment)
}

/// `dir` joined with a name [`safe`] accepted.
fn path_of(dir: &Path, name: &JsString) -> Option<PathBuf> {
    name.as_str().filter(|n| is_safe_path_segment(n)).map(|n| dir.join(n))
}

fn merge_locked(
    env: &MergeEnv<'_>,
    store: EntryStore,
    unit: &str,
    bundle: &Value,
    dir: &Path,
) -> Result<bool, MergeError> {
    // A remote bundle is data anyone who can write this unit's Drive file
    // chooses: a non-array `entries` or a missing `files` is malformed, and
    // entries without a string `id` and `filename` are dropped.
    let index = prop(bundle, "index")?;
    let remote_entries = match opt_prop(index, "entries") {
        Some(Value::Array(entries)) => entries,
        _ => return Err(MergeError::Malformed(unit.to_owned())),
    };
    let empty = Object::new();
    let remote_files = match prop(bundle, "files")? {
        Some(Value::Object(files)) => files,
        // An array is an object to `typeof`; no body name is an index.
        Some(Value::Array(_)) => &empty,
        _ => return Err(MergeError::Malformed(unit.to_owned())),
    };
    let remote: Vec<Entry> = remote_entries.iter().filter_map(entry_shaped).collect();

    // Local body filenames carry their id before the merge compares them.
    // An index that exists but cannot be read is left alone, and so are the
    // body files it may still name: the unit fails and is tried again.
    let local = read_index_dir_migrated(store, dir)?;
    let local_entries: Vec<Entry> = match &local {
        IndexDirRead::Corrupt => {
            return Err(MergeError::Other(format!("sync: local index of {unit} is unreadable")));
        }
        IndexDirRead::Missing => Vec::new(),
        IndexDirRead::Ok { entries, .. } => {
            entries.iter().filter(|e| e.filename().is_some()).cloned().collect()
        }
    };
    let local_names: HashSet<String> = std::fs::read_dir(dir)
        .map(|listing| listing.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    let remote_body = |name: &JsString| -> Option<String> {
        match remote_files.iter().find(|(k, _)| *k == name).map(|(_, v)| v) {
            Some(Value::String(body)) => Some(body.to_string_lossy().into_owned()),
            _ => None,
        }
    };
    // A remote body counts only when both its bundle key and the
    // id-carrying local name it would be saved under are safe path segments.
    let has_body = |side: MergeSide, entry: &Entry| -> bool {
        let (Some(id), Some(name)) = (entry.id(), entry.filename()) else { return false };
        match side {
            MergeSide::Local => safe(name) && local_names.contains(name.to_string_lossy().as_ref()),
            MergeSide::Remote => {
                safe(name) && safe(&id_body_filename(store, id, name)) && remote_body(name).is_some()
            }
        }
    };
    // Read only on an exact (clock, fields) tie, which is rare.
    let hash_of = |side: MergeSide, entry: &Entry| -> Option<String> {
        let name = entry.filename()?;
        let text = match side {
            MergeSide::Remote => remote_body(name)?,
            MergeSide::Local => {
                String::from_utf8_lossy(&std::fs::read(path_of(dir, name)?).ok()?).into_owned()
            }
        };
        Some(body_hash(&text))
    };
    let mut options = MergeOptions::new(BodyPolicy::Clock { has_body: &has_body }, env.ctx.now_ms());
    if store.groups().hash_body {
        options.body_hash = Some(&hash_of);
    }
    // The order of the key labels is per device.
    options.preserve_local_order = unit == KEY_LABEL_SYNC_UNIT;
    if store == EntryStore::RunLogs {
        options.run_log_retention_max = Some(MAX_RUN_LOGS_PER_KEYBOARD);
    }
    let result = merge_entries(store, &local_entries, &remote, &options);

    // Apply: remote bodies under their id-carrying names, then the index,
    // then the body files nothing names any more.
    let mut copied = 0;
    for copy in &result.remote_files_to_copy {
        match (path_of(dir, &copy.to), safe(&copy.from).then(|| remote_body(&copy.from)).flatten()) {
            (Some(path), Some(body)) => {
                pipette_fs::write_file_atomic(&path, body.as_bytes())?;
                copied += 1;
            }
            // `has_body` already refused these, so the merge never picks them.
            _ => log::warn!("sync: skipped an unsafe remote body filename for {unit}"),
        }
    }

    let index_written = matches!(local, IndexDirRead::Missing) || result.local_needs_write;
    if index_written {
        let mut base = match (&local, index) {
            (IndexDirRead::Ok { index, .. }, _) => index.clone(),
            (_, Some(Value::Object(remote_index))) => remote_index.clone(),
            _ => Object::new(),
        };
        base.insert("entries", Value::Array(result.entries.iter().cloned().map(Value::from).collect()));
        let text = pipette_js_json::stringify_with_gap(&Value::Object(base), "  ");
        pipette_fs::write_file_atomic(&dir.join("index.json"), text.as_bytes())?;
    }

    // Run logs evicted by the retention keep a tombstone that names their
    // file, so the sweep below would keep it: unlink them here.
    let mut removed = 0;
    for evicted in &result.evicted {
        if let Some(path) = evicted.filename().and_then(|name| path_of(dir, name))
            && std::fs::remove_file(path).is_ok()
        {
            removed += 1;
        }
    }
    // With no local index, body files already in the directory are not
    // known to be orphans (a lost index could have named them): they wait
    // for a later merge, which sweeps against an index that exists.
    if matches!(local, IndexDirRead::Ok { .. }) {
        removed += unlink_unreferenced_body_files(store, dir, &result.referenced_filenames);
    }

    if index_written || copied > 0 || removed > 0 {
        env.events.unit_applied(unit);
    }
    Ok(result.remote_needs_update)
}
