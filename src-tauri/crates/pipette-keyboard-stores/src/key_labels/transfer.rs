// SPDX-License-Identifier: GPL-2.0-or-later
//! The import of key label files and the export of one label, once
//! the dialog has answered.

use std::path::{Path, PathBuf};

use pipette_entry_store::safe_filename;
use pipette_js_json::{JsString, Object, Value};

use super::label_file::{method_type_error, normalize_file};
use super::{INDEX, KeyLabelError, KeyLabelSave, get_key_label, save_key_label, store_dir};
use crate::StoreContext;
use crate::entry_index::{find_active_by_name, read_index, read_json};

/// Imports one file: a label with the name of a live one (ignoring case)
/// is saved over it, keeping its id, author and Hub link.
fn import_file(ctx: &StoreContext, path: &Path) -> Result<Value, KeyLabelError> {
    let file = normalize_file(&read_json(path)?)
        .ok_or_else(|| KeyLabelError::invalid_file("Invalid key label file"))?;
    let Some(Value::String(name)) = file.get("name").cloned() else {
        return Err(KeyLabelError::invalid_file("Invalid key label file"));
    };

    let index = read_index(&INDEX, &store_dir(ctx))?;
    let existing = find_active_by_name(&index.entries, &Value::String(name.clone()), None)?;
    let carried =
        |key: &str| existing.and_then(|entry| entry.get(key)).filter(|value| value.is_truthy()).cloned();
    let save = KeyLabelSave {
        id: existing.and_then(|entry| entry.id()).cloned(),
        name,
        uploader_name: carried("uploaderName"),
        map: file.get("map").cloned().unwrap_or(Value::Null),
        composite_labels: file.get("compositeLabels").cloned(),
        keymap_applicable: file.get("keymapApplicable") == Some(&Value::Bool(true)),
        hub_post_id: carried("hubPostId"),
        hub_updated_at: carried("hubUpdatedAt"),
        keep_current_name: false,
    };
    Ok(save_key_label(ctx, &save)?.into())
}

/// `path`'s last component as Node's `path.basename` gives it.
fn file_name_of(path: &Path) -> JsString {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default().into()
}

/// Imports the files the user picked (the `data` of the `key_label_store_import` command
/// once its dialog answered): `{imported: [{fileName, meta}], rejections:
/// [{fileName, errorCode, error}]}`. Each file stands alone, in the order
/// given; one that cannot be read or saved is a rejection and the others
/// still import. A second file with the name of an earlier one in the same
/// batch is saved over it.
pub fn import_key_label_files(ctx: &StoreContext, paths: &[PathBuf]) -> Object {
    let mut imported = Vec::new();
    let mut rejections = Vec::new();
    for path in paths {
        let file_name = Value::String(file_name_of(path));
        match import_file(ctx, path) {
            Ok(meta) => {
                imported.push(Value::Object([("fileName", file_name), ("meta", meta)].into_iter().collect()))
            }
            Err(err) => rejections.push(Value::Object(
                [
                    ("fileName", file_name),
                    ("errorCode", err.code().into()),
                    ("error", err.to_string().into()),
                ]
                .into_iter()
                .collect(),
            )),
        }
    }
    [("imported", Value::Array(imported)), ("rejections", Value::Array(rejections))].into_iter().collect()
}

/// What an export writes, read before its save dialog opens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyLabelExport {
    /// The dialog's default file name, `key-labels-{name}.json`.
    pub default_name: String,
    /// The file: the Hub download's shape, `{name, map, composite_labels,
    /// keymap_applicable}`, two-space indented, so an export can be
    /// imported or uploaded again.
    pub content: String,
}

/// The export of the live entry `id`, up to its save dialog.
pub fn export_key_label(ctx: &StoreContext, id: &JsString) -> Result<KeyLabelExport, KeyLabelError> {
    let record = get_key_label(ctx, id)?;
    let data = record.get("data").and_then(Value::as_object).cloned().unwrap_or_default();
    let name = record.get("meta").and_then(Value::as_object).and_then(|meta| meta.get("name"));
    let stem = match name {
        // A lone surrogate is not a letter or digit, and neither is U+FFFD.
        Some(Value::String(name)) => safe_filename(&name.to_string_lossy(), "key-label"),
        other => return Err(method_type_error(other, "name", "replace")),
    };
    let mut file = Object::new();
    file.insert("name", data.get("name").cloned().unwrap_or(Value::Null));
    file.insert("map", data.get("map").cloned().unwrap_or(Value::Null));
    file.insert("composite_labels", data.get("compositeLabels").cloned().unwrap_or(Value::Null));
    file.insert("keymap_applicable", data.get("keymapApplicable").cloned().unwrap_or(Value::Bool(false)));
    Ok(KeyLabelExport {
        default_name: format!("key-labels-{stem}.json"),
        content: pipette_js_json::stringify_with_gap(&Value::Object(file), "  "),
    })
}
