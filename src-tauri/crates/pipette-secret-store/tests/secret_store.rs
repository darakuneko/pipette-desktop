// SPDX-License-Identifier: GPL-2.0-or-later
//! The secret files on a temporary userData with an in-memory key store:
//! the status of each state of the file and the key store against the
//! recorded golden (tests/fixtures/ts_secret_status.json), the writes, the
//! record of the key's account name (`local/auth/key-account`) that keeps the
//! secrets readable when the userData directory moves, and that the 0.4
//! build's `*.enc` files are neither read nor written.

#![allow(clippy::unwrap_used)]

use std::path::{Path, PathBuf};
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

/// A store on `user_data` with a fresh process's empty memory of the key.
fn fresh_store_on(user_data: &Path, keystore: &Arc<MemoryKeystore>) -> SecretStore {
    let store = store_on(user_data, keystore);
    store.master_key().forget();
    store
}

fn record_path(user_data: &Path) -> PathBuf {
    user_data.join("local/auth/key-account")
}

/// The account name recorded in `user_data`, `None` without a record.
fn recorded(user_data: &Path) -> Option<String> {
    std::fs::read_to_string(record_path(user_data)).ok().map(|text| text.trim().to_owned())
}

fn write_record(user_data: &Path, text: &str) {
    std::fs::create_dir_all(user_data.join("local/auth")).unwrap();
    std::fs::write(record_path(user_data), text).unwrap();
}

/// Copies the files of `local/auth/` from one userData directory to another.
fn copy_auth_dir(from: &Path, to: &Path) {
    let target = to.join("local/auth");
    std::fs::create_dir_all(&target).unwrap();
    for entry in std::fs::read_dir(from.join("local/auth")).unwrap() {
        let entry = entry.unwrap();
        std::fs::copy(entry.path(), target.join(entry.file_name())).unwrap();
    }
}

async fn opens(store: &SecretStore, kind: SecretKind, secret: &str) {
    assert_eq!(store.retrieve_string(kind).await.as_deref().map(String::as_str), Ok(secret), "{kind:?}");
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
    let store = store_on(user_data, &keystore);
    // The masters of one key store share the key in memory; a new process
    // starts without it.
    store.master_key().forget();
    store
}

#[tokio::test]
async fn reports_the_status_in_the_recorded_order() {
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
    // No temp file is left next to it or the record.
    let mut names: Vec<String> = std::fs::read_dir(store.auth_dir())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, ["key-account", "tauri-sync-password.bin"]);
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
async fn never_reads_or_writes_the_0_4_files() {
    let dir = tempfile::tempdir().unwrap();
    let auth = dir.path().join("local/auth");
    std::fs::create_dir_all(&auth).unwrap();
    let v04_files = ["oauth-tokens.enc", "sync-password.enc", "sync-password-change-keys.enc"];
    for name in v04_files {
        std::fs::write(auth.join(name), format!("0.4 {name}")).unwrap();
    }
    let keystore = Arc::new(MemoryKeystore::default());
    let store = store_on(dir.path(), &keystore);
    for kind in SecretKind::ALL {
        assert_eq!(store.retrieve(kind).await.err(), Some(SecretFailure::NoPasswordFile), "{kind:?}");
        store.store(kind, b"tauri").await.unwrap();
        store.clear(kind).await.unwrap();
    }
    for name in v04_files {
        assert_eq!(std::fs::read_to_string(auth.join(name)).unwrap(), format!("0.4 {name}"));
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
    // A secret file copied without its record into a directory with a
    // record of its own does not open there.
    let other = fresh_store_on(second.path(), &keystore);
    std::fs::copy(
        store_on(first.path(), &keystore).path(SecretKind::SyncPassword),
        other.path(SecretKind::SyncPassword),
    )
    .unwrap();
    assert_eq!(other.retrieve(SecretKind::SyncPassword).await.err(), Some(SecretFailure::DecryptFailed));
}

#[tokio::test]
async fn a_new_store_records_the_account_of_its_path() {
    let dir = tempfile::tempdir().unwrap();
    let keystore = Arc::new(MemoryKeystore::default());
    let store = store_on(dir.path(), &keystore);
    // Neither the construction nor a read writes the record.
    assert_eq!(store.retrieve(SecretKind::SyncPassword).await.err(), Some(SecretFailure::NoPasswordFile));
    assert_eq!(recorded(dir.path()), None);
    store.store(SecretKind::SyncPassword, b"hunter2").await.unwrap();
    assert_eq!(recorded(dir.path()), Some(key_account(dir.path())));
    assert_eq!(store.master_key().account(), key_account(dir.path()));
}

#[tokio::test]
async fn existing_secret_files_without_a_record_get_one_when_the_store_is_made() {
    let dir = tempfile::tempdir().unwrap();
    let keystore = Arc::new(MemoryKeystore::default());
    store_on(dir.path(), &keystore).store(SecretKind::OauthTokens, b"tokens").await.unwrap();
    std::fs::remove_file(record_path(dir.path())).unwrap();
    let store = fresh_store_on(dir.path(), &keystore);
    assert_eq!(recorded(dir.path()), Some(key_account(dir.path())));
    opens(&store, SecretKind::OauthTokens, "tokens").await;
}

#[tokio::test]
async fn no_record_is_written_without_secret_files() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("local/auth")).unwrap();
    std::fs::write(dir.path().join("local/auth/sync-password-change.json"), "{}").unwrap();
    std::fs::write(dir.path().join("local/auth/oauth-tokens.enc"), "0.4").unwrap();
    let keystore = Arc::new(MemoryKeystore::default());
    store_on(dir.path(), &keystore);
    assert_eq!(recorded(dir.path()), None);
}

