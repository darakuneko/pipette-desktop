// SPDX-License-Identifier: GPL-2.0-or-later
//! The OS key store itself: creates, reads and deletes an entry under a
//! service of its own, and keeps a secret file through it. It touches the
//! key store of the session it runs in, so it runs only when
//! `PIPETTE_KEYSTORE_IT` says what to expect:
//!   - `available`: the key store answers (the CI jobs on macOS and
//!     Windows, and on Linux a Secret Service of its own);
//!   - `unavailable`: there is none (on Linux, a session bus without a
//!     Secret Service, or no session bus).
//!
//! On Linux it also needs `PIPETTE_KEYSTORE_IT_ISOLATED=1`, which
//! scripts/keystore-it-linux.sh sets inside a `dbus-run-session` with a
//! temporary home and a Secret Service started for the run, so the test
//! never reaches a desktop session's key store.

#![allow(clippy::unwrap_used)]

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use pipette_secret_store::{Keystore, KeystoreError, OsKeystore, SecretFailure, SecretKind, SecretStore};

/// Not the app's service, so a run never touches the app's master keys.
const SERVICE: &str = "app.pipette.desktop.keystore-test";

/// What the run expects, or `None` to skip.
fn expectation() -> Option<String> {
    let expected = std::env::var("PIPETTE_KEYSTORE_IT").ok()?;
    if cfg!(target_os = "linux") && std::env::var("PIPETTE_KEYSTORE_IT_ISOLATED").as_deref() != Ok("1") {
        panic!("on Linux the key store test runs only through scripts/keystore-it-linux.sh");
    }
    Some(expected)
}

fn account() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_nanos()).unwrap_or(0);
    format!("it/{}-{nanos}", std::process::id())
}

/// Deletes the entry when the test ends, however it ends.
struct Cleanup<'a>(&'a OsKeystore, &'a str);

impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        let _ = self.0.delete(self.1);
    }
}

#[test]
fn the_os_key_store_creates_reads_and_deletes_an_entry() {
    let Some(expected) = expectation() else {
        eprintln!("skipped: PIPETTE_KEYSTORE_IT is not set");
        return;
    };
    let keystore = OsKeystore::new(SERVICE);
    let account = account();
    match expected.as_str() {
        "available" => {
            let _cleanup = Cleanup(&keystore, &account);
            assert_eq!(keystore.read(&account).unwrap(), None);
            let secret: Vec<u8> = (0u8..32).collect();
            keystore.write(&account, &secret).unwrap();
            assert_eq!(keystore.read(&account).unwrap().as_deref(), Some(&secret));
            keystore.write(&account, &[7; 32]).unwrap();
            assert_eq!(
                keystore.read(&account).unwrap().as_deref().map(Vec::as_slice),
                Some([7u8; 32].as_slice())
            );
            keystore.delete(&account).unwrap();
            assert_eq!(keystore.read(&account).unwrap(), None);
            keystore.delete(&account).unwrap();
        }
        "unavailable" => {
            assert!(matches!(keystore.read(&account), Err(KeystoreError::Unavailable(_))));
            assert!(matches!(keystore.write(&account, &[1; 32]), Err(KeystoreError::Unavailable(_))));
        }
        other => panic!("PIPETTE_KEYSTORE_IT must be available or unavailable, not {other}"),
    }
}

#[tokio::test]
async fn a_secret_file_keeps_its_secret_through_the_os_key_store() {
    let Some(expected) = expectation() else {
        eprintln!("skipped: PIPETTE_KEYSTORE_IT is not set");
        return;
    };
    let user_data = tempfile::tempdir().unwrap();
    let keystore = Arc::new(OsKeystore::new(SERVICE));
    let store = SecretStore::with_timeout(user_data.path(), keystore.clone(), Duration::from_secs(30));
    let account = store.master_key().account().to_owned();
    let _cleanup = Cleanup(&keystore, &account);
    match expected.as_str() {
        "available" => {
            assert_eq!(
                store.retrieve(SecretKind::SyncPassword).await.err(),
                Some(SecretFailure::NoPasswordFile)
            );
            store.store(SecretKind::SyncPassword, b"hunter2").await.unwrap();
            let again =
                SecretStore::with_timeout(user_data.path(), keystore.clone(), Duration::from_secs(30));
            assert_eq!(
                again.retrieve_string(SecretKind::SyncPassword).await.as_deref().map(String::as_str),
                Ok("hunter2")
            );
            again.master_key().delete().await.unwrap();
            assert_eq!(keystore.read(&account).unwrap(), None);
        }
        _ => {
            assert_eq!(
                store.retrieve(SecretKind::SyncPassword).await.err(),
                Some(SecretFailure::KeystoreUnavailable)
            );
            assert!(store.store(SecretKind::SyncPassword, b"hunter2").await.is_err());
            assert!(!store.path(SecretKind::SyncPassword).exists());
        }
    }
}
