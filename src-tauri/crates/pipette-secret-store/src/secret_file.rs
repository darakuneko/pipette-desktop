// SPDX-License-Identifier: GPL-2.0-or-later
//! The secret files of `local/auth/`: each secret encrypted with the master
//! key ([`crate::MasterKey`]) and written atomically.
//!
//! A file is [`FILE_MAGIC`], a 12-byte nonce drawn from the OS for every
//! write, and the AES-256-GCM ciphertext with its 16-byte tag. The
//! associated data is [`FILE_MAGIC`], the kind's name and the key's account
//! name, each followed by a NUL byte, so a file opens only as the kind it was
//! written as and only with the key of the account it was written under.
//!
//! The account name is recorded in the userData directory
//! ([`ACCOUNT_RECORD_FILE`]), so the secrets keep opening when the directory
//! is moved or copied: the key and the associated data both follow the
//! record, not the path. A directory without a record uses the name of its
//! path ([`key_account`]) and records it with the first secret it stores,
//! or when the store is made and secret files are already there. A record is
//! never rewritten, whatever name it holds. A record that cannot be read
//! closes the store for the process: it stores nothing and reads as
//! `keystoreUnavailable`, so no secret is written under a name the next
//! process would not use.
//!
//! The failure reason of a read: a file that cannot be read is
//! `keystoreUnavailable` when the key store does not answer and
//! `noPasswordFile` when it does; a file that does not open is
//! `keystoreUnavailable` when the key store does not answer and
//! `decryptFailed` when it does (no key, another key, a damaged file). A
//! write fails while the key store does not answer: a secret is never
//! written in plain text.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use zeroize::Zeroizing;

use crate::keystore::{Keystore, KeystoreError};
use crate::master_key::{KEYSTORE_TIMEOUT, Key, MasterKey, key_account};

/// The file of `local/auth/` that holds the account name of the master key:
/// one line, written once and never rewritten.
const ACCOUNT_RECORD_FILE: &str = "key-account";

/// The first bytes of every secret file.
pub const FILE_MAGIC: &[u8; 4] = b"PTS1";

const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// The secrets the sync keeps, one file each.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SecretKind {
    /// The Google tokens (the 0.4 build's `oauth-tokens.enc`).
    OauthTokens,
    /// The sync password (the 0.4 build's `sync-password.enc`).
    SyncPassword,
    /// The keys of a password change in progress (the 0.4 build's
    /// `sync-password-change-keys.enc`).
    SyncPasswordChangeKeys,
}

impl SecretKind {
    pub const ALL: [SecretKind; 3] =
        [SecretKind::OauthTokens, SecretKind::SyncPassword, SecretKind::SyncPasswordChangeKeys];

    /// The kind's name in the associated data.
    pub fn name(self) -> &'static str {
        match self {
            SecretKind::OauthTokens => "oauth-tokens",
            SecretKind::SyncPassword => "sync-password",
            SecretKind::SyncPasswordChangeKeys => "sync-password-change-keys",
        }
    }

    /// The file name under `local/auth/`.
    pub fn file_name(self) -> &'static str {
        match self {
            SecretKind::OauthTokens => "tauri-oauth-tokens.bin",
            SecretKind::SyncPassword => "tauri-sync-password.bin",
            SecretKind::SyncPasswordChangeKeys => "tauri-sync-password-change-keys.bin",
        }
    }
}

/// Why a stored secret cannot be returned: the local reasons of
/// `SyncCredentialFailureReason` (src/shared/types/sync.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SecretFailure {
    #[error("keystoreUnavailable")]
    KeystoreUnavailable,
    #[error("noPasswordFile")]
    NoPasswordFile,
    #[error("decryptFailed")]
    DecryptFailed,
}

/// Why a secret was not stored.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// The key store could not read or create the master key.
    #[error("OS keychain encryption is not available")]
    KeystoreUnavailable,
    /// The record of the key's account name ([`ACCOUNT_RECORD_FILE`]) could
    /// not be read when the store was made.
    #[error("the account record of the secret key (local/auth/key-account) cannot be read")]
    AccountUnreadable,
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

/// Why [`SecretStore::read_if_present`] has no secret for a file that is
/// there (or could not be read).
#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    #[error("{0}")]
    Io(std::io::Error),
    #[error("the OS key store is unavailable")]
    KeystoreUnavailable,
    #[error("the secret file does not open")]
    DecryptFailed,
}

/// The associated data of a `kind` file under the key of `account`.
fn associated_data(kind: SecretKind, account: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(FILE_MAGIC.len() + kind.name().len() + account.len() + 3);
    for part in [FILE_MAGIC.as_slice(), kind.name().as_bytes(), account.as_bytes()] {
        aad.extend_from_slice(part);
        aad.push(0);
    }
    aad
}

