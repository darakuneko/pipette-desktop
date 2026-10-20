// SPDX-License-Identifier: GPL-2.0-or-later
//! The bundle of a sync unit: the object whose `JSON.stringify` text is
//! encrypted and uploaded, `{type, key, index, files}` (and `body` for a pack
//! body). The text is [`bundle_plaintext`].

mod collect;

use std::io;
use std::path::PathBuf;

use pipette_entry_store::{
    EntryStore, IndexDirRead, gc_tombstones, is_safe_path_segment, read_index_dir_migrated,
};
use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::{
    KEY_LABEL_SYNC_UNIT, StoreContext, TYPING_TEXT_SYNC_UNIT, read_keyboard_meta_index,
};
use pipette_typing_analytics::deleted_ranges::bundle_deleted_ranges;
use pipette_typing_analytics::jsonl::{DELETED_RANGES_FILENAME, device_day_jsonl_path};

pub use collect::{collect_all_sync_units, collect_analytics_sync_units_for_uid};

use crate::units::{
    entry_store_for_sync_unit, is_keyboard_meta_unit, pack_index_store, parse_deleted_ranges_unit,
    parse_device_day_unit, parse_pack_body_unit, store_lock_key,
};

/// Why a unit could not be bundled.
#[derive(Debug, thiserror::Error)]
pub enum BundleError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error("{0}")]
    Store(String),
}

/// The text a bundle is uploaded as (`JSON.stringify(bundle)`).
pub fn bundle_plaintext(bundle: &Object) -> String {
    pipette_js_json::stringify(&Value::Object(bundle.clone()))
}

