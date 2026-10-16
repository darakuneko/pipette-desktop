// SPDX-License-Identifier: GPL-2.0-or-later
//! The key label commands of the shim's `keyLabelStore*` members
//! (src/tauri-shim/api/key-labels.ts), on the key label store of
//! crates/pipette-keyboard-stores (managed by store_commands/keyboard_data.rs).
//!
//! Each answers the handler's `{success, data?, errorCode?, error?}` object
//! as JSON text written by `pipette_js_json`, so the entries' fields this
//! build does not know reach the renderer as `JSON.stringify` writes them.
//! The arguments are taken as any JSON value and checked as the handlers of
//! src/main/key-label-ipc.ts check them, answering their `Invalid …`
//! failures. The import and export dialogs have the titles and filters of
//! src/main/key-label-store.ts; the import picks several files.

use std::convert::Infallible;
use std::path::PathBuf;

use pipette_js_json::{JsString, Value};
use pipette_keyboard_stores::{KeyLabelError, KeyLabelErrorCode, StoreContext, key_label_response};
use serde_json::Value as Arg;
use tauri::State;
use tauri::ipc::Response;

use super::blocking;
use crate::command_error::CommandError;
use crate::dialog::{DialogKind, DialogRequest, Dialogs, FileFilter};

/// What a store operation answers besides `success`.
type Answer = Result<Option<Value>, KeyLabelError>;

