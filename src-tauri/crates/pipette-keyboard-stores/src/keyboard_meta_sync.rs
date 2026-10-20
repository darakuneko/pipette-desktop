// SPDX-License-Identifier: GPL-2.0-or-later
//! The sync of the keyboard names: the index as it is bundled, and the
//! merge of a remote index into the local one.
//!
//! The merge is last writer wins per uid on the entry's `deletedAt`, else
//! its `updatedAt`; on a tie the local entry stays. The merged index drops
//! the tombstones past their 30 days.

use pipette_entry_store::META_LOCK_KEY;
use pipette_js_json::{Object, Value};
use pipette_time::date_value_ms;

use crate::keyboard_meta::{
    MetaIndex, drop_expired_tombstones, field, meta_file_path, read_index, write_index,
};
use crate::{StoreContext, StoreError};

/// Why a remote index could not be merged.
#[derive(Debug, thiserror::Error)]
pub enum KeyboardMetaMergeError {
    /// The remote index or one of the entries is not of a shape the merge
    /// can read (where JavaScript throws a TypeError).
    #[error("malformed remote keyboard-meta index")]
    Malformed,
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// What a merge did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyboardMetaMerge {
    /// The local index was written.
    pub applied: bool,
    /// Drive needs this device's index.
    pub remote_needs_update: bool,
}

/// The index as the bundle sends it: the file's object, or the empty index
/// when the file is missing or not a keyboard-meta index. Read without the
/// lock.
pub fn read_keyboard_meta_index(ctx: &StoreContext) -> Result<Object, StoreError> {
    let MetaIndex { mut root, entries } = read_index(&meta_file_path(ctx))?;
    root.insert("entries", Value::Array(entries));
    Ok(root)
}

/// A JavaScript `Map` key by SameValueZero: an object or array is a key of
/// its own.
#[derive(Clone, Debug)]
enum UidKey {
    Undefined,
    Primitive(Value),
    Unique(usize),
}

impl UidKey {
    fn of(entry: &Value, unique: usize) -> Result<Self, KeyboardMetaMergeError> {
        let uid = field(entry, "uid").map_err(|_| KeyboardMetaMergeError::Malformed)?;
        Ok(match uid {
            None => UidKey::Undefined,
            Some(Value::Object(_) | Value::Array(_)) => UidKey::Unique(unique),
            Some(other) => UidKey::Primitive(other.clone()),
        })
    }

    fn same(&self, other: &UidKey) -> bool {
        match (self, other) {
            (UidKey::Undefined, UidKey::Undefined) => true,
            (UidKey::Unique(a), UidKey::Unique(b)) => a == b,
            (UidKey::Primitive(Value::Number(a)), UidKey::Primitive(Value::Number(b))) => {
                a == b || (a.is_nan() && b.is_nan())
            }
            (UidKey::Primitive(a), UidKey::Primitive(b)) => a == b,
            _ => false,
        }
    }
}

/// `new Date(deletedAt ?? updatedAt).getTime()`, 0 for a falsy or invalid
/// time.
fn effective_time(entry: &Value) -> f64 {
    let get = |key| entry.as_object().and_then(|o| o.get(key));
    let source = match get("deletedAt") {
        Some(Value::Null) | None => get("updatedAt"),
        some => some,
    };
    source.filter(|s| s.is_truthy()).and_then(date_value_ms).unwrap_or(0.0)
}

