// SPDX-License-Identifier: GPL-2.0-or-later
//! Reading and writing the deleted-ranges file of one (keyboard uid,
//! machine hash), and the local record of the range ids this device has
//! applied to its own day files.
//!
//! Every read-modify-write of a deleted-ranges file and every read for a
//! sync bundle holds the write lock keyed by the file's sync unit name
//! ([`typing_deleted_ranges_sync_unit`]), the key the sync layer takes for
//! that unit too. The lock is not reentrant, so nothing here may be called
//! by a task that already holds it.

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};

use pipette_entry_store::WriteLocks;
use pipette_js_json::{JsString, Value};

use super::model::{
    DeletedRangeEntry, DeletedRangesUnion, parse_deleted_ranges_file, serialize_deleted_ranges,
};
use crate::jsonl::paths::deleted_ranges_path;
use crate::sync_units::typing_deleted_ranges_sync_unit;

#[derive(Debug, thiserror::Error)]
pub enum DeletedRangesError {
    #[error(transparent)]
    Io(#[from] io::Error),
    /// The file is not JSON or not a deleted-ranges file.
    #[error("deleted-ranges: unreadable file {}", .0.display())]
    Unreadable(PathBuf),
}

/// The file's text read with U+FFFD for an invalid UTF-8 sequence, a byte
/// order mark kept (so it fails to parse).
fn parse_raw(bytes: &[u8], path: &Path) -> Result<Vec<DeletedRangeEntry>, DeletedRangesError> {
    pipette_js_json::parse(&String::from_utf8_lossy(bytes))
        .ok()
        .and_then(|value| parse_deleted_ranges_file(&value))
        .ok_or_else(|| DeletedRangesError::Unreadable(path.to_path_buf()))
}

fn read_entries(path: &Path) -> Result<Vec<DeletedRangeEntry>, DeletedRangesError> {
    match std::fs::read(path) {
        Ok(bytes) => parse_raw(&bytes, path),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(err.into()),
    }
}

/// The valid entries, none for a missing file; an
/// error when the file exists but cannot be read or parsed.
pub fn read_deleted_ranges(
    user_data: &Path,
    uid: &str,
    machine_hash: &str,
) -> Result<Vec<DeletedRangeEntry>, DeletedRangesError> {
    read_entries(&deleted_ranges_path(user_data, uid, machine_hash))
}

/// For a cache replay, which reads the ranges and
/// uses them in one step. A file that cannot be read or parsed counts as
/// no entries, logged, so one bad file does not stop the replay.
pub fn read_deleted_ranges_lenient(
    user_data: &Path,
    uid: &str,
    machine_hash: &str,
) -> Vec<DeletedRangeEntry> {
    let path = deleted_ranges_path(user_data, uid, machine_hash);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) => {
            if err.kind() != io::ErrorKind::NotFound {
                log::warn!("deleted-ranges: cannot read {}: {err}", path.display());
            }
            return Vec::new();
        }
    };
    parse_raw(&bytes, &path).unwrap_or_else(|err| {
        log::warn!("Error: {err}");
        Vec::new()
    })
}

/// Under the file's lock, reads the local entries,
/// passes them to `combine` and writes its result when `local_changed`,
/// creating the directories. A local file that cannot be read fails before
/// `combine` runs and is left as it is.
pub fn update_deleted_ranges(
    locks: &WriteLocks,
    user_data: &Path,
    uid: &str,
    machine_hash: &str,
    combine: impl FnOnce(Vec<DeletedRangeEntry>) -> DeletedRangesUnion,
) -> Result<DeletedRangesUnion, DeletedRangesError> {
    let path = deleted_ranges_path(user_data, uid, machine_hash);
    locks.with_write_lock(&typing_deleted_ranges_sync_unit(uid, machine_hash), || {
        let result = combine(read_entries(&path)?);
        if result.local_changed {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            pipette_fs::write_file_atomic(&path, serialize_deleted_ranges(&result.entries).as_bytes())?;
        }
        Ok(result)
    })
}

/// Under the file's lock, the file text to upload,
/// rebuilt from its valid entries; `None` when the file is missing or
/// cannot be read (logged unless missing).
pub fn bundle_deleted_ranges(
    locks: &WriteLocks,
    user_data: &Path,
    uid: &str,
    machine_hash: &str,
) -> Option<String> {
    let path = deleted_ranges_path(user_data, uid, machine_hash);
    locks.with_write_lock(&typing_deleted_ranges_sync_unit(uid, machine_hash), || {
        let bundled = std::fs::read(&path)
            .map_err(DeletedRangesError::from)
            .and_then(|bytes| parse_raw(&bytes, &path))
            .map(|entries| serialize_deleted_ranges(&entries));
        match bundled {
            Ok(text) => Some(text),
            Err(DeletedRangesError::Io(err)) if err.kind() == io::ErrorKind::NotFound => None,
            Err(err) => {
                log::warn!("deleted-ranges: not bundled: Error: {err}");
                None
            }
        }
    })
}