/// The file content of `secret` as a `kind` file under `key` of `account`,
/// with a fresh nonce from the OS.
pub fn seal_secret(key: &Key, kind: SecretKind, account: &str, secret: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce).map_err(|err| std::io::Error::other(format!("no random nonce: {err}")))?;
    let cipher = Aes256Gcm::new(key.as_slice().into());
    let aad = associated_data(kind, account);
    let sealed = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: secret, aad: &aad })
        .map_err(|_| std::io::Error::other("the secret could not be encrypted"))?;
    let mut file = Vec::with_capacity(FILE_MAGIC.len() + NONCE_LEN + sealed.len());
    file.extend_from_slice(FILE_MAGIC);
    file.extend_from_slice(&nonce);
    file.extend_from_slice(&sealed);
    Ok(file)
}

/// The secret of a `kind` file under `key` of `account`; `None` when it is
/// not such a file or does not open.
pub fn open_secret(key: &Key, kind: SecretKind, account: &str, file: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    let rest = file.strip_prefix(FILE_MAGIC.as_slice())?;
    if rest.len() < NONCE_LEN + TAG_LEN {
        return None;
    }
    let (nonce, sealed) = rest.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(key.as_slice().into());
    let aad = associated_data(kind, account);
    cipher.decrypt(Nonce::from_slice(nonce), Payload { msg: sealed, aad: &aad }).ok().map(Zeroizing::new)
}

/// The secret files of one userData directory.
pub struct SecretStore {
    auth_dir: PathBuf,
    key: MasterKey,
    /// The account record could not be read when the store was made: every
    /// store fails and every read is `keystoreUnavailable`.
    closed: bool,
}

/// The account name in the record text, `None` when it is empty. The name
/// is the one line of the record without the white space around it, in
/// whatever form; a record of more than one line or with control
/// characters is an error, as a record that cannot be read is.
fn recorded_account(text: &str) -> std::io::Result<Option<&str>> {
    let name = text.trim();
    if name.chars().any(char::is_control) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "not a single line"));
    }
    Ok((!name.is_empty()).then_some(name))
}

