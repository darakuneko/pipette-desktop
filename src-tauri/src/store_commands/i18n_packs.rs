// SPDX-License-Identifier: GPL-2.0-or-later
//! The language pack commands of the shim's `i18nPack*` members
//! (src/tauri-shim/api/i18n-packs.ts), on the language pack store of
//! crates/pipette-pack-stores (its context managed by
//! store_commands/keyboard_data.rs).
//!
//! Each command answers the handler's `{success, data | errorCode, error}`
//! object as JSON text (store_commands/pack_commands.rs); the arguments are
//! checked as the handlers of src/main/i18n-pack-ipc.ts check them. The pack JSON and the import
//! options cross as the text of `JSON.stringify`, so they keep their key
//! order. The import dialog answers the text of each file
//! (store_commands/pack_import.rs) and the shim parses it.

use pipette_keyboard_stores::StoreContext;
use pipette_pack_stores::i18n_handlers as handlers;
use tauri::State;
use tauri::ipc::Response;

use super::pack_commands::{Arg, answer, export_through_dialog, js, js_text};
use super::pack_import::{PackImportRead, read_chosen_packs};
use crate::command_error::CommandError;
use crate::dialog::Dialogs;

#[tauri::command]
pub async fn i18n_pack_store_list(stores: State<'_, StoreContext>) -> Result<Response, CommandError> {
    answer(&stores, handlers::list).await
}

#[tauri::command]
pub async fn i18n_pack_store_get(stores: State<'_, StoreContext>, id: Arg) -> Result<Response, CommandError> {
    let id = js(id)?;
    answer(&stores, move |stores| handlers::get(stores, id.as_ref())).await
}

#[tauri::command]
pub async fn i18n_pack_store_rename(
    stores: State<'_, StoreContext>,
    id: Arg,
    new_name: Arg,
) -> Result<Response, CommandError> {
    let (id, new_name) = (js(id)?, js(new_name)?);
    answer(&stores, move |stores| handlers::rename(stores, id.as_ref(), new_name.as_ref())).await
}

#[tauri::command]
pub async fn i18n_pack_store_set_enabled(
    stores: State<'_, StoreContext>,
    id: Arg,
    enabled: Arg,
) -> Result<Response, CommandError> {
    let (id, enabled) = (js(id)?, js(enabled)?);
    answer(&stores, move |stores| handlers::set_enabled(stores, id.as_ref(), enabled.as_ref())).await
}

#[tauri::command]
pub async fn i18n_pack_store_refresh_coverage(
    stores: State<'_, StoreContext>,
    id: Arg,
    values: Arg,
) -> Result<Response, CommandError> {
    let (id, values) = (js(id)?, js(values)?);
    answer(&stores, move |stores| handlers::refresh_coverage(stores, id.as_ref(), values.as_ref())).await
}

#[tauri::command]
pub async fn i18n_pack_store_delete(
    stores: State<'_, StoreContext>,
    id: Arg,
) -> Result<Response, CommandError> {
    let id = js(id)?;
    answer(&stores, move |stores| handlers::delete(stores, id.as_ref())).await
}

#[tauri::command]
pub async fn i18n_pack_store_set_hub_post_id(
    stores: State<'_, StoreContext>,
    id: Arg,
    hub_post_id: Arg,
    uploader_name: Arg,
    hub_updated_at: Arg,
) -> Result<Response, CommandError> {
    let (id, post, uploader, updated) = (js(id)?, js(hub_post_id)?, js(uploader_name)?, js(hub_updated_at)?);
    answer(&stores, move |stores| {
        handlers::set_hub_post_id(stores, id.as_ref(), post.as_ref(), uploader.as_ref(), updated.as_ref())
    })
    .await
}

#[tauri::command]
pub async fn i18n_pack_store_has_name(
    stores: State<'_, StoreContext>,
    name: Arg,
    exclude_id: Arg,
) -> Result<Response, CommandError> {
    let (name, exclude_id) = (js(name)?, js(exclude_id)?);
    answer(&stores, move |stores| handlers::has_name(stores, name.as_ref(), exclude_id.as_ref())).await
}

#[tauri::command]
pub async fn i18n_pack_store_reorder(
    stores: State<'_, StoreContext>,
    ordered_ids: Arg,
) -> Result<Response, CommandError> {
    let ordered_ids = js(ordered_ids)?;
    answer(&stores, move |stores| handlers::reorder(stores, ordered_ids.as_ref())).await
}

/// Asks for the pack files to import and answers their text.
#[tauri::command]
pub async fn i18n_pack_import(dialogs: State<'_, Dialogs>) -> Result<PackImportRead, CommandError> {
    let dialogs = dialogs.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || read_chosen_packs(&dialogs, "Import Language Pack"))
        .await?)
}

/// `raw` and `options` are the text of `JSON.stringify` of the pack and of
/// the options; no `raw` is a pack that is `undefined`.
#[tauri::command]
pub async fn i18n_pack_import_apply(
    stores: State<'_, StoreContext>,
    raw: Option<String>,
    options: Option<String>,
) -> Result<Response, CommandError> {
    let (raw, options) = (js_text(raw)?, js_text(options)?);
    answer(&stores, move |stores| handlers::import_apply(stores, raw.as_ref(), options.as_ref())).await
}

/// Writes the pack `id` where the user chooses. Fails, as the handler
/// throws, for a pack whose name is not a string.
#[tauri::command]
pub async fn i18n_pack_export(
    stores: State<'_, StoreContext>,
    dialogs: State<'_, Dialogs>,
    id: Arg,
) -> Result<Response, CommandError> {
    let id = js(id)?;
    export_through_dialog(&stores, &dialogs, "Export Language Pack", move |stores, choose| {
        handlers::export(stores, id.as_ref(), choose)
    })
    .await
}

#[cfg(test)]
mod tests;