/// Runs `io` on a blocking-task thread and answers its result as the
/// handler's object.
async fn answer<F>(stores: &State<'_, StoreContext>, io: F) -> Result<Response, CommandError>
where
    F: FnOnce(&StoreContext) -> Answer + Send + 'static,
{
    let result = blocking(stores, move |stores| Ok::<_, Infallible>(io(stores))).await?;
    Ok(Response::new(key_label_response(result)))
}

/// The argument as a string, `None` for any other value or none.
fn string(arg: Option<Arg>) -> Option<JsString> {
    match arg {
        Some(Arg::String(text)) => Some(text.into()),
        _ => None,
    }
}

/// The id argument: a string, or the handler's `Invalid id`.
fn id(arg: Option<Arg>) -> Result<JsString, KeyLabelError> {
    string(arg).ok_or_else(|| KeyLabelError::invalid_argument(KeyLabelErrorCode::NotFound, "Invalid id"))
}

fn invalid_name() -> KeyLabelError {
    KeyLabelError::invalid_argument(KeyLabelErrorCode::InvalidName, "Invalid name")
}

fn entries(list: Vec<pipette_entry_store::Entry>) -> Option<Value> {
    Some(Value::Array(list.into_iter().map(Value::from).collect()))
}

/// The filters of the key label dialogs.
fn json_filters() -> Vec<FileFilter> {
    vec![FileFilter::new("JSON", &["json"]), FileFilter::all_files()]
}

#[tauri::command]
pub async fn key_label_store_list(stores: State<'_, StoreContext>) -> Result<Response, CommandError> {
    answer(&stores, |stores| pipette_keyboard_stores::list_key_labels(stores, false).map(entries)).await
}

#[tauri::command]
pub async fn key_label_store_list_all(stores: State<'_, StoreContext>) -> Result<Response, CommandError> {
    answer(&stores, |stores| pipette_keyboard_stores::list_key_labels(stores, true).map(entries)).await
}

#[tauri::command]
pub async fn key_label_store_get(
    stores: State<'_, StoreContext>,
    id: Option<Arg>,
) -> Result<Response, CommandError> {
    let id = self::id(id);
    answer(&stores, move |stores| {
        Ok(Some(Value::Object(pipette_keyboard_stores::get_key_label(stores, &id?)?)))
    })
    .await
}

#[tauri::command]
pub async fn key_label_store_rename(
    stores: State<'_, StoreContext>,
    id: Option<Arg>,
    new_name: Option<Arg>,
) -> Result<Response, CommandError> {
    let (id, name) = (self::id(id), string(new_name));
    answer(&stores, move |stores| {
        let (id, name) = (id?, name.ok_or_else(invalid_name)?);
        Ok(Some(pipette_keyboard_stores::rename_key_label(stores, &id, &name)?.into()))
    })
    .await
}

#[tauri::command]
pub async fn key_label_store_delete(
    stores: State<'_, StoreContext>,
    id: Option<Arg>,
) -> Result<Response, CommandError> {
    let id = self::id(id);
    answer(&stores, move |stores| pipette_keyboard_stores::delete_key_label(stores, &id?).map(|()| None))
        .await
}

/// A post id that is not a string clears the link, as the handler reads it.
#[tauri::command]
pub async fn key_label_store_set_hub_post_id(
    stores: State<'_, StoreContext>,
    id: Option<Arg>,
    hub_post_id: Option<Arg>,
) -> Result<Response, CommandError> {
    let (id, post_id) = (self::id(id), string(hub_post_id));
    answer(&stores, move |stores| {
        let meta =
            pipette_keyboard_stores::set_key_label_hub_post_id(stores, &id?, post_id.as_ref(), None, None)?;
        Ok(Some(meta.into()))
    })
    .await
}

#[tauri::command]
pub async fn key_label_store_reorder(
    stores: State<'_, StoreContext>,
    ordered_ids: Option<Arg>,
) -> Result<Response, CommandError> {
    let ids: Option<Vec<JsString>> = match ordered_ids {
        Some(Arg::Array(ids)) => ids.into_iter().map(|id| string(Some(id))).collect(),
        _ => None,
    };
    answer(&stores, move |stores| {
        let ids = ids.ok_or_else(|| {
            KeyLabelError::invalid_argument(KeyLabelErrorCode::InvalidFile, "Invalid order list")
        })?;
        pipette_keyboard_stores::reorder_key_labels(stores, &ids).map(|()| None)
    })
    .await
}

/// An exclude id that is not a string excludes nothing.
#[tauri::command]
pub async fn key_label_store_has_name(
    stores: State<'_, StoreContext>,
    name: Option<Arg>,
    exclude_id: Option<Arg>,
) -> Result<Response, CommandError> {
    let (name, exclude) = (string(name), string(exclude_id));
    answer(&stores, move |stores| {
        let name = name.ok_or_else(invalid_name)?;
        let found = pipette_keyboard_stores::has_key_label_name(stores, &name, exclude.as_ref())?;
        Ok(Some(found.into()))
    })
    .await
}

/// Runs `run` with the stores and the dialogs on a blocking-task thread
/// (the dialog waits for the user) and answers its result.
async fn with_dialog<F>(
    stores: State<'_, StoreContext>,
    dialogs: State<'_, Dialogs>,
    run: F,
) -> Result<Response, CommandError>
where
    F: FnOnce(&StoreContext, &Dialogs) -> Answer + Send + 'static,
{
    let dialogs = dialogs.inner().clone();
    answer(&stores, move |stores| run(stores, &dialogs)).await
}

/// Asks for key label files and imports each: `{imported, rejections}`.
#[tauri::command]
pub async fn key_label_store_import(
    stores: State<'_, StoreContext>,
    dialogs: State<'_, Dialogs>,
) -> Result<Response, CommandError> {
    with_dialog(stores, dialogs, |stores, dialogs| {
        let paths = dialogs.show_many(DialogRequest {
            kind: DialogKind::OpenMany,
            title: "Import Key Label".to_owned(),
            filters: json_filters(),
        });
        if paths.is_empty() {
            return Err(KeyLabelError::cancelled());
        }
        Ok(Some(Value::Object(pipette_keyboard_stores::import_key_label_files(stores, &paths))))
    })
    .await
}

/// Reads the label `id`, asks where to save it and writes it there:
/// `{filePath}`.
#[tauri::command]
pub async fn key_label_store_export(
    stores: State<'_, StoreContext>,
    dialogs: State<'_, Dialogs>,
    id: Option<Arg>,
) -> Result<Response, CommandError> {
    let id = self::id(id);
    with_dialog(stores, dialogs, move |stores, dialogs| {
        let file = pipette_keyboard_stores::export_key_label(stores, &id?)?;
        let path: PathBuf = dialogs
            .show(DialogRequest {
                kind: DialogKind::SaveFile { default_name: file.default_name },
                title: "Export Key Label".to_owned(),
                filters: json_filters(),
            })
            .ok_or_else(KeyLabelError::cancelled)?;
        std::fs::write(&path, file.content)?;
        let data = std::iter::once(("filePath", Value::from(path.to_string_lossy().into_owned()))).collect();
        Ok(Some(Value::Object(data)))
    })
    .await
}

#[cfg(test)]
mod tests;