/// The account name recorded at `path`; `None` when there is no record or
/// it is empty.
fn read_account_record(path: &Path) -> std::io::Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(recorded_account(&text)?.map(str::to_owned)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

fn write_account_record(path: &Path, account: &str) -> std::io::Result<()> {
    pipette_fs::write_file_atomic(path, format!("{account}\n").as_bytes())
}

/// Whether `auth_dir` holds a secret file of any kind.
fn has_secret_files(auth_dir: &Path) -> bool {
    SecretKind::ALL.iter().any(|kind| auth_dir.join(kind.file_name()).exists())
}

/// The account name of the master key of `user_data`, `None` when the
/// record cannot be read. Without a record it is the name of the path, and
/// secret files already in `auth_dir` get that name recorded: they were
/// written under it.
fn resolve_account(user_data: &Path, auth_dir: &Path) -> Option<String> {
    let record = auth_dir.join(ACCOUNT_RECORD_FILE);
    match read_account_record(&record) {
        Ok(Some(account)) => Some(account),
        Ok(None) => {
            let account = key_account(user_data);
            if has_secret_files(auth_dir)
                && let Err(err) = write_account_record(&record, &account)
            {
                // The next store records it, or the next start tries again.
                log::warn!("[secret-store] the account of the secret key could not be recorded: {err}");
            }
            Some(account)
        }
        Err(err) => {
            log::warn!(
                "[secret-store] the account record of the secret key cannot be read; the secrets are \
                 closed until the next start: {err}"
            );
            None
        }
    }
}

impl SecretStore {
    /// The secrets of `user_data`, under its master key in `keystore`, with
    /// the key's account name from the record of `user_data` (see the
    /// module documentation). Creates `user_data` when it is missing
    /// ([`key_account`]).
    pub fn new(user_data: &Path, keystore: Arc<dyn Keystore>) -> Self {
        Self::with_timeout(user_data, keystore, KEYSTORE_TIMEOUT)
    }

    /// [`SecretStore::new`] with another time limit for the key store calls.
    pub fn with_timeout(user_data: &Path, keystore: Arc<dyn Keystore>, timeout: Duration) -> Self {
        // The account name of the key resolves the directory's path, which
        // needs the directory: made here, the name is the same before and
        // after anything else creates it.
        if let Err(err) = std::fs::create_dir_all(user_data) {
            log::warn!("[secret-store] the userData directory could not be created: {err}");
        }
        let auth_dir = user_data.join("local").join("auth");
        let account = resolve_account(user_data, &auth_dir);
        let closed = account.is_none();
        // A closed store does not know the key's name: the path's name may
        // be the recorded name of another directory moved or copied from
        // this path. It keeps a key of that name only to have one; it
        // seals, opens and deletes nothing with it
        // ([`SecretStore::delete_key`]).
        let account = account.unwrap_or_else(|| key_account(user_data));
        Self { auth_dir, key: MasterKey::with_timeout(keystore, account, timeout), closed }
    }

    /// `local/auth/`.
    pub fn auth_dir(&self) -> &Path {
        &self.auth_dir
    }

    /// The path of the `kind` file.
    pub fn path(&self, kind: SecretKind) -> PathBuf {
        self.auth_dir.join(kind.file_name())
    }

    /// The master key.
    pub fn master_key(&self) -> &MasterKey {
        &self.key
    }

    /// Removes the master key from the key store and from memory. A closed
    /// store removes nothing: the entry of its key's name may be another
    /// directory's.
    pub async fn delete_key(&self) -> Result<(), KeystoreError> {
        if self.closed {
            log::warn!(
                "[secret-store] the account record of the secret key cannot be read; the key store \
                 entry is kept"
            );
            return Ok(());
        }
        self.key.delete().await
    }

    /// Encrypts `secret` and writes it as the `kind` file, creating
    /// `local/auth/`, the master key and the record of its account name
    /// when missing. The record is written before the file, and a record
    /// that cannot be written fails the store: a secret without a record
    /// would not open once the directory moves.
    pub async fn store(&self, kind: SecretKind, secret: &[u8]) -> Result<(), StoreError> {
        if self.closed {
            return Err(StoreError::AccountUnreadable);
        }
        let key = self.key.read_or_create().await.map_err(|_| StoreError::KeystoreUnavailable)?;
        let sealed = seal_secret(&key, kind, self.key.account(), secret)?;
        let path = self.path(kind);
        let record = self.auth_dir.join(ACCOUNT_RECORD_FILE);
        let account = self.key.account().to_owned();
        blocking(move || {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            // A record already there is kept, whatever name it holds.
            if read_account_record(&record)?.is_none() {
                write_account_record(&record, &account)?;
            }
            pipette_fs::write_file_atomic(&path, &sealed)
        })
        .await?;
        Ok(())
    }

    /// The secret of the `kind` file, or why it cannot be returned.
    pub async fn retrieve(&self, kind: SecretKind) -> Result<Zeroizing<Vec<u8>>, SecretFailure> {
        if self.closed {
            return Err(SecretFailure::KeystoreUnavailable);
        }
        let Ok(file) = read_file(self.path(kind)).await else {
            return Err(if self.key.available().await {
                SecretFailure::NoPasswordFile
            } else {
                SecretFailure::KeystoreUnavailable
            });
        };
        match self.key.read().await {
            Err(_) => Err(SecretFailure::KeystoreUnavailable),
            Ok(None) => Err(SecretFailure::DecryptFailed),
            Ok(Some(key)) => {
                open_secret(&key, kind, self.key.account(), &file).ok_or(SecretFailure::DecryptFailed)
            }
        }
    }

    /// [`SecretStore::retrieve`] as UTF-8 text; text that is not UTF-8 does
    /// not open.
    pub async fn retrieve_string(&self, kind: SecretKind) -> Result<Zeroizing<String>, SecretFailure> {
        let bytes = self.retrieve(kind).await?;
        utf8(bytes).ok_or(SecretFailure::DecryptFailed)
    }

    /// The secret of the `kind` file, `None` when there is no file, without
    /// asking the key store about a missing one. A closed store is
    /// `KeystoreUnavailable` with or without the file.
    pub async fn read_if_present(&self, kind: SecretKind) -> Result<Option<Zeroizing<Vec<u8>>>, ReadError> {
        if self.closed {
            return Err(ReadError::KeystoreUnavailable);
        }
        let file = match read_file(self.path(kind)).await {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(ReadError::Io(err)),
        };
        match self.key.read().await {
            Err(_) => Err(ReadError::KeystoreUnavailable),
            Ok(None) => Err(ReadError::DecryptFailed),
            Ok(Some(key)) => {
                open_secret(&key, kind, self.key.account(), &file).map(Some).ok_or(ReadError::DecryptFailed)
            }
        }
    }

    /// Removes the `kind` file; a missing one is no error.
    pub async fn clear(&self, kind: SecretKind) -> std::io::Result<()> {
        let path = self.path(kind);
        blocking(move || match std::fs::remove_file(&path) {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        })
        .await
    }
}

/// `bytes` as a string when they are UTF-8, keeping them zeroed on drop.
fn utf8(mut bytes: Zeroizing<Vec<u8>>) -> Option<Zeroizing<String>> {
    let taken = std::mem::take(&mut *bytes);
    match String::from_utf8(taken) {
        Ok(text) => Some(Zeroizing::new(text)),
        Err(err) => {
            // The bytes are the failed conversion's; zero them there.
            drop(Zeroizing::new(err.into_bytes()));
            None
        }
    }
}

async fn read_file(path: PathBuf) -> std::io::Result<Vec<u8>> {
    blocking(move || std::fs::read(path)).await
}

/// Runs file work on the blocking threads of the runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> std::io::Result<T> {
    tokio::task::spawn_blocking(work).await.map_err(std::io::Error::other)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> Key {
        Zeroizing::new([byte; 32])
    }

    const ACCOUNT: &str = "local-auth-key/0011223344556677";

    #[test]
    fn a_file_is_the_magic_a_nonce_and_the_sealed_secret() {
        let file = seal_secret(&key(1), SecretKind::SyncPassword, ACCOUNT, b"hunter2").unwrap();
        assert_eq!(&file[..4], b"PTS1");
        assert_eq!(file.len(), 4 + 12 + 7 + 16);
        assert_eq!(
            open_secret(&key(1), SecretKind::SyncPassword, ACCOUNT, &file).as_deref().map(Vec::as_slice),
            Some(b"hunter2".as_slice())
        );
    }

    #[test]
    fn every_write_draws_a_new_nonce() {
        let a = seal_secret(&key(1), SecretKind::SyncPassword, ACCOUNT, b"same").unwrap();
        let b = seal_secret(&key(1), SecretKind::SyncPassword, ACCOUNT, b"same").unwrap();
        assert_ne!(a[4..16], b[4..16]);
        assert_ne!(a, b);
    }

    #[test]
    fn opens_only_with_its_key_kind_and_account() {
        let file = seal_secret(&key(1), SecretKind::SyncPassword, ACCOUNT, b"secret").unwrap();
        assert!(open_secret(&key(2), SecretKind::SyncPassword, ACCOUNT, &file).is_none());
        assert!(open_secret(&key(1), SecretKind::OauthTokens, ACCOUNT, &file).is_none());
        assert!(
            open_secret(&key(1), SecretKind::SyncPassword, "local-auth-key/ffffffffffffffff", &file)
                .is_none()
        );
        let mut tampered = file.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(open_secret(&key(1), SecretKind::SyncPassword, ACCOUNT, &tampered).is_none());
        let mut renamed = file.clone();
        renamed[3] = b'2';
        assert!(open_secret(&key(1), SecretKind::SyncPassword, ACCOUNT, &renamed).is_none());
        assert!(open_secret(&key(1), SecretKind::SyncPassword, ACCOUNT, &file[..4 + 12 + 15]).is_none());
        assert!(open_secret(&key(1), SecretKind::SyncPassword, ACCOUNT, b"").is_none());
    }

    #[test]
    fn the_kinds_are_tauri_files_not_the_0_4_ones() {
        for kind in SecretKind::ALL {
            assert!(kind.file_name().starts_with("tauri-"), "{kind:?}");
            assert!(kind.file_name().ends_with(".bin"), "{kind:?}");
            assert_eq!(kind.file_name(), format!("tauri-{}.bin", kind.name()));
        }
    }

    #[test]
    fn the_associated_data_separates_its_parts() {
        assert_eq!(associated_data(SecretKind::SyncPassword, "a/b"), b"PTS1\0sync-password\0a/b\0".to_vec());
    }

    #[test]
    fn the_record_is_one_line_of_any_form() {
        assert_eq!(recorded_account("local-auth-key/0011223344556677\n").unwrap(), Some(ACCOUNT));
        assert_eq!(recorded_account("  other form\r\n").unwrap(), Some("other form"));
        assert_eq!(recorded_account("").unwrap(), None);
        assert_eq!(recorded_account(" \n\t").unwrap(), None);
        assert!(recorded_account("one\ntwo").is_err());
        assert!(recorded_account("a\u{7}b").is_err());
    }

    #[test]
    fn text_that_is_not_utf8_does_not_open_as_a_string() {
        assert_eq!(utf8(Zeroizing::new(b"ok".to_vec())).as_deref().map(String::as_str), Some("ok"));
        assert!(utf8(Zeroizing::new(vec![0xff, 0xfe])).is_none());
    }
}
