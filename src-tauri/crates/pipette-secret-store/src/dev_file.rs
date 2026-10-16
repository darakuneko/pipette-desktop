// SPDX-License-Identifier: GPL-2.0-or-later
//! The key store of the e2e tests and CI in development builds:
//! `PIPETTE_DEV_KEYSTORE=file` keeps the master key in plain text in
//! [`DEV_KEYSTORE_FILE`] under the userData directory, so the tests never
//! reach the OS key store. Only the `dev-keystore` feature (the app's
//! development tools) has this code; src/lib.rs refuses it without debug
//! assertions.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use zeroize::Zeroizing;

use crate::keystore::{Keystore, KeystoreError, OsKeystore, UnavailableKeystore};

/// The variable that picks the key store of a development build.
pub const DEV_KEYSTORE_ENV: &str = "PIPETTE_DEV_KEYSTORE";

/// The key file, relative to the userData directory.
pub const DEV_KEYSTORE_FILE: &str = "local/dev-keystore.json";

/// The key store [`DEV_KEYSTORE_ENV`] picks for `user_data`: the key file
/// for `file`, the OS key store when it is unset, and for any other value
/// one that is never available (a mistyped setting must not fall through
/// to the OS key store).
pub fn dev_keystore_from_env(user_data: &Path, service: &str) -> Arc<dyn Keystore> {
    pick(std::env::var_os(DEV_KEYSTORE_ENV), user_data, service)
}

fn pick(value: Option<std::ffi::OsString>, user_data: &Path, service: &str) -> Arc<dyn Keystore> {
    match value {
        None => Arc::new(OsKeystore::new(service)),
        Some(value) if value == "file" => Arc::new(FileKeystore::new(user_data.join(DEV_KEYSTORE_FILE))),
        Some(value) => {
            log::error!(
                "[secret-store] {DEV_KEYSTORE_ENV}={value:?} is not `file`; the key store is unavailable"
            );
            Arc::new(UnavailableKeystore)
        }
    }
}

/// Secrets in a JSON file of account name → hex, written atomically and,
/// on Unix, readable by its owner only (mode 0600).
pub struct FileKeystore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl FileKeystore {
    pub fn new(path: PathBuf) -> Self {
        Self { path, lock: Mutex::new(()) }
    }

    fn load(&self) -> Result<BTreeMap<String, String>, KeystoreError> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|err| failed(&self.path, err)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(err) => Err(failed(&self.path, err)),
        }
    }

    fn save(&self, entries: &BTreeMap<String, String>) -> Result<(), KeystoreError> {
        let text = serde_json::to_vec_pretty(entries).map_err(|err| failed(&self.path, err))?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|err| failed(&self.path, err))?;
        }
        pipette_fs::write_file_atomic_private(&self.path, &text).map_err(|err| failed(&self.path, err))
    }

    fn update(&self, change: impl FnOnce(&mut BTreeMap<String, String>)) -> Result<(), KeystoreError> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let mut entries = self.load()?;
        change(&mut entries);
        self.save(&entries)
    }
}

fn failed(path: &Path, err: impl std::fmt::Display) -> KeystoreError {
    KeystoreError::Unavailable(format!("{}: {err}", path.display()))
}

impl Keystore for FileKeystore {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        match self.load()?.get(account) {
            None => Ok(None),
            Some(text) => hex::decode(text)
                .map(|bytes| Some(Zeroizing::new(bytes)))
                .map_err(|err| failed(&self.path, err)),
        }
    }

    fn write(&self, account: &str, secret: &[u8]) -> Result<(), KeystoreError> {
        self.update(|entries| {
            entries.insert(account.to_owned(), hex::encode(secret));
        })
    }

    fn delete(&self, account: &str) -> Result<(), KeystoreError> {
        self.update(|entries| {
            entries.remove(account);
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_secrets_per_account_across_instances() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DEV_KEYSTORE_FILE);
        let store = FileKeystore::new(path.clone());
        assert_eq!(store.read("a").unwrap(), None);
        store.write("a", &[1, 2, 3]).unwrap();
        store.write("b", &[4]).unwrap();
        let again = FileKeystore::new(path);
        assert_eq!(again.read("a").unwrap().as_deref().map(Vec::as_slice), Some([1u8, 2, 3].as_slice()));
        again.delete("a").unwrap();
        again.delete("missing").unwrap();
        assert_eq!(store.read("a").unwrap(), None);
        assert_eq!(store.read("b").unwrap().as_deref().map(Vec::as_slice), Some([4u8].as_slice()));
    }

    #[cfg(unix)]
    #[test]
    fn the_key_file_is_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DEV_KEYSTORE_FILE);
        FileKeystore::new(path.clone()).write("a", &[1]).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn the_variable_picks_the_key_file_and_refuses_unknown_values() {
        let dir = tempfile::tempdir().unwrap();
        let file = pick(Some("file".into()), dir.path(), "test.service");
        file.write("a", &[9]).unwrap();
        assert!(dir.path().join(DEV_KEYSTORE_FILE).is_file());
        let unknown = pick(Some("os".into()), dir.path(), "test.service");
        assert!(matches!(unknown.read("a"), Err(KeystoreError::Unavailable(_))));
    }

    #[test]
    fn a_damaged_file_is_an_unavailable_key_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("keys.json");
        std::fs::write(&path, b"not json").unwrap();
        assert!(matches!(FileKeystore::new(path).read("a"), Err(KeystoreError::Unavailable(_))));
    }
}
