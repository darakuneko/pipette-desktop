// SPDX-License-Identifier: GPL-2.0-or-later
//! The Local Data export and import of the Data modal (the
//! `EXPORT_LOCAL_DATA` and `IMPORT_LOCAL_DATA` handlers of
//! src/main/sync/sync-ipc.ts), on crates/pipette-sync's `local_data`. The
//! dialogs have the default file name and the filter of those handlers
//! and no title of their own, as there. The answers are `wrapIpc`'s: the
//! failure's text, and `cancelled` for an import whose dialog was
//! cancelled (a cancelled export is a success).

use pipette_keyboard_stores::StoreContext;
use pipette_sync::local_data::{collect_export_categories, export_default_filename, export_text};
use serde::Serialize;
use tauri::State;

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

#[cfg(test)]
mod tests;
