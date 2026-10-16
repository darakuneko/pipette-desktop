// SPDX-License-Identifier: GPL-2.0-or-later
//! The secret files on a temporary userData with an in-memory key store:
//! the status of each state of the file and the key store in the order of
//! `retrieveSecretFile` (tests/fixtures/ts_secret_status.json, recorded
//! from the Electron main process by
//! scripts/sync-fixtures/record-secrets-auth.test.ts), the writes, and that
//! Electron's `*.enc` files are neither read nor written.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use pipette_secret_store::{
    MemoryKeystore, ReadError, SecretFailure, SecretKind, SecretStore, StoreError, key_account,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusRow {
    file: String,
    keystore_available: bool,
    status: String,
}

fn status_name(result: &Result<zeroize::Zeroizing<Vec<u8>>, SecretFailure>) -> String {
    match result {
        Ok(_) => "readable".to_owned(),
        Err(failure) => failure.to_string(),
    }
}

fn store_on(user_data: &Path, keystore: &Arc<MemoryKeystore>) -> SecretStore {
    SecretStore::with_timeout(user_data, keystore.clone(), Duration::from_secs(5))
}

/// A secret store whose `sync-password` file is in the state `file`
/// (`missing`, `opens`, `damaged`), with a fresh process's empty memory and
/// the key store `available` or not.
async fn store_in_state(user_data: &Path, file: &str, available: bool) -> SecretStore {
    let keystore = Arc::new(MemoryKeystore::default());
    let writer = store_on(user_data, &keystore);
    match file {
        "missing" => {}
        "opens" => writer.store(SecretKind::SyncPassword, b"hunter2").await.unwrap(),
        "damaged" => {
            writer.store(SecretKind::SyncPassword, b"hunter2").await.unwrap();
            std::fs::write(writer.path(SecretKind::SyncPassword), b"not sealed").unwrap();
        }
        other => panic!("unknown file state {other}"),
    }
    keystore.set_unavailable(!available);
    store_on(user_data, &keystore)
}

#[tokio::test]
async fn reports_the_status_in_the_order_of_electron() {
    let rows: Vec<StatusRow> = serde_json::from_str(include_str!("fixtures/ts_secret_status.json")).unwrap();
    assert_eq!(rows.len(), 5);
    for row in rows {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in_state(dir.path(), &row.file, row.keystore_available).await;
        let result = store.retrieve(SecretKind::SyncPassword).await;
        assert_eq!(status_name(&result), row.status, "{} / available {}", row.file, row.keystore_available);
    }
}

#[tokio::test]
async fn a_file_that_would_open_is_unavailable_while_the_key_store_does_not_answer() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in_state(dir.path(), "opens", false).await;
    assert_eq!(
        store.retrieve(SecretKind::SyncPassword).await.err(),
        Some(SecretFailure::KeystoreUnavailable)
    );
}

#[tokio::test]
async fn a_key_read_before_keeps_the_file_readable_when_the_key_store_stops_answering() {
    let dir = tempfile::tempdir().unwrap();
    let keystore = Arc::new(MemoryKeystore::default());
    let store = store_on(dir.path(), &keystore);
    store.store(SecretKind::SyncPassword, b"hunter2").await.unwrap();
    keystore.set_unavailable(true);
    assert_eq!(
        store.retrieve_string(SecretKind::SyncPassword).await.as_deref().map(String::as_str),
        Ok("hunter2")
    );
}

#[tokio::test]
async fn a_file_without_its_key_does_not_open() {
    let dir = tempfile::tempdir().unwrap();
    let keystore = Arc::new(MemoryKeystore::default());
    store_on(dir.path(), &keystore).store(SecretKind::SyncPassword, b"hunter2").await.unwrap();
    // The entry of another userData directory, or one removed by hand.
    let fresh = Arc::new(MemoryKeystore::default());
    let store = store_on(dir.path(), &fresh);
    assert_eq!(store.retrieve(SecretKind::SyncPassword).await.err(), Some(SecretFailure::DecryptFailed));
    assert!(matches!(store.read_if_present(SecretKind::SyncPassword).await, Err(ReadError::DecryptFailed)));
    // A new key replaces nothing until a secret is stored with it.
    assert_eq!(fresh.secret(&key_account(dir.path())), None);
}

