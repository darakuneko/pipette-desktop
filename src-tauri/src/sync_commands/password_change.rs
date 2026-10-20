// SPDX-License-Identifier: GPL-2.0-or-later
//! The sync password change: the change, its
//! status, resume, revert, abandon, the deletion of the files neither
//! password opens, the Drive lock's status and release, and the list of
//! the files the stored password does not open. The change of this machine
//! is recovered once at startup, and the quit sequence stops a running one
//! at its next batch (`quit_phase`). Neither password reaches the page.

use std::sync::Arc;

use pipette_sync::codec::EnvelopeCrypto;
use pipette_sync::password::change::{
    DeleteUndecryptableResult, PasswordChange, PasswordChangeDeps, PasswordChangeStatus,
    PasswordChangeTuning, random_lock_id,
};
use pipette_sync::password::change_error::PasswordChangeError;
use pipette_sync::password::lock::LockTiming;
use pipette_sync::password::lock_release::PasswordChangeLockStatus;
use pipette_sync::preflight::Preflight;
use pipette_sync::scan::{UndecryptableFile, list_undecryptable_files};
use pipette_typing_analytics::{DataOps, SyncRuntime};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, State};
use zeroize::Zeroizing;

use super::SyncSecrets;
use super::result::SyncOperationResult;
use crate::command_error::CommandError;
use crate::shutdown::QuitPhase;

impl From<Result<(), PasswordChangeError>> for SyncOperationResult {
    fn from(result: Result<(), PasswordChangeError>) -> Self {
        match result {
            Ok(()) => Self::SUCCESS,
            Err(err) => Self::failure(err.to_string(), err.reason()),
        }
    }
}

/// Manages the password change on the preflight's Drive and starts the
/// recovery of a change the last run left. Needs the sync's secrets, the
/// preflight ([`super::preflight::manage`]) and the typing analytics (the
/// machine hash) to be managed first.
pub fn manage<R: Runtime>(app: &AppHandle<R>) {
    let ops = Arc::clone(app.state::<Arc<DataOps>>().inner());
    let change = PasswordChange::new(PasswordChangeDeps {
        preflight: Arc::clone(app.state::<Arc<Preflight>>().inner()),
        secrets: Arc::clone(&app.state::<SyncSecrets>().secrets),
        codec: Arc::new(EnvelopeCrypto),
        machine_hash: Arc::new(move || ops.analytics().machine_hash().map_err(|err| err.to_string())),
        new_lock_id: Arc::new(random_lock_id),
        lock_timing: LockTiming::default(),
        tuning: PasswordChangeTuning::default(),
    });
    app.manage(Arc::clone(&change));
    tauri::async_runtime::spawn(async move {
        let recovery = change.recover_on_startup().await;
        log::info!("[sync] password change recovery at startup: {recovery:?}");
    });
}

/// [`manage`] for the tests: a fixed machine hash and lock id, and no
/// recovery runs.
#[cfg(test)]
pub fn manage_for_tests<R: Runtime>(app: &AppHandle<R>) {
    let change = PasswordChange::new(PasswordChangeDeps {
        preflight: Arc::clone(app.state::<Arc<Preflight>>().inner()),
        secrets: Arc::clone(&app.state::<SyncSecrets>().secrets),
        codec: Arc::new(EnvelopeCrypto),
        machine_hash: Arc::new(|| Ok("machine".to_owned())),
        new_lock_id: Arc::new(|| "lock".to_owned()),
        lock_timing: LockTiming::default(),
        tuning: PasswordChangeTuning::default(),
    });
    app.manage(change);
}

/// The quit sequence's `passwordChange` phase: marks the app as quitting,
/// so a running change stops at its next batch with its state kept for the
/// next launch, and waits for it to end. Ends at once when none runs.
pub fn quit_phase(runtime: SyncRuntime, name: &'static str) -> QuitPhase {
    QuitPhase::new(name, async move {
        runtime.set_quitting();
        runtime.password_change_ended().await;
    })
}

