// SPDX-License-Identifier: GPL-2.0-or-later
//! The favorite commands of the shim's `favoriteStore*` members
//! (src/tauri-shim/api/favorites.ts), on the favorite store of
//! crates/pipette-keyboard-stores (managed by store_commands/keyboard_data.rs).
//!
//! The store commands answer the handler's `{success, …}` object as JSON
//! text written by `pipette_js_json`, so the entries' fields this build
//! does not know reach the renderer as `JSON.stringify` writes them. A
//! failure of the store is such an answer too; a command fails only when
//! its task cannot run or its arguments are malformed.
//!
//! The export and the import convert keycodes in the shim's worker
//! (src/tauri-shim/workers/favorite-transfer.worker.ts), so they are split
//! here: `favorite_store_read_for_export` reads the stored favorites and
//! `favorite_store_save_export` saves the file the worker built;
//! `favorite_store_open_import` reads the file the user picks and
//! `favorite_store_import_batch` stores one type's converted favorites.
//! The dialogs have the title and the filters of src/main/favorite-store.ts;
//! the page passes only the default file name, cleaned here.

use pipette_entry_store::sanitize_filename;
use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::{
    FavoriteError, FavoriteImport, FavoriteType, StoreContext, favorite_response_json,
};
use tauri::State;
use tauri::ipc::Response;

use crate::command_error::CommandError;
use crate::dialog::{DialogKind, DialogRequest, Dialogs, FileFilter};
use crate::file_commands::{FileOpenResult, FileSaveResult, open_with_dialog, write_with_dialog};

/// The type the renderer names, if it names one: like the handler, a value
/// that is not a type's name (or not a string) is an invalid type.
fn parse_type(value: Option<&serde_json::Value>) -> Result<FavoriteType, FavoriteError> {
    value.and_then(serde_json::Value::as_str).map_or(Err(FavoriteError::InvalidType), FavoriteType::parse)
}

/// Runs `io` on a blocking-task thread (the store waits for its write lock
/// and syncs its writes to disk) and answers its result.
async fn answer<F>(stores: &State<'_, StoreContext>, io: F) -> Result<Response, CommandError>
where
    F: FnOnce(&StoreContext) -> Result<Object, FavoriteError> + Send + 'static,
{
    let stores = stores.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || io(&stores)).await?;
    Ok(Response::new(favorite_response_json(result)))
}

fn field(key: &str, value: impl Into<Value>) -> Object {
    std::iter::once((key, value.into())).collect()
}

#[tauri::command]
pub async fn favorite_store_list(
    stores: State<'_, StoreContext>,
    favorite_type: Option<serde_json::Value>,
) -> Result<Response, CommandError> {
    let ty = parse_type(favorite_type.as_ref());
    answer(&stores, move |stores| {
        let entries = pipette_keyboard_stores::list_favorites(stores, ty?)?;
        Ok(field("entries", Value::Array(entries.into_iter().map(Value::from).collect())))
    })
    .await
}

#[tauri::command]
pub async fn favorite_store_save(
    stores: State<'_, StoreContext>,
    favorite_type: Option<serde_json::Value>,
    json: String,
    label: String,
) -> Result<Response, CommandError> {
    let ty = parse_type(favorite_type.as_ref());
    answer(&stores, move |stores| {
        let entry = pipette_keyboard_stores::save_favorite(stores, ty?, &json, &label)?;
        Ok(field("entry", entry))
    })
    .await
}

#[tauri::command]
pub async fn favorite_store_load(
    stores: State<'_, StoreContext>,
    favorite_type: Option<serde_json::Value>,
    entry_id: String,
) -> Result<Response, CommandError> {
    let ty = parse_type(favorite_type.as_ref());
    answer(&stores, move |stores| {
        Ok(field("data", pipette_keyboard_stores::load_favorite(stores, ty?, &entry_id)?))
    })
    .await
}

#[tauri::command]
pub async fn favorite_store_rename(
    stores: State<'_, StoreContext>,
    favorite_type: Option<serde_json::Value>,
    entry_id: String,
    new_label: String,
) -> Result<Response, CommandError> {
    let ty = parse_type(favorite_type.as_ref());
    answer(&stores, move |stores| {
        pipette_keyboard_stores::rename_favorite(stores, ty?, &entry_id, &new_label)?;
        Ok(Object::new())
    })
    .await
}

#[tauri::command]
pub async fn favorite_store_delete(
    stores: State<'_, StoreContext>,
    favorite_type: Option<serde_json::Value>,
    entry_id: String,
) -> Result<Response, CommandError> {
    let ty = parse_type(favorite_type.as_ref());
    answer(&stores, move |stores| {
        pipette_keyboard_stores::delete_favorite(stores, ty?, &entry_id)?;
        Ok(Object::new())
    })
    .await
}