/// The applied record's ids (`deleted-ranges-applied.json`, a JSON array
/// of ids): the strings of the array. A record that is missing, cannot be
/// read or is not an array counts as empty; applying a range again only
/// marks rows that are still live.
pub fn read_applied_ids(path: &Path) -> HashSet<JsString> {
    let Ok(bytes) = std::fs::read(path) else { return HashSet::new() };
    match pipette_js_json::parse(&String::from_utf8_lossy(&bytes)) {
        Ok(Value::Array(items)) => items
            .into_iter()
            .filter_map(|item| match item {
                Value::String(id) => Some(id),
                _ => None,
            })
            .collect(),
        _ => HashSet::new(),
    }
}

/// Writes the applied record: the ids sorted as JavaScript's `sort` sorts
/// strings (UTF-16 code units), unindented. The directory is not created,
/// so a reset that removed the device directory leaves it removed.
pub fn write_applied_ids(path: &Path, ids: &HashSet<JsString>) -> io::Result<()> {
    let mut sorted: Vec<&JsString> = ids.iter().collect();
    sorted.sort_by_cached_key(|id| id.utf16_units());
    let array = Value::Array(sorted.into_iter().map(|id| Value::String(id.clone())).collect());
    pipette_fs::write_file_atomic(path, pipette_js_json::stringify(&array).as_bytes())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::mpsc;
    use std::time::Duration;

    use pipette_typing_analytics_db::DeleteRange;

    use super::*;
    use crate::deleted_ranges::model::union_deleted_ranges;

    const UID: &str = "kb";
    const HASH: &str = "hash-r";

    fn entry(id: &str) -> DeletedRangeEntry {
        DeletedRangeEntry { id: id.into(), range: DeleteRange { start_ms: 0, end_ms: 50, cutoff_ms: 100 } }
    }

    fn write_raw(user_data: &Path, content: &str) {
        let path = deleted_ranges_path(user_data, UID, HASH);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn reads_no_entries_for_a_missing_file_and_fails_on_a_broken_one() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_deleted_ranges(dir.path(), UID, HASH).unwrap().is_empty());
        write_raw(dir.path(), "{not json");
        assert!(matches!(read_deleted_ranges(dir.path(), UID, HASH), Err(DeletedRangesError::Unreadable(_))));
        assert!(read_deleted_ranges_lenient(dir.path(), UID, HASH).is_empty());
    }

    #[test]
    fn an_update_without_a_change_creates_nothing_and_a_broken_file_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let locks = WriteLocks::new();
        let result =
            update_deleted_ranges(&locks, dir.path(), UID, HASH, |local| union_deleted_ranges(&local, &[]));
        assert!(!result.unwrap().local_changed);
        assert!(!dir.path().join("sync").exists());

        write_raw(dir.path(), "{not json");
        let failed = update_deleted_ranges(&locks, dir.path(), UID, HASH, |local| {
            union_deleted_ranges(&local, &[entry("a")])
        });
        assert!(failed.is_err());
        let path = deleted_ranges_path(dir.path(), UID, HASH);
        assert_eq!(std::fs::read_to_string(path).unwrap(), "{not json");
    }

    #[test]
    fn concurrent_updates_keep_every_entry() {
        let dir = tempfile::tempdir().unwrap();
        let locks = Arc::new(WriteLocks::new());
        std::thread::scope(|scope| {
            for id in ["a", "b", "c"] {
                let locks = locks.clone();
                let user_data = dir.path();
                scope.spawn(move || {
                    update_deleted_ranges(&locks, user_data, UID, HASH, |local| {
                        union_deleted_ranges(&local, &[entry(id)])
                    })
                    .unwrap();
                });
            }
        });
        let ids: Vec<String> = read_deleted_ranges(dir.path(), UID, HASH)
            .unwrap()
            .iter()
            .map(|e| e.id.to_string_lossy().into_owned())
            .collect();
        assert_eq!(ids, ["a", "b", "c"]);
    }

    #[test]
    fn updates_wait_for_the_lock_of_the_unit() {
        let dir = tempfile::tempdir().unwrap();
        let locks = Arc::new(WriteLocks::new());
        let (held_tx, held_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::scope(|scope| {
            let holder = locks.clone();
            scope.spawn(move || {
                holder.with_write_lock(&typing_deleted_ranges_sync_unit(UID, HASH), || {
                    held_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                });
            });
            held_rx.recv().unwrap();
            let updater = locks.clone();
            let user_data = dir.path();
            scope.spawn(move || {
                update_deleted_ranges(&updater, user_data, UID, HASH, |local| {
                    union_deleted_ranges(&local, &[entry("a")])
                })
                .unwrap();
                done_tx.send(()).unwrap();
            });
            assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());
            release_tx.send(()).unwrap();
            done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        });
    }
}