#[tokio::test]
async fn a_file_opens_only_as_its_own_kind() {
    let dir = tempfile::tempdir().unwrap();
    let keystore = Arc::new(MemoryKeystore::default());
    let store = store_on(dir.path(), &keystore);
    store.store(SecretKind::SyncPassword, b"hunter2").await.unwrap();
    std::fs::copy(store.path(SecretKind::SyncPassword), store.path(SecretKind::OauthTokens)).unwrap();
    assert_eq!(store.retrieve(SecretKind::OauthTokens).await.err(), Some(SecretFailure::DecryptFailed));
}

#[tokio::test]
async fn a_write_needs_the_key_store_and_never_writes_plain_text() {
    let dir = tempfile::tempdir().unwrap();
    let keystore = Arc::new(MemoryKeystore::default());
    keystore.set_unavailable(true);
    let store = store_on(dir.path(), &keystore);
    let err = store.store(SecretKind::SyncPassword, b"hunter2").await.unwrap_err();
    assert!(matches!(err, StoreError::KeystoreUnavailable));
    assert_eq!(err.to_string(), "OS keychain encryption is not available");
    assert!(!store.path(SecretKind::SyncPassword).exists());
}

#[tokio::test]
async fn writes_a_sealed_file_with_a_new_nonce_each_time() {
    let dir = tempfile::tempdir().unwrap();
    let keystore = Arc::new(MemoryKeystore::default());
    let store = store_on(dir.path(), &keystore);
    store.store(SecretKind::SyncPassword, b"hunter2").await.unwrap();
    let first = std::fs::read(store.path(SecretKind::SyncPassword)).unwrap();
    store.store(SecretKind::SyncPassword, b"hunter2").await.unwrap();
    let second = std::fs::read(store.path(SecretKind::SyncPassword)).unwrap();
    assert!(first.starts_with(b"PTS1"));
    assert!(!first.windows(7).any(|window| window == b"hunter2"));
    assert_ne!(first[4..16], second[4..16]);
    // No temp file is left next to it.
    let names: Vec<String> = std::fs::read_dir(store.auth_dir())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["tauri-sync-password.bin"]);
}

#[tokio::test]
async fn clear_removes_the_file_and_a_missing_file_is_no_error() {
    let dir = tempfile::tempdir().unwrap();
    let keystore = Arc::new(MemoryKeystore::default());
    let store = store_on(dir.path(), &keystore);
    store.store(SecretKind::SyncPassword, b"hunter2").await.unwrap();
    store.clear(SecretKind::SyncPassword).await.unwrap();
    store.clear(SecretKind::SyncPassword).await.unwrap();
    assert_eq!(store.retrieve(SecretKind::SyncPassword).await.err(), Some(SecretFailure::NoPasswordFile));
    assert_eq!(store.read_if_present(SecretKind::SyncPassword).await.unwrap(), None);
}

#[tokio::test]
async fn never_reads_or_writes_the_electron_files() {
    let dir = tempfile::tempdir().unwrap();
    let auth = dir.path().join("local/auth");
    std::fs::create_dir_all(&auth).unwrap();
    let electron = ["oauth-tokens.enc", "sync-password.enc", "sync-password-change-keys.enc"];
    for name in electron {
        std::fs::write(auth.join(name), format!("electron {name}")).unwrap();
    }
    let keystore = Arc::new(MemoryKeystore::default());
    let store = store_on(dir.path(), &keystore);
    for kind in SecretKind::ALL {
        assert_eq!(store.retrieve(kind).await.err(), Some(SecretFailure::NoPasswordFile), "{kind:?}");
        store.store(kind, b"tauri").await.unwrap();
        store.clear(kind).await.unwrap();
    }
    for name in electron {
        assert_eq!(std::fs::read_to_string(auth.join(name)).unwrap(), format!("electron {name}"));
    }
}

#[tokio::test]
async fn another_user_data_directory_has_its_own_key() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let keystore = Arc::new(MemoryKeystore::default());
    store_on(first.path(), &keystore).store(SecretKind::SyncPassword, b"one").await.unwrap();
    store_on(second.path(), &keystore).store(SecretKind::SyncPassword, b"two").await.unwrap();
    let a = keystore.secret(&key_account(first.path())).unwrap();
    let b = keystore.secret(&key_account(second.path())).unwrap();
    assert_ne!(a, b);
    // A file moved to another userData directory does not open there.
    let moved = store_on(second.path(), &keystore);
    std::fs::copy(
        store_on(first.path(), &keystore).path(SecretKind::SyncPassword),
        moved.path(SecretKind::SyncPassword),
    )
    .unwrap();
    assert_eq!(moved.retrieve(SecretKind::SyncPassword).await.err(), Some(SecretFailure::DecryptFailed));
}
