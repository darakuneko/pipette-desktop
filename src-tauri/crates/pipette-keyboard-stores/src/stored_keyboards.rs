// SPDX-License-Identifier: GPL-2.0-or-later
//! The stored keyboards: the directories under `sync/keyboards`, each with
//! a display name (the `LIST_STORED_KEYBOARDS` handler of
//! src/main/sync/sync-ipc.ts).

use std::path::Path;

use pipette_entry_store::is_safe_key;
use pipette_js_json::{JsString, Object, Value};

use crate::keyboard_meta::{
    KEYBOARD_META_SYNC_UNIT, MetaOutcome, extract_device_name_from_filename, read_active_names,
    upsert_keyboard_meta,
};
use crate::{StoreContext, StoreError};

/// A stored keyboard (`StoredKeyboardInfo`). `name` is what the keyboard
/// names hold for it, which is a string unless the file was edited by
/// hand.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredKeyboard {
    pub uid: String,
    pub name: Value,
}

/// Every keyboard directory with a safe uid, in byte order of the names,
/// the order Node's `readdir` (libuv's scandir) gives on Linux and macOS.
/// A keyboard's name is its active name in the keyboard names; failing
/// that, the device name of its first live snapshot, which is recorded in
/// the keyboard names too; failing that, its uid. The keyboard names unit
/// is reported once, after the list, when any name was recorded.
///
/// Fails only when the keyboard names file has a `null` entry, as the
/// handler throws then.
pub fn list_stored_keyboards(ctx: &StoreContext) -> Result<Vec<StoredKeyboard>, StoreError> {
    let names = read_active_names(ctx)?;
    let keyboards_dir = ctx.sync_dir().join("keyboards");
    let mut recorded = false;
    let mut list = Vec::new();
    for uid in keyboard_uids(&keyboards_dir) {
        let uid_value = Value::from(uid.as_str());
        let mut name = names.get(&uid).cloned().unwrap_or_else(|| uid_value.clone());
        if name == uid_value
            && let Some(device_name) = snapshot_device_name(&keyboards_dir.join(&uid))
        {
            // A failed write still shows the name, as there.
            if let Ok(MetaOutcome::Upserted) = upsert_keyboard_meta(ctx, &uid, &device_name) {
                recorded = true;
            }
            name = Value::String(device_name);
        }
        list.push(StoredKeyboard { uid, name });
    }
    if recorded {
        ctx.notify(KEYBOARD_META_SYNC_UNIT);
    }
    Ok(list)
}

/// The list as the JSON text of the handler's response.
pub fn stored_keyboards_json(list: &[StoredKeyboard]) -> String {
    let items = list
        .iter()
        .map(|keyboard| {
            let mut item = Object::new();
            item.insert("uid", keyboard.uid.as_str().into());
            item.insert("name", keyboard.name.clone());
            Value::Object(item)
        })
        .collect();
    pipette_js_json::stringify(&Value::Array(items))
}

/// The names of the directories (not symlinks) in `dir` that are safe keys,
/// sorted by their bytes; none when `dir` cannot be read.
fn keyboard_uids(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut uids: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|uid| is_safe_key(uid))
        .collect();
    uids.sort_unstable();
    uids
}

/// The device name in the filename of the first entry of
/// `snapshots/index.json` that is not deleted; `None` wherever the handler
/// reads none or throws.
fn snapshot_device_name(keyboard_dir: &Path) -> Option<JsString> {
    let bytes = std::fs::read(keyboard_dir.join("snapshots").join("index.json")).ok()?;
    let index = pipette_js_json::parse(&String::from_utf8_lossy(&bytes)).ok()?;
    let Some(Value::Array(entries)) = index.as_object()?.get("entries") else { return None };
    // `entries.find((e) => !e.deletedAt)`: a value that is not an object has
    // no `deletedAt`, and `null` throws.
    let active = entries.iter().find_map(|entry| match entry {
        Value::Null => Some(None),
        Value::Object(object) if object.get("deletedAt").is_some_and(Value::is_truthy) => None,
        other => Some(Some(other)),
    })??;
    match active.as_object()?.get("filename")? {
        Value::String(filename) => extract_device_name_from_filename(filename),
        _ => None,
    }
}