#[tokio::test]
async fn a_renamed_user_data_directory_keeps_its_secrets() {
    let root = tempfile::tempdir().unwrap();
    let before = root.path().join("before");
    let after = root.path().join("after");
    let keystore = Arc::new(MemoryKeystore::default());
    let store = store_on(&before, &keystore);
    store.store(SecretKind::SyncPassword, b"hunter2").await.unwrap();
    store.store(SecretKind::OauthTokens, b"tokens").await.unwrap();
    let account = key_account(&before);
    drop(store);
    std::fs::rename(&before, &after).unwrap();
    let moved = fresh_store_on(&after, &keystore);
    assert_eq!(moved.master_key().account(), account);
    assert_ne!(account, key_account(&after));
    opens(&moved, SecretKind::SyncPassword, "hunter2").await;
    opens(&moved, SecretKind::OauthTokens, "tokens").await;
}

#[tokio::test]
async fn a_copied_user_data_directory_opens_in_both_places() {
    let original = tempfile::tempdir().unwrap();
    let copy = tempfile::tempdir().unwrap();
    let keystore = Arc::new(MemoryKeystore::default());
    store_on(original.path(), &keystore).store(SecretKind::SyncPassword, b"hunter2").await.unwrap();
    copy_auth_dir(original.path(), copy.path());
    opens(&fresh_store_on(original.path(), &keystore), SecretKind::SyncPassword, "hunter2").await;
    opens(&fresh_store_on(copy.path(), &keystore), SecretKind::SyncPassword, "hunter2").await;
}

