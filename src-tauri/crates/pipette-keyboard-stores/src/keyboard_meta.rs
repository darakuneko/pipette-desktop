// SPDX-License-Identifier: GPL-2.0-or-later
//! The keyboard names: `sync/meta/keyboard-names.json`, the uid → device
//! name map of src/main/sync/keyboard-meta.ts, synced as the unit
//! `meta/keyboard-names`.
//!
//! The file is `{"type":"keyboard-meta","version":1,"entries":[…]}` written
//! as `JSON.stringify(index, null, 2)`; each entry is
//! `{uid, deviceName, updatedAt, deletedAt?}`. The file is read as a
//! JavaScript object, so fields this build does not know and the key order
//! survive a write. A file that cannot be read, or is not of that shape,
//! reads as an empty index and is replaced by the next write; one nested
//! too deeply to parse here (`JSON.parse` reads it) fails every write
//! instead and is left as it is.
//!
//! Writes run one at a time under [`META_LOCK_KEY`]. A write that changes
//! the index also drops the tombstones older than 30 days; one that changes
//! nothing writes nothing, so an old tombstone stays until the next change.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use pipette_entry_store::{META_LOCK_KEY, is_safe_key, trim_js_whitespace};
use pipette_js_json::{JsString, Object, Value};
use pipette_time::{date_value_ms, iso_8601_millis};

use crate::{StoreContext, StoreError};

/// The sync unit of the keyboard names (`KEYBOARD_META_SYNC_UNIT`).
pub const KEYBOARD_META_SYNC_UNIT: &str = "meta/keyboard-names";

/// How long a tombstone is kept after its deletion.
const TOMBSTONE_TTL_MS: f64 = 30.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// What a write of a name did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MetaOutcome {
    Unchanged,
    Upserted,
}

/// The parsed file: the top-level object and its `entries`, written back
/// in their places.
pub(crate) struct MetaIndex {
    pub(crate) root: Object,
    pub(crate) entries: Vec<Value>,
}

impl MetaIndex {
    pub(crate) fn empty() -> Self {
        let mut root = Object::new();
        root.insert("type", "keyboard-meta".into());
        root.insert("version", 1.0.into());
        root.insert("entries", Value::Array(Vec::new()));
        MetaIndex { root, entries: Vec::new() }
    }
}

pub(crate) fn meta_file_path(ctx: &StoreContext) -> PathBuf {
    ctx.sync_dir().join("meta").join("keyboard-names.json")
}

/// The index in the file at `path` (`readKeyboardMetaIndex`): empty when
/// the file is missing, unreadable, not JSON, or not a keyboard-meta index
/// with an `entries` list. Fails only for a file nested too deeply to read.
pub(crate) fn read_index(path: &Path) -> Result<MetaIndex, StoreError> {
    let Ok(bytes) = std::fs::read(path) else { return Ok(MetaIndex::empty()) };
    // readFile(…, 'utf-8') reads each invalid sequence as U+FFFD.
    let parsed = match pipette_js_json::parse(&String::from_utf8_lossy(&bytes)) {
        Ok(parsed) => parsed,
        Err(err) if err.is_nesting_too_deep() => return Err(StoreError::TooDeep(path.to_owned())),
        Err(_) => return Ok(MetaIndex::empty()),
    };
    let Value::Object(root) = parsed else { return Ok(MetaIndex::empty()) };
    let entries = match (root.get("type"), root.get("entries")) {
        (Some(Value::String(kind)), Some(Value::Array(entries)))
            if kind.as_str() == Some("keyboard-meta") =>
        {
            entries.clone()
        }
        _ => return Ok(MetaIndex::empty()),
    };
    Ok(MetaIndex { root, entries })
}

pub(crate) fn write_index(path: &Path, index: MetaIndex) -> Result<(), StoreError> {
    let MetaIndex { mut root, entries } = index;
    root.insert("entries", Value::Array(entries));
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = pipette_js_json::stringify_with_gap(&Value::Object(root), "  ");
    pipette_fs::write_file_atomic(path, text.as_bytes())?;
    Ok(())
}

/// `entry[key]` of an entry; reading a property of `null` throws in
/// JavaScript, and other values that are not objects have no fields.
pub(crate) fn field<'a>(entry: &'a Value, key: &'static str) -> Result<Option<&'a Value>, StoreError> {
    match entry {
        Value::Null => Err(StoreError::NullEntry(key)),
        Value::Object(object) => Ok(object.get(key)),
        _ => Ok(None),
    }
}

fn is_truthy(value: Option<&Value>) -> bool {
    value.is_some_and(Value::is_truthy)
}