/// The text of a file as `readFile(…, 'utf-8')` reads it; `None` when it
/// cannot be read.
fn read_text(path: &std::path::Path) -> Option<String> {
    std::fs::read(path).ok().map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

fn object<const N: usize>(pairs: [(&str, Value); N]) -> Object {
    pairs.into_iter().collect()
}

/// `{uid, entries: []}`, the index of the single-file bundles.
fn uid_index(uid: &str) -> Value {
    Value::Object(object([("uid", uid.into()), ("entries", Value::Array(Vec::new()))]))
}

fn bundle(kind: &str, key: &str, index: Value, files: Object) -> Object {
    object([("type", kind.into()), ("key", key.into()), ("index", index), ("files", Value::Object(files))])
}

/// `{userData}/sync/{parts…}`, or `None` when a part is not one safe path
/// segment.
fn unit_dir(ctx: &StoreContext, parts: &[&str]) -> Option<PathBuf> {
    parts
        .iter()
        .all(|p| is_safe_path_segment(p))
        .then(|| parts.iter().fold(ctx.sync_dir(), |dir, p| dir.join(p)))
}

/// The bundle of `unit`, read from the local files; `None` when the unit
/// has nothing to send (no file, an unknown shape, a body that never
/// syncs). Each store's files are read under the lock its writes take.
pub fn bundle_sync_unit(ctx: &StoreContext, unit: &str) -> Result<Option<Object>, BundleError> {
    if is_keyboard_meta_unit(unit) {
        let index = read_keyboard_meta_index(ctx).map_err(|e| BundleError::Store(e.to_string()))?;
        return Ok(Some(bundle("keyboard-meta", "keyboard-names", Value::Object(index), Object::new())));
    }
    let parts: Vec<&str> = unit.split('/').collect();
    if let Some(store) = pack_index_store(unit) {
        return store.bundle_pack_index(ctx).map_err(|e| BundleError::Store(e.to_string()));
    }
    if parts.len() == 3
        && let Some((store, id)) = parse_pack_body_unit(unit)
    {
        return store.bundle_pack_body(ctx, id).map_err(|e| BundleError::Store(e.to_string()));
    }
    if let Some(day) = parse_device_day_unit(unit) {
        if ![day.uid, day.machine_hash].iter().all(|p| is_safe_path_segment(p)) {
            return Ok(None);
        }
        let path = device_day_jsonl_path(ctx.user_data(), day.uid, day.machine_hash, day.utc_day);
        let Some(content) = read_text(&path) else { return Ok(None) };
        let key = format!("{}|{}|{}", day.uid, day.machine_hash, day.utc_day);
        let files = object([("data.jsonl", content.into())]);
        return Ok(Some(bundle("typing-analytics-device", &key, uid_index(day.uid), files)));
    }
    if let Some(ranges) = parse_deleted_ranges_unit(unit) {
        if !is_safe_path_segment(ranges.uid) || !is_safe_path_segment(ranges.machine_hash) {
            return Ok(None);
        }
        let locks = ctx.shared_locks();
        let Some(content) = bundle_deleted_ranges(&locks, ctx.user_data(), ranges.uid, ranges.machine_hash)
        else {
            return Ok(None);
        };
        let key = format!("{}|{}", ranges.uid, ranges.machine_hash);
        let files = object([(DELETED_RANGES_FILENAME, content.into())]);
        return Ok(Some(bundle("typing-deleted-ranges", &key, uid_index(ranges.uid), files)));
    }
    if let ["keyboards", uid, "settings"] = parts.as_slice() {
        let Some(dir) = unit_dir(ctx, &["keyboards", uid]) else { return Ok(None) };
        let Some(content) = read_text(&dir.join("pipette_settings.json")) else { return Ok(None) };
        let files = object([("pipette_settings.json", content.into())]);
        return Ok(Some(bundle("settings", uid, uid_index(uid), files)));
    }

    let Some(store) = entry_store_for_sync_unit(unit) else { return Ok(None) };
    let Some(dir) = unit_dir(ctx, &parts) else { return Ok(None) };
    // Under the store's lock, so an entry's clocks and its body bytes come
    // from the same save.
    let read = ctx.locks().with_write_lock(&store_lock_key(unit), || read_index_bodies(ctx, store, &dir))?;
    let Some((index, files)) = read else { return Ok(None) };
    let (kind, key) = match (unit, parts.as_slice()) {
        (KEY_LABEL_SYNC_UNIT, _) => ("key-label", KEY_LABEL_SYNC_UNIT),
        (TYPING_TEXT_SYNC_UNIT, _) => ("typing-test-text", TYPING_TEXT_SYNC_UNIT),
        (_, ["favorites", ty]) => ("favorite", *ty),
        (_, [_, uid, "analyze_filters"]) => ("analyze-filter", *uid),
        (_, [_, uid, "runs"]) => ("run-log", *uid),
        (_, [_, uid, _]) => ("layout", *uid),
        _ => return Ok(None),
    };
    Ok(Some(bundle(kind, key, Value::Object(index), files)))
}

/// The index and body files of an index-based store, for a caller holding
/// its lock. Entries go out as v2 entries with expired tombstones dropped.
/// A live entry whose body file is missing is left out: no device may take
/// a body group from an entry that has no body. Tombstones carry no body.
/// `None` when the index is missing or unreadable.
fn read_index_bodies(
    ctx: &StoreContext,
    store: EntryStore,
    dir: &std::path::Path,
) -> io::Result<Option<(Object, Object)>> {
    let IndexDirRead::Ok { mut index, entries } = read_index_dir_migrated(store, dir)? else {
        return Ok(None);
    };
    let mut files = Object::new();
    let mut kept = Vec::new();
    for entry in gc_tombstones(&entries, ctx.now_ms()) {
        if !entry.is_deleted() {
            let Some(name) = entry.filename().and_then(|f| f.as_str()).filter(|f| is_safe_path_segment(f))
            else {
                continue;
            };
            let Some(content) = read_text(&dir.join(name)) else { continue };
            files.insert(name, content.into());
        }
        kept.push(Value::from(entry));
    }
    index.insert("entries", Value::Array(kept));
    files.insert(
        "index.json",
        pipette_js_json::stringify_with_gap(&Value::Object(index.clone()), "  ").into(),
    );
    Ok(Some((index, files)))
}
