// SPDX-License-Identifier: GPL-2.0-or-later
//! The Data modal's reads of Drive and the delete of chosen Drive files
//! (the `SYNC_SCAN_REMOTE`, `SYNC_FETCH_REMOTE_BUNDLE` and
//! `SYNC_DELETE_FILES` handlers of src/main/sync/sync-ipc.ts and
//! sync-reset-ipc.ts), and the Local Data export and import (the
//! `EXPORT_LOCAL_DATA` and `IMPORT_LOCAL_DATA` handlers), on
//! crates/pipette-sync's `scan`, `reset` and `local_data`.
//!
//! The scan and the bundle are not wrapped: a refusal or a Drive failure
//! is the command's error, and the answers are the JSON the Electron
//! handlers send. The delete answers as `wrapIpc` does. The export and
//! import dialogs have the default file name and the filter of those
//! handlers and no title of their own, as there; the answers are
//! `wrapIpc`'s: the failure's text, and `cancelled` for an import whose
//! dialog was cancelled (a cancelled export is a success).

use std::sync::Arc;

use pipette_keyboard_stores::StoreContext;
use pipette_sync::codec::EnvelopeCrypto;
use pipette_sync::local_data::{collect_export_categories, export_default_filename, export_text};
use pipette_sync::preflight::Preflight;
use pipette_sync::reset::Resets;
use pipette_sync::reset::targets::file_ids_arg;
use pipette_sync::scan::{fetch_remote_bundle, scan_remote_data};
use serde::Serialize;
use serde_json::Value;
use tauri::State;
use tauri::ipc::Response;

use super::result::SyncOperationResult;
use crate::command_error::CommandError;
use crate::dialog::{DialogKind, DialogRequest, Dialogs, FileFilter};

/// `ImportLocalDataResult` of src/shared/types/sync.ts.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct ImportLocalDataResult {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    cancelled: bool,
}

impl ImportLocalDataResult {
    const DONE: Self = Self { success: true, error: None, cancelled: false };
    const CANCELLED: Self = Self { success: true, error: None, cancelled: true };

    fn failed(error: impl ToString) -> Self {
        Self { success: false, error: Some(error.to_string()), cancelled: false }
    }
}

fn json_filters() -> Vec<FileFilter> {
    vec![FileFilter::new("JSON", &["json"])]
}

/// Runs `run` on a blocking-task thread with the stores and the dialogs.
async fn blocking<T: Send + 'static>(
    stores: &State<'_, StoreContext>,
    dialogs: &State<'_, Dialogs>,
    run: impl FnOnce(&StoreContext, &Dialogs) -> T + Send + 'static,
) -> Result<T, CommandError> {
    let (stores, dialogs) = (stores.inner().clone(), dialogs.inner().clone());
    Ok(tauri::async_runtime::spawn_blocking(move || run(&stores, &dialogs)).await?)
}

/// Reads the favorites, snapshots and settings, asks where to save them,
/// and writes the export file there.
fn export(stores: &StoreContext, dialogs: &Dialogs) -> Result<(), String> {
    let categories = collect_export_categories(stores).map_err(|err| err.to_string())?;
    let request = DialogRequest {
        kind: DialogKind::SaveFile { default_name: export_default_filename(stores.now_ms()) },
        title: String::new(),
        filters: json_filters(),
    };
    let Some(path) = dialogs.show(request) else { return Ok(()) };
    let text = export_text(categories, stores.now_ms());
    std::fs::write(path, text).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn export_local_data(
    stores: State<'_, StoreContext>,
    dialogs: State<'_, Dialogs>,
) -> Result<SyncOperationResult, CommandError> {
    let result = blocking(&stores, &dialogs, export).await?;
    Ok(result.map_or_else(|err| SyncOperationResult::failure(err, None), |()| SyncOperationResult::SUCCESS))
}

/// Asks for an export file, imports it, and reports the units it changed
/// for sync.
fn import(stores: &StoreContext, dialogs: &Dialogs) -> ImportLocalDataResult {
    let request = DialogRequest { kind: DialogKind::OpenFile, title: String::new(), filters: json_filters() };
    let Some(path) = dialogs.show(request) else { return ImportLocalDataResult::CANCELLED };
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) => return ImportLocalDataResult::failed(err),
    };
    let file = match pipette_js_json::parse(&String::from_utf8_lossy(&bytes)) {
        Ok(file) => file,
        Err(err) => return ImportLocalDataResult::failed(err),
    };
    match pipette_sync::local_data::import_local_data(stores, &file) {
        Ok(units) => {
            for unit in units {
                stores.notify(&unit);
            }
            ImportLocalDataResult::DONE
        }
        Err(err) => ImportLocalDataResult::failed(err),
    }
}

#[tauri::command]
pub async fn import_local_data(
    stores: State<'_, StoreContext>,
    dialogs: State<'_, Dialogs>,
) -> Result<ImportLocalDataResult, CommandError> {
    blocking(&stores, &dialogs, import).await
}

/// What Drive holds, by category, and the files the stored password does
/// not open; empty without credentials.
#[tauri::command]
pub async fn sync_scan_remote(
    preflight: State<'_, Arc<Preflight>>,
    stores: State<'_, StoreContext>,
) -> Result<Response, CommandError> {
    let result = scan_remote_data(&preflight, &EnvelopeCrypto, &stores).await?;
    Ok(Response::new(result.to_json()))
}

/// The bundle of `sync_unit` on Drive, without merging it; `null` for a
/// unit that is not a non-empty string, without credentials, or when the
/// file is missing or does not open.
#[tauri::command]
pub async fn sync_fetch_remote_bundle(
    preflight: State<'_, Arc<Preflight>>,
    sync_unit: Option<Value>,
) -> Result<Response, CommandError> {
    let Some(unit) = sync_unit.as_ref().and_then(Value::as_str).filter(|unit| !unit.is_empty()) else {
        return Ok(Response::new("null".to_owned()));
    };
    let bundle = fetch_remote_bundle(&preflight, &EnvelopeCrypto, unit).await?;
    Ok(Response::new(bundle.unwrap_or_else(|| "null".to_owned())))
}

/// Deletes the Drive files of `file_ids`.
#[tauri::command]
pub async fn sync_delete_files(
    resets: State<'_, Arc<Resets>>,
    file_ids: Option<Value>,
) -> Result<SyncOperationResult, CommandError> {
    let ids = match file_ids_arg(file_ids.as_ref()) {
        Ok(ids) => ids,
        Err(err) => return Ok(SyncOperationResult::failure(err, None)),
    };
    Ok(resets.delete_files(&ids).await.into())
}

#[cfg(test)]
mod tests;