/// The position of the first entry whose `uid` is `uid`.
fn find_entry(entries: &[Value], uid: &str) -> Result<Option<usize>, StoreError> {
    for (at, entry) in entries.iter().enumerate() {
        if matches!(field(entry, "uid")?, Some(Value::String(s)) if s.as_str() == Some(uid)) {
            return Ok(Some(at));
        }
    }
    Ok(None)
}

/// The entries without the tombstones deleted 30 days or more before
/// `now_ms`. A `deletedAt` that is not a time keeps its entry.
pub(crate) fn drop_expired_tombstones(entries: Vec<Value>, now_ms: i64) -> Result<Vec<Value>, StoreError> {
    let mut kept = Vec::with_capacity(entries.len());
    for entry in entries {
        let expired = match field(&entry, "deletedAt")? {
            Some(deleted_at) if deleted_at.is_truthy() => {
                // Times are within ±8.64e15 ms, exact as f64.
                #[allow(clippy::cast_precision_loss)]
                let age = date_value_ms(deleted_at).map(|deleted| now_ms as f64 - deleted);
                age.is_some_and(|age| age >= TOMBSTONE_TTL_MS)
            }
            _ => false,
        };
        if !expired {
            kept.push(entry);
        }
    }
    Ok(kept)
}

/// The active names by uid (`getActiveKeyboardMetaMap`): entries that are
/// not deleted and have a name, the last one of a uid winning. The name is
/// the entry's value as it is, whatever its type.
pub fn active_keyboard_names(entries: &[Value]) -> Result<HashMap<String, Value>, StoreError> {
    let mut names = HashMap::new();
    for entry in entries {
        if is_truthy(field(entry, "deletedAt")?) {
            continue;
        }
        let Some(name) = field(entry, "deviceName")?.filter(|name| name.is_truthy()) else { continue };
        // A uid that is not a string is never looked up by a directory name.
        if let Some(uid) = field(entry, "uid")?.and_then(Value::as_str) {
            names.insert(uid.to_owned(), name.clone());
        }
    }
    Ok(names)
}

/// The active names of the file, for a reader; empty when the file holds
/// none, and when it is nested too deeply to read.
pub(crate) fn read_active_names(ctx: &StoreContext) -> Result<HashMap<String, Value>, StoreError> {
    match read_index(&meta_file_path(ctx)) {
        Ok(index) => active_keyboard_names(&index.entries),
        // A file too deep to parse lists no names on purpose: the keyboards
        // show their snapshot names, and the writes that would record those
        // fail on the same file, so it is never overwritten.
        Err(_) => Ok(HashMap::new()),
    }
}

/// Which entries a write of a name leaves as they are.
#[derive(Clone, Copy)]
enum Rule {
    /// An active entry with the same name.
    SameName,
    /// Any active entry.
    AnyActive,
    /// Any entry, active or deleted.
    AnyEntry,
}

/// `device_name` trimmed of JavaScript whitespace.
fn trimmed(device_name: &JsString) -> JsString {
    JsString::from_utf16(trim_js_whitespace(&device_name.utf16_units()).to_vec())
}

/// The trimmed `device_name`, `None` when it or `uid` is empty.
fn usable_name(uid: &str, device_name: &JsString) -> Option<JsString> {
    let name = trimmed(device_name);
    (!uid.is_empty() && !name.is_empty()).then_some(name)
}

/// Gives `uid` the name `name` in `entries` under `rule`: a new entry, or,
/// unless `rule` leaves the entry, a new name for it or a tombstone revived
/// with it. Answers whether the entries changed.
fn set_name(
    entries: &mut Vec<Value>,
    uid: &str,
    name: Value,
    now: &str,
    rule: Rule,
) -> Result<bool, StoreError> {
    match find_entry(entries, uid)? {
        Some(at) => {
            let Value::Object(entry) = &mut entries[at] else { unreachable!("found by its uid field") };
            let active = !is_truthy(entry.get("deletedAt"));
            let unchanged = match rule {
                Rule::SameName => active && entry.get("deviceName") == Some(&name),
                Rule::AnyActive => active,
                Rule::AnyEntry => true,
            };
            if unchanged {
                return Ok(false);
            }
            entry.insert("deviceName", name);
            entry.insert("updatedAt", now.into());
            entry.remove("deletedAt");
        }
        None => {
            let mut entry = Object::new();
            entry.insert("uid", uid.into());
            entry.insert("deviceName", name);
            entry.insert("updatedAt", now.into());
            entries.push(Value::Object(entry));
        }
    }
    Ok(true)
}

