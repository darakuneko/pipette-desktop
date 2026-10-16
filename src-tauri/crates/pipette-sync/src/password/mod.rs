// SPDX-License-Identifier: GPL-2.0-or-later
//! The sync password: the guard against a password change in progress
//! ([`guard`]) and the password-check ([`check`]) every pass runs, and the
//! password change ([`change`], with its re-encryption in [`switch`], this
//! machine's state and keys in [`state`] and the Drive lock in [`lock`]
//! and [`lock_release`]).

use pipette_secret_store::{SecretFailure, SecretKind, SecretStore};
use pipette_sync_runtime::SyncCredentialFailureReason;
use zeroize::Zeroizing;

use crate::preflight::{BoxFuture, PasswordStore};

pub mod change;
pub mod change_error;
pub mod check;
pub mod guard;
pub mod lock;
pub mod lock_release;
pub mod state;
mod switch;

fn reason(failure: SecretFailure) -> SyncCredentialFailureReason {
    match failure {
        SecretFailure::KeystoreUnavailable => SyncCredentialFailureReason::KeystoreUnavailable,
        SecretFailure::NoPasswordFile => SyncCredentialFailureReason::NoPasswordFile,
        SecretFailure::DecryptFailed => SyncCredentialFailureReason::DecryptFailed,
    }
}

/// The sync password in the secret store's `SyncPassword` file.
impl PasswordStore for SecretStore {
    fn retrieve(&self) -> BoxFuture<'_, Result<Zeroizing<String>, SyncCredentialFailureReason>> {
        Box::pin(async move { self.retrieve_string(SecretKind::SyncPassword).await.map_err(reason) })
    }

    fn store<'a>(&'a self, password: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            SecretStore::store(self, SecretKind::SyncPassword, password.as_bytes())
                .await
                .map_err(|err| err.to_string())
        })
    }

    fn clear(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if let Err(err) = SecretStore::clear(self, SecretKind::SyncPassword).await {
                log::warn!("sync password: cannot remove the stored password: {err}");
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use pipette_secret_store::MemoryKeystore;

    use super::*;

    #[tokio::test]
    async fn the_secret_store_keeps_the_password_with_the_local_reasons() {
        let dir = tempfile::tempdir().unwrap();
        let keystore = Arc::new(MemoryKeystore::default());
        let secrets = SecretStore::new(dir.path(), keystore);
        let store: &dyn PasswordStore = &secrets;
        assert_eq!(store.retrieve().await.err(), Some(SyncCredentialFailureReason::NoPasswordFile));
        store.store("pw").await.unwrap();
        assert_eq!(store.retrieve().await.unwrap().as_str(), "pw");
        let other = SecretStore::new(dir.path(), Arc::new(MemoryKeystore::default()));
        assert_eq!(
            PasswordStore::retrieve(&other).await.err(),
            Some(SyncCredentialFailureReason::DecryptFailed)
        );
        let unavailable = Arc::new(MemoryKeystore::default());
        unavailable.set_unavailable(true);
        let locked = SecretStore::new(dir.path(), unavailable);
        assert_eq!(
            PasswordStore::retrieve(&locked).await.err(),
            Some(SyncCredentialFailureReason::KeystoreUnavailable)
        );
        assert_eq!(
            PasswordStore::store(&locked, "x").await.unwrap_err(),
            "OS keychain encryption is not available"
        );
        store.clear().await;
        assert_eq!(store.retrieve().await.err(), Some(SyncCredentialFailureReason::NoPasswordFile));
    }
}
