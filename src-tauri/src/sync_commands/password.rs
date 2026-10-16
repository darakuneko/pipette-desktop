// SPDX-License-Identifier: GPL-2.0-or-later
//! The sync password (src/main/sync/sync-ipc.ts): its status
//! (`storedPasswordStatus` of src/main/sync/sync-crypto.ts), the first set,
//! the re-enter of a password changed on another machine, and whether
//! Drive has a password-check. The password never leaves the backend.

use std::sync::Arc;

use pipette_secret_store::{SecretFailure, SecretKind, SecretStore};
use pipette_sync::preflight::Preflight;
use serde::Serialize;
use tauri::State;
use ts_rs::TS;
use zeroize::Zeroizing;

use super::SyncSecrets;
use super::result::SyncOperationResult;
use crate::command_error::CommandError;

/// `StoredPasswordStatus` of src/shared/types/sync.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum StoredPasswordStatus {
    Readable,
    NoPasswordFile,
    DecryptFailed,
    KeystoreUnavailable,
}

impl From<SecretFailure> for StoredPasswordStatus {
    fn from(failure: SecretFailure) -> Self {
        match failure {
            SecretFailure::KeystoreUnavailable => Self::KeystoreUnavailable,
            SecretFailure::NoPasswordFile => Self::NoPasswordFile,
            SecretFailure::DecryptFailed => Self::DecryptFailed,
        }
    }
}

/// Whether the stored password can be read, never the password itself.
pub async fn stored_password_status(secrets: &SecretStore) -> StoredPasswordStatus {
    match secrets.retrieve(SecretKind::SyncPassword).await {
        Ok(_) => StoredPasswordStatus::Readable,
        Err(failure) => failure.into(),
    }
}

#[tauri::command]
pub async fn sync_password_status(
    sync: State<'_, SyncSecrets>,
) -> Result<StoredPasswordStatus, CommandError> {
    Ok(stored_password_status(&sync.secrets).await)
}

/// Sets the first sync password (`setPasswordAndValidate`): stored once
/// it opens the password-check on Drive, which is created (after the
/// sync-format marker) when Drive has none.
#[tauri::command]
pub async fn sync_set_password(
    preflight: State<'_, Arc<Preflight>>,
    password: String,
) -> Result<SyncOperationResult, CommandError> {
    let password = Zeroizing::new(password);
    Ok(preflight.set_password_and_validate(&password).await.into())
}

/// Replaces the stored password with one changed on another machine
/// (`replacePasswordAndValidate`): stored only once it opens the
/// password-check on Drive.
#[tauri::command]
pub async fn sync_replace_password(
    preflight: State<'_, Arc<Preflight>>,
    password: String,
) -> Result<SyncOperationResult, CommandError> {
    let password = Zeroizing::new(password);
    if password.is_empty() {
        return Ok(SyncOperationResult::failure("Invalid password".to_owned(), None));
    }
    Ok(preflight.replace_password_and_validate(&password).await.into())
}

/// Whether Drive has a password-check (`checkPasswordCheckExists`); a
/// Drive failure is the command's error.
#[tauri::command]
pub async fn sync_check_password_exists(preflight: State<'_, Arc<Preflight>>) -> Result<bool, CommandError> {
    Ok(preflight.password_check_exists().await?)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use pipette_secret_store::MemoryKeystore;

    use super::*;

    #[tokio::test]
    async fn answers_the_status_without_the_password() {
        let dir = tempfile::tempdir().unwrap();
        let keystore = Arc::new(MemoryKeystore::default());
        let secrets = SecretStore::new(dir.path(), keystore.clone());
        assert_eq!(stored_password_status(&secrets).await, StoredPasswordStatus::NoPasswordFile);
        secrets.store(SecretKind::SyncPassword, b"hunter2").await.unwrap();
        assert_eq!(stored_password_status(&secrets).await, StoredPasswordStatus::Readable);
        assert_eq!(serde_json::to_value(StoredPasswordStatus::Readable).unwrap(), "readable");
        let fresh = SecretStore::new(dir.path(), Arc::new(MemoryKeystore::default()));
        assert_eq!(stored_password_status(&fresh).await, StoredPasswordStatus::DecryptFailed);
        let unavailable = Arc::new(MemoryKeystore::default());
        unavailable.set_unavailable(true);
        let locked = SecretStore::new(dir.path(), unavailable);
        assert_eq!(stored_password_status(&locked).await, StoredPasswordStatus::KeystoreUnavailable);
        assert_eq!(
            serde_json::to_value(StoredPasswordStatus::KeystoreUnavailable).unwrap(),
            "keystoreUnavailable"
        );
    }
}