/// Rewrites the index under the store's lock: `change` edits the entries
/// at the time `now` and answers what it did; when `changed` says the
/// entries changed, the expired tombstones are dropped and the file is
/// written.
fn rewrite_index<T>(
    ctx: &StoreContext,
    change: impl FnOnce(&mut Vec<Value>, &str) -> Result<T, StoreError>,
    changed: impl FnOnce(&T) -> bool,
) -> Result<T, StoreError> {
    ctx.locks.with_write_lock(META_LOCK_KEY, || {
        let path = meta_file_path(ctx);
        let mut index = read_index(&path)?;
        let now = iso_8601_millis(ctx.now_ms());
        let outcome = change(&mut index.entries, &now)?;
        if changed(&outcome) {
            index.entries = drop_expired_tombstones(std::mem::take(&mut index.entries), ctx.now_ms())?;
            write_index(&path, index)?;
        }
        Ok(outcome)
    })
}

fn write_name(
    ctx: &StoreContext,
    uid: &str,
    device_name: &JsString,
    rule: Rule,
) -> Result<MetaOutcome, StoreError> {
    let Some(name) = usable_name(uid, device_name) else { return Ok(MetaOutcome::Unchanged) };
    let changed =
        rewrite_index(ctx, |entries, now| set_name(entries, uid, Value::String(name), now, rule), |c| *c)?;
    Ok(if changed { MetaOutcome::Upserted } else { MetaOutcome::Unchanged })
}

/// Records each `(uid, device_name)` (trimmed) for a uid the index has no
/// entry for, in one write (`batchUpsertKeyboardMeta` as the backfill uses
/// it); pairs with an empty uid or name are skipped. A uid that has gained
/// an entry by the time of the write (a name, or a tombstone of a delete
/// made while the names were being looked up) keeps it, so the backfill
/// never revives a deleted name. Answers how many entries were added;
/// nothing is written when none were.
pub fn name_unnamed_keyboards(ctx: &StoreContext, names: &[(String, JsString)]) -> Result<usize, StoreError> {
    if names.is_empty() {
        return Ok(0);
    }
    rewrite_index(
        ctx,
        |entries, now| {
            let mut count = 0;
            for (uid, device_name) in names {
                let Some(name) = usable_name(uid, device_name) else { continue };
                if set_name(entries, uid, Value::String(name), now, Rule::AnyEntry)? {
                    count += 1;
                }
            }
            Ok(count)
        },
        |count| *count > 0,
    )
}

/// What a tombstone write did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TombstoneOutcome {
    Unchanged,
    Tombstoned,
}

/// Marks `entry` deleted at `now`. Assigning a property of a primitive
/// throws in JavaScript's strict mode; an array takes the properties, but
/// `JSON.stringify` writes only its items, so it stays as it is and counts
/// again in the next delete of every name.
fn mark_entry_deleted(entry: &mut Value, now: &str) -> Result<(), StoreError> {
    match entry {
        Value::Object(entry) => {
            entry.insert("updatedAt", now.into());
            entry.insert("deletedAt", now.into());
            Ok(())
        }
        Value::Array(_) => Ok(()),
        other => Err(StoreError::PrimitiveEntry("updatedAt", pipette_js_json::stringify(other))),
    }
}

/// Deletes the name of `uid` (`tombstoneKeyboardMeta`): an active entry
/// becomes a tombstone, and a uid with no entry gets one, so the other
/// devices learn of the delete. Unchanged for an empty uid or an entry
/// already deleted.
pub fn tombstone_keyboard_meta(ctx: &StoreContext, uid: &str) -> Result<TombstoneOutcome, StoreError> {
    if uid.is_empty() {
        return Ok(TombstoneOutcome::Unchanged);
    }
    rewrite_index(
        ctx,
        |entries, now| {
            match find_entry(entries, uid)? {
                None => {
                    let mut entry = Object::new();
                    entry.insert("uid", uid.into());
                    entry.insert("deviceName", "".into());
                    entry.insert("updatedAt", now.into());
                    entry.insert("deletedAt", now.into());
                    entries.push(Value::Object(entry));
                }
                Some(at) if is_truthy(field(&entries[at], "deletedAt")?) => {
                    return Ok(TombstoneOutcome::Unchanged);
                }
                Some(at) => mark_entry_deleted(&mut entries[at], now)?,
            }
            Ok(TombstoneOutcome::Tombstoned)
        },
        |outcome| *outcome == TombstoneOutcome::Tombstoned,
    )
}

/// Deletes every active name (`tombstoneAllKeyboardMeta`) and answers how
/// many there were; nothing is written when there were none.
pub fn tombstone_all_keyboard_meta(ctx: &StoreContext) -> Result<usize, StoreError> {
    rewrite_index(
        ctx,
        |entries, now| {
            let mut count = 0;
            for entry in entries.iter_mut() {
                if is_truthy(field(entry, "deletedAt")?) {
                    continue;
                }
                mark_entry_deleted(entry, now)?;
                count += 1;
            }
            Ok(count)
        },
        |count| *count > 0,
    )
}