#[tokio::test]
async fn a_record_that_cannot_be_read_closes_the_store() {
    // A record that is no file, and one that is not a single line.
    for unreadable in [None, Some("local-auth-key/0011223344556677\nsecond line")] {
        let dir = tempfile::tempdir().unwrap();
        match unreadable {
            None => std::fs::create_dir_all(record_path(dir.path())).unwrap(),
            Some(text) => write_record(dir.path(), text),
        }
        let keystore = Arc::new(MemoryKeystore::default());
        let store = store_on(dir.path(), &keystore);
        let err = store.store(SecretKind::SyncPassword, b"hunter2").await.unwrap_err();
        assert!(matches!(err, StoreError::AccountUnreadable), "{err}");
        assert!(!store.path(SecretKind::SyncPassword).exists());
        assert_eq!(
            store.retrieve(SecretKind::SyncPassword).await.err(),
            Some(SecretFailure::KeystoreUnavailable)
        );
        assert_eq!(
            store.retrieve_string(SecretKind::SyncPassword).await.err(),
            Some(SecretFailure::KeystoreUnavailable)
        );
        assert!(matches!(
            store.read_if_present(SecretKind::SyncPassword).await,
            Err(ReadError::KeystoreUnavailable)
        ));
        match unreadable {
            None => assert!(record_path(dir.path()).is_dir()),
            Some(text) => assert_eq!(std::fs::read_to_string(record_path(dir.path())).unwrap(), text),
        }
        assert_eq!(keystore.secret(&key_account(dir.path())), None);
    }
}

#[tokio::test]
async fn a_closed_store_deletes_no_key_store_entry() {
    let dir = tempfile::tempdir().unwrap();
    let keystore = Arc::new(MemoryKeystore::default());
    // The key of a directory moved or copied from this path, under the
    // path's name.
    store_on(dir.path(), &keystore).store(SecretKind::SyncPassword, b"hunter2").await.unwrap();
    let account = key_account(dir.path());
    let key = keystore.secret(&account).unwrap();
    std::fs::remove_file(record_path(dir.path())).unwrap();
    std::fs::create_dir_all(record_path(dir.path())).unwrap();
    let closed = fresh_store_on(dir.path(), &keystore);
    closed.delete_key().await.unwrap();
    assert_eq!(keystore.secret(&account), Some(key));
}

#[tokio::test]
async fn an_empty_record_is_the_account_of_the_path_and_is_written_on_a_store() {
    let dir = tempfile::tempdir().unwrap();
    write_record(dir.path(), " \n");
    let keystore = Arc::new(MemoryKeystore::default());
    let store = store_on(dir.path(), &keystore);
    assert_eq!(store.master_key().account(), key_account(dir.path()));
    store.store(SecretKind::SyncPassword, b"hunter2").await.unwrap();
    assert_eq!(recorded(dir.path()), Some(key_account(dir.path())));
}

#[tokio::test]
async fn a_record_of_another_form_is_used_as_it_is_and_never_rewritten() {
    let dir = tempfile::tempdir().unwrap();
    write_record(dir.path(), "  some-future-account \n");
    let keystore = Arc::new(MemoryKeystore::default());
    let store = store_on(dir.path(), &keystore);
    assert_eq!(store.master_key().account(), "some-future-account");
    store.store(SecretKind::SyncPassword, b"hunter2").await.unwrap();
    assert_eq!(std::fs::read_to_string(record_path(dir.path())).unwrap(), "  some-future-account \n");
    assert!(keystore.secret("some-future-account").is_some());
    assert_eq!(keystore.secret(&key_account(dir.path())), None);
    opens(&fresh_store_on(dir.path(), &keystore), SecretKind::SyncPassword, "hunter2").await;
}

#[tokio::test]
async fn a_sign_in_after_a_reset_in_a_moved_directory_opens_in_the_next_process() {
    let root = tempfile::tempdir().unwrap();
    let before = root.path().join("before");
    let after = root.path().join("after");
    let keystore = Arc::new(MemoryKeystore::default());
    store_on(&before, &keystore).store(SecretKind::OauthTokens, b"old").await.unwrap();
    let account = key_account(&before);
    std::fs::rename(&before, &after).unwrap();
    let moved = fresh_store_on(&after, &keystore);
    // Reset Local Data of App Settings: all of `local/auth/`, then the key.
    std::fs::remove_dir_all(after.join("local/auth")).unwrap();
    moved.delete_key().await.unwrap();
    assert_eq!(keystore.secret(&account), None);
    moved.store(SecretKind::OauthTokens, b"new").await.unwrap();
    assert_eq!(recorded(&after), Some(account));
    opens(&fresh_store_on(&after, &keystore), SecretKind::OauthTokens, "new").await;
}