/// Starts changing the sync password to `new_password`.
#[tauri::command]
pub async fn sync_change_password(
    change: State<'_, Arc<PasswordChange>>,
    new_password: String,
) -> Result<SyncOperationResult, CommandError> {
    let new_password = Zeroizing::new(new_password);
    if new_password.is_empty() {
        return Ok(SyncOperationResult::failure("Invalid password".to_owned(), None));
    }
    Ok(change.start(&new_password).await.into())
}

/// The progress of this machine's change, without passwords or lock ids.
#[tauri::command]
pub async fn sync_password_change_status(
    change: State<'_, Arc<PasswordChange>>,
) -> Result<PasswordChangeStatus, CommandError> {
    Ok(change.status().await)
}

#[tauri::command]
pub async fn sync_password_change_resume(
    change: State<'_, Arc<PasswordChange>>,
) -> Result<SyncOperationResult, CommandError> {
    Ok(change.resume().await.into())
}

#[tauri::command]
pub async fn sync_password_change_revert(
    change: State<'_, Arc<PasswordChange>>,
) -> Result<SyncOperationResult, CommandError> {
    Ok(change.revert().await.into())
}

#[tauri::command]
pub async fn sync_password_change_abandon(
    change: State<'_, Arc<PasswordChange>>,
) -> Result<SyncOperationResult, CommandError> {
    Ok(change.abandon().await.into())
}

/// `PasswordChangeDeleteResult`: a `SyncOperationResult` with the ids
/// deleted and skipped.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct PasswordChangeDeleteResult {
    #[serde(flatten)]
    result: SyncOperationResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    deleted: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    skipped: Option<Vec<String>>,
}

impl From<Result<DeleteUndecryptableResult, PasswordChangeError>> for PasswordChangeDeleteResult {
    fn from(result: Result<DeleteUndecryptableResult, PasswordChangeError>) -> Self {
        match result {
            Ok(done) => Self {
                result: SyncOperationResult::SUCCESS,
                deleted: Some(done.deleted),
                skipped: Some(done.skipped),
            },
            Err(err) => Self { result: Err(err).into(), deleted: None, skipped: None },
        }
    }
}

/// The ids of a delete: a non-empty list of non-empty strings.
fn file_ids(value: &Value) -> Option<Vec<String>> {
    let ids = value.as_array().filter(|ids| !ids.is_empty())?;
    ids.iter().map(|id| id.as_str().filter(|id| !id.is_empty()).map(str::to_owned)).collect()
}

/// Deletes the given Drive files, each only once it is checked again to
/// open with neither password.
#[tauri::command]
pub async fn sync_password_change_delete_undecryptable(
    change: State<'_, Arc<PasswordChange>>,
    file_ids: Value,
) -> Result<PasswordChangeDeleteResult, CommandError> {
    let Some(ids) = self::file_ids(&file_ids) else {
        return Ok(Err(PasswordChangeError::Other("Invalid file IDs".to_owned())).into());
    };
    Ok(change.delete_undecryptable(&ids).await.into())
}

/// The lock on Drive that blocks syncing, `null` when there is none; a
/// Drive failure is the command's error. Runs without the sync guard.
#[tauri::command]
pub async fn sync_password_change_lock_status(
    change: State<'_, Arc<PasswordChange>>,
) -> Result<Option<PasswordChangeLockStatus>, CommandError> {
    Ok(change.lock_status().await?)
}

/// Deletes every password-change lock on Drive, the way out when the
/// machine holding it never comes back. Runs without the sync guard.
#[tauri::command]
pub async fn sync_password_change_release_locks(
    change: State<'_, Arc<PasswordChange>>,
) -> Result<SyncOperationResult, CommandError> {
    Ok(change.release_locks().await.into())
}

/// The data files the stored password does not open; empty without
/// credentials. A refusal or a Drive failure is the command's error.
#[tauri::command]
pub async fn sync_list_undecryptable(
    preflight: State<'_, Arc<Preflight>>,
) -> Result<Vec<UndecryptableFile>, CommandError> {
    Ok(list_undecryptable_files(&preflight, &EnvelopeCrypto).await?)
}