/// Records `device_name` (trimmed) for `uid` (`upsertKeyboardMeta`): a new
/// entry, a new name for an active entry, or a tombstone revived with it.
/// Unchanged for an empty uid or name, or an active entry of that name.
pub fn upsert_keyboard_meta(
    ctx: &StoreContext,
    uid: &str,
    device_name: &JsString,
) -> Result<MetaOutcome, StoreError> {
    write_name(ctx, uid, device_name, Rule::SameName)
}

/// Names a keyboard from its firmware name when it connects
/// (`nameKeyboardOnConnect`): a uid with no entry gets one, a tombstone is
/// revived with the name, and an active entry is left as it is, so a name
/// the user gave it is never replaced.
pub fn name_keyboard_on_connect(
    ctx: &StoreContext,
    uid: &str,
    device_name: &JsString,
) -> Result<MetaOutcome, StoreError> {
    write_name(ctx, uid, device_name, Rule::AnyActive)
}

/// The `KEYBOARD_META_NAME_IF_MISSING` handler: `uid` and `name` are the
/// renderer's arguments when they are strings. Does nothing unless the uid
/// is a safe key; reports the unit when the names changed.
pub fn keyboard_meta_name_if_missing(
    ctx: &StoreContext,
    uid: Option<&str>,
    name: Option<&str>,
) -> Result<(), StoreError> {
    let (Some(uid), Some(name)) = (uid, name) else { return Ok(()) };
    if !is_safe_key(uid) {
        return Ok(());
    }
    if name_keyboard_on_connect(ctx, uid, &JsString::from(name))? == MetaOutcome::Upserted {
        ctx.notify(KEYBOARD_META_SYNC_UNIT);
    }
    Ok(())
}

/// The device name at the start of a snapshot filename
/// (`extractDeviceNameFromFilename`, `/^(.+?)_\d{4}-\d{2}-/`): the shortest
/// non-empty prefix, with no line terminator, followed by `_YYYY-MM-`.
pub fn extract_device_name_from_filename(filename: &JsString) -> Option<JsString> {
    let units = filename.utf16_units();
    for end in 1..units.len() {
        if is_line_terminator(units[end - 1]) {
            return None;
        }
        if starts_with_date_part(&units[end..]) {
            return Some(JsString::from_utf16(units[..end].to_vec()));
        }
    }
    None
}

/// `.` of a JavaScript regular expression matches anything but these.
fn is_line_terminator(unit: u16) -> bool {
    matches!(unit, 0x0a | 0x0d | 0x2028 | 0x2029)
}

/// Whether `units` start with `_\d{4}-\d{2}-`.
fn starts_with_date_part(units: &[u16]) -> bool {
    const PATTERN: &[u8; 9] = b"_dddd-dd-";
    units.len() >= PATTERN.len()
        && PATTERN.iter().zip(units).all(|(&want, &unit)| match want {
            b'd' => (u16::from(b'0')..=u16::from(b'9')).contains(&unit),
            literal => unit == u16::from(literal),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(filename: &str) -> Option<String> {
        extract_device_name_from_filename(&filename.into()).map(|n| n.to_string_lossy().into_owned())
    }

    #[test]
    fn reads_the_device_name_of_a_snapshot_filename() {
        assert_eq!(name("GPK60-63R_2026-04-16T10-00-00.000Z.pipette").as_deref(), Some("GPK60-63R"));
        assert_eq!(
            name("Jeneko Box 42R_2026-03-15T14-35-29.037Z.pipette").as_deref(),
            Some("Jeneko Box 42R")
        );
        assert_eq!(
            name("Jeneko Box 42R_2026-03-15T14-35-29.037Z_0b9f6f1e-3c1a-4e0e-9d7a-2f1d5f6b8a90.pipette")
                .as_deref(),
            Some("Jeneko Box 42R")
        );
        // The shortest prefix wins.
        assert_eq!(name("a_2026-01-b_2026-01-c").as_deref(), Some("a"));
        assert_eq!(name("not-a-snapshot.json"), None);
        assert_eq!(name(""), None);
        assert_eq!(name("_2026-01-01"), None);
        assert_eq!(name("a_２０２６-01-"), None);
        assert_eq!(name("a\nb_2026-01-"), None);
        assert_eq!(name("a\u{85}b_2026-01-").as_deref(), Some("a\u{85}b"));
    }

    #[test]
    fn keeps_a_lone_surrogate_of_the_name() {
        let mut units: Vec<u16> = vec![0xd800];
        units.extend("_2026-01-01".encode_utf16());
        let got = extract_device_name_from_filename(&JsString::from_utf16(units));
        assert_eq!(got, Some(JsString::from_utf16(vec![0xd800])));
    }
}
