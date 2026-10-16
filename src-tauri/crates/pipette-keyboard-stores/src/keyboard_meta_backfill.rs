// SPDX-License-Identifier: GPL-2.0-or-later
//! The local parts of the keyboard-name backfill of
//! src/main/sync/keyboard-meta.ts (`backfillKeyboardMeta`), which names the
//! keyboards Drive has snapshots of and the names index lacks: the uids of
//! Drive's snapshot files, the uids the index already has, and the device
//! name a snapshot index gives a keyboard. The Drive side is the sync
//! engine's (crates/pipette-sync).

use pipette_entry_store::is_safe_path_segment;
use pipette_js_json::{JsString, Value};

use crate::keyboard_meta::{extract_device_name_from_filename, field, meta_file_path, read_index};
use crate::{StoreContext, StoreError};

const SNAPSHOT_FILE_PREFIX: &str = "keyboards_";
const SNAPSHOT_FILE_SUFFIX: &str = "_snapshots.enc";

/// The keyboard uids of the snapshot files among Drive file `names`
/// (`extractKeyboardUidsFromDriveFiles`, `/^keyboards_(.+?)_snapshots\.enc$/`),
/// each once, in the order first named. A uid has no line terminator.
pub fn keyboard_uids_of_drive_names<'a>(names: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut uids: Vec<String> = Vec::new();
    for name in names {
        let Some(uid) =
            name.strip_prefix(SNAPSHOT_FILE_PREFIX).and_then(|n| n.strip_suffix(SNAPSHOT_FILE_SUFFIX))
        else {
            continue;
        };
        if uid.is_empty() || uid.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
            continue;
        }
        if !uids.iter().any(|known| known == uid) {
            uids.push(uid.to_owned());
        }
    }
    uids
}

/// The `uid` of every entry of the names index, tombstones included: a
/// tombstone keeps its uid out of the backfill until a save names it
/// again. A uid that is not a string never matches a Drive file.
pub fn keyboard_meta_uids(ctx: &StoreContext) -> Result<Vec<String>, StoreError> {
    let index = read_index(&meta_file_path(ctx))?;
    let mut uids = Vec::with_capacity(index.entries.len());
    for entry in &index.entries {
        if let Some(Value::String(uid)) = field(entry, "uid")? {
            uids.push(uid.to_string_lossy().into_owned());
        }
    }
    Ok(uids)
}

/// The device name of the first entry of a snapshot `index` that is not
/// deleted, read from its filename
/// (`index?.entries?.find((e) => !e.deletedAt)` and
/// `extractDeviceNameFromFilename`); `None` where that reading throws in
/// JavaScript (a `null` entry before it, a filename that is not a string)
/// or finds nothing.
pub fn snapshot_index_device_name(index: Option<&Value>) -> Option<JsString> {
    let Some(Value::Object(index)) = index else { return None };
    let Some(Value::Array(entries)) = index.get("entries") else { return None };
    for entry in entries {
        match entry {
            Value::Object(entry) if entry.get("deletedAt").is_some_and(Value::is_truthy) => continue,
            Value::Object(entry) => {
                let Some(Value::String(filename)) = entry.get("filename") else { return None };
                return extract_device_name_from_filename(filename);
            }
            // `null` throws; any other value has no filename.
            _ => return None,
        }
    }
    None
}

/// The device name the local snapshots of `uid` give it
/// (`resolveDeviceNameFromLocalSnapshots`); `None` when the index is
/// missing, unreadable or names none. A uid that is not one safe path
/// segment has no local snapshots.
pub fn resolve_device_name_from_local_snapshots(ctx: &StoreContext, uid: &str) -> Option<JsString> {
    if !is_safe_path_segment(uid) {
        return None;
    }
    let path = ctx.sync_dir().join("keyboards").join(uid).join("snapshots").join("index.json");
    let bytes = std::fs::read(path).ok()?;
    let index = pipette_js_json::parse(&String::from_utf8_lossy(&bytes)).ok()?;
    if index == Value::Null {
        return None;
    }
    snapshot_index_device_name(Some(&index))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_uids_of_the_snapshot_files_once_each() {
        let names = [
            "keyboards_0xAA_snapshots.enc",
            "keyboards_0xAA_snapshots.enc",
            "keyboards_0xAA_settings.enc",
            "keyboards_0xBB_snapshots.enc.trash.1.2.id",
            "keyboards__snapshots.enc",
            "keyboards_a_b_snapshots.enc",
            "keyboards_x\ny_snapshots.enc",
            "favorites_macro.enc",
        ];
        assert_eq!(keyboard_uids_of_drive_names(names), ["0xAA", "a_b"]);
    }

    fn index(text: &str) -> Value {
        pipette_js_json::parse(text).unwrap()
    }

    fn name(text: &str) -> Option<String> {
        snapshot_index_device_name(Some(&index(text))).map(|n| n.to_string_lossy().into_owned())
    }

    #[test]
    fn names_a_keyboard_after_its_first_live_snapshot() {
        let live = r#"{"entries":[{"filename":"Old_2026-01-01.pipette","deletedAt":"x"},{"filename":"KB_2026-02-01.pipette"}]}"#;
        assert_eq!(name(live).as_deref(), Some("KB"));
        assert_eq!(name(r#"{"entries":[null,{"filename":"KB_2026-02-01.pipette"}]}"#), None);
        assert_eq!(name(r#"{"entries":[5,{"filename":"KB_2026-02-01.pipette"}]}"#), None);
        assert_eq!(name(r#"{"entries":[{"filename":3}]}"#), None);
        assert_eq!(name(r#"{"entries":[{"deletedAt":"x","filename":"KB_2026-02-01.pipette"}]}"#), None);
        assert_eq!(name(r#"{"entries":{}}"#), None);
        assert_eq!(name("[]"), None);
        assert_eq!(snapshot_index_device_name(None), None);
    }
}
