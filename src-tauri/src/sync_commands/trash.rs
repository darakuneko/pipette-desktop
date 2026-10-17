// SPDX-License-Identifier: GPL-2.0-or-later
//! The Data > Sync > Trash screen (the `SYNC_LIST_TRASH`,
//! `SYNC_RESTORE_TRASH` and `SYNC_DELETE_TRASH` handlers of
//! src/main/sync/sync-reset-ipc.ts), on crates/pipette-sync's
//! `trash::manual`. Each answers as `wrapIpc` does, with the list or the
//! ids deleted and skipped on success. This machine's hash, which marks
//! its own typing days as not restorable, is the unit sync's.

use std::sync::Arc;

use pipette_sync::data_error::DataError;
use pipette_sync::dispatch::UnitSync;
use pipette_sync::preflight::Preflight;
use pipette_sync::reset::targets::{file_id_arg, file_ids_arg};
use pipette_sync::trash::manual::{
    SyncTrashFile, TrashDeleteResult, TrashEnv, delete_trash, list_trash_files, restore_trash,
};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use super::result::SyncOperationResult;
use crate::command_error::CommandError;

/// `SyncTrashListResult`.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct SyncTrashListResult {
    #[serde(flatten)]
    result: SyncOperationResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    files: Option<Vec<SyncTrashFile>>,
}

/// `SyncTrashDeleteResult`.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct SyncTrashDeleteResult {
    #[serde(flatten)]
    result: SyncOperationResult,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    done: Option<TrashDeleteResult>,
}

impl From<Result<Vec<SyncTrashFile>, DataError>> for SyncTrashListResult {
    fn from(result: Result<Vec<SyncTrashFile>, DataError>) -> Self {
        match result {
            Ok(files) => Self { result: SyncOperationResult::SUCCESS, files: Some(files) },
            Err(err) => Self { result: Err(err).into(), files: None },
        }
    }
}

impl From<Result<TrashDeleteResult, DataError>> for SyncTrashDeleteResult {
    fn from(result: Result<TrashDeleteResult, DataError>) -> Self {
        match result {
            Ok(done) => Self { result: SyncOperationResult::SUCCESS, done: Some(done) },
            Err(err) => Self { result: Err(err).into(), done: None },
        }
    }
}

/// This machine's hash, as the trash screen needs it.
fn own_hash(units: &UnitSync) -> impl Fn() -> Result<String, String> + Sync + '_ {
    || units.own_hash().map_err(|err| err.to_string())
}

/// The trash screen's environment at the time of the call.
fn env<'a>(
    preflight: &'a Preflight,
    own_hash: &'a (dyn Fn() -> Result<String, String> + Sync),
) -> TrashEnv<'a> {
    TrashEnv { preflight, own_hash, now_ms: pipette_time::now_ms() }
}

/// Every trash file on Drive, the most recently moved first.
#[tauri::command]
pub async fn sync_list_trash(
    preflight: State<'_, Arc<Preflight>>,
    units: State<'_, Arc<UnitSync>>,
) -> Result<SyncTrashListResult, CommandError> {
    let hash = own_hash(&units);
    Ok(list_trash_files(&env(&preflight, &hash)).await.into())
}

/// Swaps the trash file `file_id` in for the current copies of its name.
#[tauri::command]
pub async fn sync_restore_trash(
    preflight: State<'_, Arc<Preflight>>,
    units: State<'_, Arc<UnitSync>>,
    file_id: Option<Value>,
) -> Result<SyncOperationResult, CommandError> {
    let id = match file_id_arg(file_id.as_ref()) {
        Ok(id) => id,
        Err(err) => return Ok(SyncOperationResult::failure(err, None)),
    };
    let hash = own_hash(&units);
    Ok(restore_trash(&env(&preflight, &hash), &id).await.into())
}

/// Deletes those of `file_ids` that are still trash files.
#[tauri::command]
pub async fn sync_delete_trash(
    preflight: State<'_, Arc<Preflight>>,
    units: State<'_, Arc<UnitSync>>,
    file_ids: Option<Value>,
) -> Result<SyncTrashDeleteResult, CommandError> {
    let ids = match file_ids_arg(file_ids.as_ref()) {
        Ok(ids) => ids,
        Err(err) => return Ok(Err(DataError::Other(err)).into()),
    };
    let hash = own_hash(&units);
    Ok(delete_trash(&env(&preflight, &hash), &ids).await.into())
}

#[cfg(test)]
mod tests {
    use pipette_sync_runtime::SyncCredentialFailureReason;
    use serde_json::json;

    use super::*;

    #[test]
    fn answers_as_wrap_ipc_does() {
        let list = |result| serde_json::to_value(SyncTrashListResult::from(result)).unwrap();
        assert_eq!(list(Ok(vec![])), json!({ "success": true, "files": [] }));
        assert_eq!(
            list(Err(DataError::Readiness(SyncCredentialFailureReason::Unauthenticated))),
            json!({ "success": false, "error": "sync.readiness.unauthenticated", "reason": "unauthenticated" })
        );
        let delete = |result| serde_json::to_value(SyncTrashDeleteResult::from(result)).unwrap();
        let done = TrashDeleteResult { deleted: vec![], skipped: vec!["t".into()] };
        assert_eq!(delete(Ok(done)), json!({ "success": true, "deleted": [], "skipped": ["t"] }));
        assert_eq!(
            delete(Err(DataError::Other("No files specified".into()))),
            json!({ "success": false, "error": "No files specified" })
        );
    }
}
