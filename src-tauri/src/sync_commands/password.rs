// SPDX-License-Identifier: GPL-2.0-or-later
//! The stored sync password's status (`syncPasswordStatus`,
//! `storedPasswordStatus` of src/main/sync/sync-crypto.ts). The password
//! itself never leaves the backend.

use pipette_secret_store::{SecretFailure, SecretKind, SecretStore};
use serde::Serialize;
use tauri::State;
use ts_rs::TS;

use super::SyncSecrets;
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