#[cfg(test)]
mod tests {
    use pipette_sync::password::change_error::ChangeErrorKey;
    use pipette_sync::preflight::PreflightError;
    use pipette_sync_runtime::SyncCredentialFailureReason;
    use serde_json::json;

    use super::*;

    #[test]
    fn answers_as_wrap_ipc_does() {
        let json = |result: Result<(), PasswordChangeError>| {
            serde_json::to_value(SyncOperationResult::from(result)).unwrap()
        };
        assert_eq!(json(Ok(())), json!({ "success": true }));
        assert_eq!(
            json(Err(ChangeErrorKey::LockLost.into())),
            json!({ "success": false, "error": "sync.passwordChange.lockLost" })
        );
        assert_eq!(
            json(Err(PreflightError::Credential(SyncCredentialFailureReason::NoPasswordFile).into())),
            json!({ "success": false, "error": "sync.changePasswordError.noPasswordFile", "reason": "noPasswordFile" })
        );
        let deleted = DeleteUndecryptableResult { deleted: vec!["a".into()], skipped: vec![] };
        assert_eq!(
            serde_json::to_value(PasswordChangeDeleteResult::from(Ok(deleted))).unwrap(),
            json!({ "success": true, "deleted": ["a"], "skipped": [] })
        );
    }

    #[test]
    fn takes_only_a_list_of_ids() {
        assert_eq!(file_ids(&json!(["a", "b"])), Some(vec!["a".to_owned(), "b".to_owned()]));
        for bad in [json!([]), json!(["a", ""]), json!(["a", 1]), json!("a"), json!(null)] {
            assert_eq!(file_ids(&bad), None, "{bad}");
        }
    }

    #[test]
    fn the_status_has_the_shape_of_password_change_status() {
        use pipette_sync::password::change::PasswordChangeFile;
        use pipette_sync::password::state::{ChangeKeysFailure, ChangeStep, ChangeTarget};
        let progress = PasswordChangeStatus::InProgress {
            target: ChangeTarget::Old,
            step: ChangeStep::Reencrypting,
            started_at: 5.0,
            lock_lost: true,
            undecryptable: Some(vec![PasswordChangeFile { id: "f".into(), name: "n".into() }]),
        };
        assert_eq!(
            serde_json::to_value(progress).unwrap(),
            json!({ "kind": "inProgress", "target": "old", "step": "reencrypting", "startedAt": 5.0, "lockLost": true, "undecryptable": [{ "id": "f", "name": "n" }] })
        );
        let quiet = PasswordChangeStatus::InProgress {
            target: ChangeTarget::New,
            step: ChangeStep::Committing,
            started_at: 5.0,
            lock_lost: false,
            undecryptable: None,
        };
        assert_eq!(
            serde_json::to_value(quiet).unwrap(),
            json!({ "kind": "inProgress", "target": "new", "step": "committing", "startedAt": 5.0 })
        );
        let keys = PasswordChangeStatus::KeysUnavailable {
            reason: ChangeKeysFailure::InvalidContent,
            target: ChangeTarget::New,
            step: ChangeStep::Locking,
            started_at: 5.0,
        };
        assert_eq!(
            serde_json::to_value(keys).unwrap(),
            json!({ "kind": "keysUnavailable", "reason": "invalidContent", "target": "new", "step": "locking", "startedAt": 5.0 })
        );
        assert_eq!(serde_json::to_value(PasswordChangeStatus::None).unwrap(), json!({ "kind": "none" }));
    }

    #[tokio::test]
    async fn the_quit_phase_stops_a_running_change_and_waits_for_it() {
        let runtime = SyncRuntime::new();
        let run = runtime.try_start_password_change().unwrap();
        let watcher = runtime.clone();
        let ender = tokio::spawn(async move {
            watcher.quitting().await;
            drop(run);
        });
        quit_phase(runtime.clone(), "passwordChange").run.await;
        assert!(runtime.is_quitting() && !runtime.password_change_running());
        ender.await.unwrap();
        // Without a change it ends at once.
        quit_phase(SyncRuntime::new(), "passwordChange").run.await;
    }
}