/// Merges `remote` (the `index` of a remote bundle) into the local entries
/// (`mergeKeyboardMetaIndex`): the merged entries and whether Drive needs
/// this device's index.
fn merge_entries(
    local: &[Value],
    remote: &Value,
    now_ms: i64,
) -> Result<(Vec<Value>, bool), KeyboardMetaMergeError> {
    let remote_entries = match remote {
        Value::Object(index) => match index.get("entries") {
            Some(Value::Array(entries)) => entries.as_slice(),
            _ => return Err(KeyboardMetaMergeError::Malformed),
        },
        _ => return Err(KeyboardMetaMergeError::Malformed),
    };
    let mut by_uid: Vec<(UidKey, Option<&Value>, Option<&Value>)> = Vec::new();
    let mut unique = 0;
    for (entry, is_local) in local.iter().map(|e| (e, true)).chain(remote_entries.iter().map(|e| (e, false)))
    {
        unique += 1;
        let key = UidKey::of(entry, unique)?;
        let at = match by_uid.iter().position(|(k, _, _)| k.same(&key)) {
            Some(at) => at,
            None => {
                by_uid.push((key, None, None));
                by_uid.len() - 1
            }
        };
        if is_local {
            by_uid[at].1 = Some(entry);
        } else {
            by_uid[at].2 = Some(entry);
        }
    }

    let mut merged = Vec::with_capacity(by_uid.len());
    let mut remote_needs_update = false;
    for (_, l, r) in by_uid {
        match (l, r) {
            (Some(l), None) => {
                merged.push(l.clone());
                remote_needs_update = true;
            }
            (None, Some(r)) => merged.push(r.clone()),
            (Some(l), Some(r)) => {
                let (lt, rt) = (effective_time(l), effective_time(r));
                if rt > lt {
                    merged.push(r.clone());
                } else {
                    remote_needs_update |= lt > rt;
                    merged.push(l.clone());
                }
            }
            (None, None) => {}
        }
    }
    let count = merged.len();
    let kept = drop_expired_tombstones(merged, now_ms)?;
    Ok((kept.clone(), remote_needs_update || kept.len() != count))
}

/// Merges a remote index into the local one under the store's lock
/// (`applyRemoteKeyboardMetaIndex`). The merged index is written, as
/// `{type, version, entries}`, only when its entries differ from the local
/// ones; a change of the tombstone GC alone counts.
pub fn apply_remote_keyboard_meta_index(
    ctx: &StoreContext,
    remote: &Value,
) -> Result<KeyboardMetaMerge, KeyboardMetaMergeError> {
    ctx.locks.with_write_lock(META_LOCK_KEY, || {
        let path = meta_file_path(ctx);
        let local = read_index(&path)?;
        let (entries, remote_needs_update) = merge_entries(&local.entries, remote, ctx.now_ms())?;
        let as_json = |entries: &[Value]| pipette_js_json::stringify(&Value::Array(entries.to_vec()));
        let applied = as_json(&entries) != as_json(&local.entries);
        if applied {
            let mut index = MetaIndex::empty();
            index.entries = entries;
            write_index(&path, index)?;
        }
        Ok(KeyboardMetaMerge { applied, remote_needs_update })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(uid: Value, updated: &str) -> Value {
        let mut o = Object::new();
        o.insert("uid", uid);
        o.insert("deviceName", "n".into());
        o.insert("updatedAt", updated.into());
        Value::Object(o)
    }

    fn remote(entries: Vec<Value>) -> Value {
        let mut o = Object::new();
        o.insert("entries", Value::Array(entries));
        Value::Object(o)
    }

    #[test]
    fn uids_match_as_javascript_map_keys() {
        let nan = Value::Number(f64::NAN);
        let local = [
            entry(nan.clone(), "2026-01-01T00:00:00.000Z"),
            entry(Value::Number(0.0), "2026-01-01T00:00:00.000Z"),
        ];
        let r = remote(vec![
            entry(nan, "2026-01-02T00:00:00.000Z"),
            entry(Value::Number(-0.0), "2025-01-01T00:00:00.000Z"),
            entry(Value::Object(Object::new()), "2026-01-01T00:00:00.000Z"),
        ]);
        let (merged, needs) = merge_entries(&local, &r, 1_767_225_600_000).unwrap();
        // NaN meets NaN (the remote one is newer), -0 meets 0 (the local one
        // is newer), and the object uid is a key of its own.
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].as_object().unwrap().get("updatedAt"), Some(&"2026-01-02T00:00:00.000Z".into()));
        assert_eq!(merged[1], local[1]);
        assert!(needs);
    }

    #[test]
    fn a_remote_index_without_entries_is_malformed() {
        assert!(matches!(merge_entries(&[], &Value::Null, 0), Err(KeyboardMetaMergeError::Malformed)));
        assert!(matches!(
            merge_entries(&[Value::Null], &remote(vec![]), 0),
            Err(KeyboardMetaMergeError::Malformed)
        ));
    }
}