#[tauri::command]
pub async fn favorite_store_set_hub_post_id(
    stores: State<'_, StoreContext>,
    favorite_type: Option<serde_json::Value>,
    entry_id: String,
    hub_post_id: Option<String>,
) -> Result<Response, CommandError> {
    let ty = parse_type(favorite_type.as_ref());
    answer(&stores, move |stores| {
        pipette_keyboard_stores::set_favorite_hub_post_id(stores, ty?, &entry_id, hub_post_id.as_deref())?;
        Ok(Object::new())
    })
    .await
}

/// `link` is the text of `JSON.stringify(link)`, read as `JSON.parse` would
/// so the link keeps its key order; `null` (or no text) clears the link.
#[tauri::command]
pub async fn favorite_store_set_hub_private(
    stores: State<'_, StoreContext>,
    favorite_type: Option<serde_json::Value>,
    entry_id: String,
    link: Option<String>,
) -> Result<Response, CommandError> {
    let ty = parse_type(favorite_type.as_ref());
    let link = link.as_deref().map(pipette_js_json::parse).transpose()?.filter(|link| *link != Value::Null);
    answer(&stores, move |stores| {
        pipette_keyboard_stores::set_favorite_hub_private(stores, ty?, &entry_id, link)?;
        Ok(Object::new())
    })
    .await
}

/// `{success: true, entries: [{label, savedAt, body}]}`: the live favorites
/// an export of the type (or of its entry `entry_id`) reads.
#[tauri::command]
pub async fn favorite_store_read_for_export(
    stores: State<'_, StoreContext>,
    favorite_type: Option<serde_json::Value>,
    entry_id: Option<String>,
) -> Result<Response, CommandError> {
    let ty = parse_type(favorite_type.as_ref());
    answer(&stores, move |stores| {
        let bodies = pipette_keyboard_stores::read_favorites_for_export(stores, ty?, entry_id.as_deref())?;
        Ok(field("entries", Value::Array(bodies)))
    })
    .await
}

/// The filters of the favorite dialogs.
fn json_filters() -> Vec<FileFilter> {
    vec![FileFilter::new("JSON", &["json"]), FileFilter::all_files()]
}

/// Asks where to save an export file, starting from `default_filename`
/// (cleaned to one file name), and writes `content` there.
#[tauri::command]
pub async fn favorite_store_save_export(
    dialogs: State<'_, Dialogs>,
    default_filename: String,
    content: String,
) -> Result<FileSaveResult, CommandError> {
    let request = DialogRequest {
        kind: DialogKind::SaveFile { default_name: sanitize_filename(&default_filename) },
        title: "Export Favorites".to_owned(),
        filters: json_filters(),
    };
    let dialogs = dialogs.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || write_with_dialog(&dialogs, request, content.as_bytes()))
        .await?)
}

/// Asks for an export file and answers its text.
#[tauri::command]
pub async fn favorite_store_open_import(dialogs: State<'_, Dialogs>) -> Result<FileOpenResult, CommandError> {
    let request = DialogRequest {
        kind: DialogKind::OpenFile,
        title: "Import Favorites".to_owned(),
        filters: json_filters(),
    };
    let dialogs = dialogs.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || open_with_dialog(&dialogs, request)).await?)
}

#[derive(Debug, thiserror::Error)]
#[error("the favorites to import are not a list of {{label, savedAt, body}} strings")]
struct MalformedImport;

/// The favorites of `entries`, the text of `JSON.stringify([{label,
/// savedAt, body}, …])`, read as `JSON.parse` would so a label keeps a
/// lone surrogate.
fn import_entries(entries: &str) -> Result<Vec<FavoriteImport>, CommandError> {
    let Ok(Value::Array(list)) = pipette_js_json::parse(entries) else { return Err(MalformedImport.into()) };
    let text = |entry: &Object, key: &str| match entry.get(key) {
        Some(Value::String(s)) => Ok(s.clone()),
        _ => Err(CommandError::from(MalformedImport)),
    };
    list.iter()
        .map(|entry| {
            let entry = entry.as_object().ok_or(MalformedImport)?;
            Ok(FavoriteImport {
                label: text(entry, "label")?,
                saved_at: text(entry, "savedAt")?,
                body: text(entry, "body")?,
            })
        })
        .collect()
}

/// `{success: true, imported, skipped}` for one type's favorites of an
/// import.
#[tauri::command]
pub async fn favorite_store_import_batch(
    stores: State<'_, StoreContext>,
    favorite_type: Option<serde_json::Value>,
    entries: String,
) -> Result<Response, CommandError> {
    let ty = parse_type(favorite_type.as_ref());
    let favorites = import_entries(&entries)?;
    answer(&stores, move |stores| {
        let counts = pipette_keyboard_stores::import_favorites(stores, ty?, &favorites)?;
        // Counts stay far below 2^53.
        #[allow(clippy::cast_precision_loss)]
        let fields = [("imported", counts.imported as f64), ("skipped", counts.skipped as f64)];
        Ok(fields.into_iter().map(|(key, count)| (key, Value::from(count))).collect())
    })
    .await
}

#[cfg(test)]
mod tests;
