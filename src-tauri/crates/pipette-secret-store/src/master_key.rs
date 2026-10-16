// SPDX-License-Identifier: GPL-2.0-or-later
//! The master key of the files of `local/auth/`: 32 random bytes in the key
//! store under an account name of this userData directory
//! ([`key_account`]), so another userData directory has a key of its own.
//!
//! Every operation on the entry (read, create, delete) runs one at a time
//! under one lock per account name in the process, and "missing, so
//! create" happens inside it: two creations at once would otherwise store
//! two keys, and the files written with the first would no longer open. A key read in time is kept in memory for the
//! rest of the process (zeroed when dropped). A key store that fails is not
//! remembered: the next call asks it again.
//!
//! Each call runs on a thread of its own, detached, and is given up after
//! [`KEYSTORE_TIMEOUT`] (a Linux key store may wait on an unlock prompt): the
//! caller gets [`KeystoreError::TimedOut`] and whatever the call returns
//! later is dropped. A key it created in the meantime is in the key store,
//! where the next call finds it; nothing that follows the call runs on its
//! late result. The quit sequence never waits for such a thread.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError, Weak};
use std::time::Duration;

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::keystore::{Keystore, KeystoreError};

/// The length of the master key: an AES-256 key.
pub const KEY_LEN: usize = 32;

/// How long a key store call may take before it counts as unavailable.
pub const KEYSTORE_TIMEOUT: Duration = Duration::from_secs(60);

/// The master key bytes, zeroed when dropped.
pub type Key = Zeroizing<[u8; KEY_LEN]>;

/// `local-auth-key/` and the first 16 hex digits of the SHA-256 of the
/// userData directory's path ([`resolved_user_data`]).
///
/// The account name follows the path, so the secrets of a userData
/// directory that was moved or copied elsewhere no longer open there: the
/// sign-in and the sync password have to be entered again.
pub fn key_account(user_data: &Path) -> String {
    let resolved = resolved_user_data(user_data);
    let digest = Sha256::digest(resolved.to_string_lossy().as_bytes());
    format!("local-auth-key/{}", &hex::encode(digest)[..16])
}

/// `user_data` resolved (symbolic links, `..`, macOS's `/var` that is
/// `/private/var`) when it exists, without the `\\?\` prefix Windows
/// gives a resolved path when the path works without it; else `user_data`
/// as it is. The caller creates the directory first
/// ([`crate::SecretStore::new`] does), so the name does not change once the
/// directory comes to exist.
fn resolved_user_data(user_data: &Path) -> PathBuf {
    dunce::canonicalize(user_data).unwrap_or_else(|_| user_data.to_path_buf())
}

/// The lock of the key store entry of `account`, shared by every
/// [`MasterKey`] of that account in the process.
fn entry_lock(account: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS.get_or_init(Default::default).lock().unwrap_or_else(PoisonError::into_inner);
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(account).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(account.to_owned(), Arc::downgrade(&lock));
    lock
}

/// The master key of one userData directory.
pub struct MasterKey {
    keystore: Arc<dyn Keystore>,
    account: String,
    /// Held by the thread of each key store call, so the calls on the entry
    /// run one at a time, in the order they take it ([`entry_lock`]).
    entry_lock: Arc<Mutex<()>>,
    cached: Mutex<Option<Arc<Key>>>,
    /// Advanced by a delete, so a read that started before it does not
    /// keep the key it removed.
    cache_generation: AtomicU64,
    timeout: Duration,
}

/// What a key store entry holds.
enum Stored {
    Key(Key),
    Missing,
    /// Not a key of [`KEY_LEN`] bytes; no file opens with it.
    Malformed,
}

impl MasterKey {
    pub fn new(keystore: Arc<dyn Keystore>, account: String) -> Self {
        Self::with_timeout(keystore, account, KEYSTORE_TIMEOUT)
    }

    pub fn with_timeout(keystore: Arc<dyn Keystore>, account: String, timeout: Duration) -> Self {
        Self {
            entry_lock: entry_lock(&account),
            keystore,
            account,
            cached: Mutex::new(None),
            cache_generation: AtomicU64::new(0),
            timeout,
        }
    }

    /// The account name of the key store entry.
    pub fn account(&self) -> &str {
        &self.account
    }

    /// The key, from memory or the key store; `None` when the key store has
    /// none (or holds something that is not a key). Never creates one.
    pub async fn read(&self) -> Result<Option<Arc<Key>>, KeystoreError> {
        if let Some(key) = self.cached() {
            return Ok(Some(key));
        }
        let generation = self.cache_generation.load(Ordering::SeqCst);
        match self.call(|keystore, account| read_entry(keystore, account)).await? {
            Stored::Key(key) => Ok(Some(self.remember(key, generation))),
            Stored::Missing | Stored::Malformed => Ok(None),
        }
    }

    /// The key, created and stored first when the key store has none. An
    /// entry that holds no key is replaced: nothing opens with it anyway.
    pub async fn read_or_create(&self) -> Result<Arc<Key>, KeystoreError> {
        if let Some(key) = self.cached() {
            return Ok(key);
        }
        let generation = self.cache_generation.load(Ordering::SeqCst);
        let key = self
            .call(|keystore, account| match read_entry(keystore, account)? {
                Stored::Key(key) => Ok(key),
                found => {
                    if matches!(found, Stored::Malformed) {
                        log::warn!("[secret-store] the key store entry holds no key; replacing it");
                    }
                    let key = new_key()?;
                    keystore.write(account, key.as_slice())?;
                    Ok(key)
                }
            })
            .await?;
        Ok(self.remember(key, generation))
    }

    /// Whether the key store answers: the probe of `isEncryptionAvailable`.
    /// A key already in memory counts as available.
    pub async fn available(&self) -> bool {
        self.read().await.is_ok()
    }

    /// Removes the key from the key store and from memory.
    pub async fn delete(&self) -> Result<(), KeystoreError> {
        self.cache_generation.fetch_add(1, Ordering::SeqCst);
        *self.cache() = None;
        self.call(|keystore, account| keystore.delete(account)).await
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, Option<Arc<Key>>> {
        self.cached.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn cached(&self) -> Option<Arc<Key>> {
        self.cache().clone()
    }

    /// Keeps `key` unless a delete came after `generation` was read.
    fn remember(&self, key: Key, generation: u64) -> Arc<Key> {
        let key = Arc::new(key);
        let mut cache = self.cache();
        if self.cache_generation.load(Ordering::SeqCst) == generation {
            *cache = Some(Arc::clone(&key));
        }
        key
    }

    /// Runs `op` on the entry on a detached thread under the entry lock,
    /// and waits for it at most `self.timeout`.
    async fn call<T: Send + 'static>(
        &self,
        op: impl FnOnce(&dyn Keystore, &str) -> Result<T, KeystoreError> + Send + 'static,
    ) -> Result<T, KeystoreError> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let keystore = Arc::clone(&self.keystore);
        let account = self.account.clone();
        let entry_lock = Arc::clone(&self.entry_lock);
        let spawned = std::thread::Builder::new().name("pipette-keystore".to_owned()).spawn(move || {
            let _entry = entry_lock.lock().unwrap_or_else(PoisonError::into_inner);
            // The receiver is gone once the caller gave up; the result is
            // dropped with the send.
            let _ = sender.send(op(keystore.as_ref(), &account));
        });
        if let Err(err) = spawned {
            return Err(KeystoreError::Unavailable(format!("could not start the key store call: {err}")));
        }
        match tokio::time::timeout(self.timeout, receiver).await {
            Ok(Ok(result)) => result,
            // The thread ended without an answer: the call panicked.
            Ok(Err(_)) => Err(KeystoreError::Unavailable("the key store call failed".to_owned())),
            Err(_) => {
                log::warn!("[secret-store] the key store did not answer within {:?}", self.timeout);
                Err(KeystoreError::TimedOut)
            }
        }
    }
}

fn read_entry(keystore: &dyn Keystore, account: &str) -> Result<Stored, KeystoreError> {
    Ok(match keystore.read(account)? {
        None => Stored::Missing,
        Some(secret) => match <[u8; KEY_LEN]>::try_from(secret.as_slice()) {
            Ok(bytes) => Stored::Key(Zeroizing::new(bytes)),
            Err(_) => Stored::Malformed,
        },
    })
}

fn new_key() -> Result<Key, KeystoreError> {
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    getrandom::fill(key.as_mut_slice())
        .map_err(|err| KeystoreError::Unavailable(format!("no random bytes for the key: {err}")))?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keystore::MemoryKeystore;

    /// An account of the test's own: the entry locks are per account in
    /// the process, and the tests run in parallel.
    fn account(test: &str) -> String {
        format!("local-auth-key/test-{test}")
    }

    fn master_for(keystore: &Arc<MemoryKeystore>, test: &str) -> MasterKey {
        MasterKey::with_timeout(keystore.clone(), account(test), Duration::from_millis(200))
    }

    #[test]
    fn the_account_is_a_hash_of_the_resolved_user_data_path() {
        let dir = tempfile::tempdir().unwrap();
        let account = key_account(dir.path());
        std::fs::create_dir(dir.path().join("x")).unwrap();
        assert!(account.starts_with("local-auth-key/"), "{account}");
        assert_eq!(account.len(), "local-auth-key/".len() + 16);
        assert_eq!(account, key_account(&dir.path().join("x").join("..")));
        assert_ne!(account, key_account(&dir.path().join("other")));
        let missing = PathBuf::from("/nonexistent/pipette-user-data");
        let digest = hex::encode(Sha256::digest(missing.to_string_lossy().as_bytes()));
        assert_eq!(key_account(&missing), format!("local-auth-key/{}", &digest[..16]));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_the_user_data_directory_has_its_account() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, dir.path().join("link")).unwrap();
        assert_eq!(key_account(&dir.path().join("link")), key_account(&real));
    }

    #[tokio::test]
    async fn creates_one_key_and_reads_it_back_from_memory() {
        let keystore = Arc::new(MemoryKeystore::default());
        let master = master_for(&keystore, "creates_one_key_and_reads_it_back_from_memory");
        assert!(master.read().await.unwrap().is_none());
        let key = master.read_or_create().await.unwrap();
        assert_eq!(keystore.secret(master.account()).as_deref(), Some(key.as_slice()));
        let calls = keystore.calls();
        assert_eq!(*master.read().await.unwrap().unwrap(), *key);
        assert_eq!(*master.read_or_create().await.unwrap(), *key);
        assert_eq!(keystore.calls(), calls, "a key in memory needs no key store call");
    }

    #[tokio::test]
    async fn concurrent_creations_store_a_single_key() {
        let keystore = Arc::new(MemoryKeystore::default());
        let account = account("concurrent_creations_store_a_single_key");
        let first = MasterKey::with_timeout(keystore.clone(), account.clone(), Duration::from_secs(5));
        let second = MasterKey::with_timeout(keystore.clone(), account.clone(), Duration::from_secs(5));
        // The first creation waits in the key store while the second starts:
        // the second must wait for it, not read "missing" too.
        keystore.block();
        let (a, b) = tokio::join!(first.read_or_create(), async {
            while keystore.calls() == 0 {
                tokio::task::yield_now().await;
            }
            let second_create = second.read_or_create();
            tokio::pin!(second_create);
            let early = tokio::time::timeout(Duration::from_millis(50), &mut second_create).await;
            assert!(early.is_err(), "the second creation must wait for the first");
            assert_eq!(keystore.calls(), 1);
            keystore.release();
            second_create.await
        });
        assert_eq!(*a.unwrap(), *b.unwrap());
        assert_eq!(keystore.secret(&account).as_deref(), Some(a_slice(&first).await.as_slice()));
    }

    async fn a_slice(master: &MasterKey) -> Vec<u8> {
        master.read().await.unwrap().unwrap().to_vec()
    }

    #[tokio::test]
    async fn uses_an_existing_key() {
        let keystore = Arc::new(MemoryKeystore::default());
        keystore.insert(&account("uses_an_existing_key"), &[7; KEY_LEN]);
        assert_eq!(
            *master_for(&keystore, "uses_an_existing_key").read_or_create().await.unwrap(),
            Zeroizing::new([7; KEY_LEN])
        );
    }

    #[tokio::test]
    async fn an_entry_that_holds_no_key_reads_as_missing_and_is_replaced_on_create() {
        let keystore = Arc::new(MemoryKeystore::default());
        keystore.insert(
            &account("an_entry_that_holds_no_key_reads_as_missing_and_is_replaced_on_create"),
            b"short",
        );
        let master =
            master_for(&keystore, "an_entry_that_holds_no_key_reads_as_missing_and_is_replaced_on_create");
        assert!(master.read().await.unwrap().is_none());
        let key = master.read_or_create().await.unwrap();
        assert_eq!(keystore.secret(master.account()).as_deref(), Some(key.as_slice()));
    }

    #[tokio::test]
    async fn an_unavailable_key_store_is_asked_again_on_the_next_call() {
        let keystore = Arc::new(MemoryKeystore::default());
        let master = master_for(&keystore, "an_unavailable_key_store_is_asked_again_on_the_next_call");
        keystore.set_unavailable(true);
        assert!(matches!(master.read_or_create().await, Err(KeystoreError::Unavailable(_))));
        assert!(!master.available().await);
        keystore.set_unavailable(false);
        assert!(master.available().await);
        assert!(master.read_or_create().await.is_ok());
    }

    #[tokio::test]
    async fn a_key_in_memory_survives_a_key_store_that_becomes_unavailable() {
        let keystore = Arc::new(MemoryKeystore::default());
        let master = master_for(&keystore, "a_key_in_memory_survives_a_key_store_that_becomes_unavailable");
        let key = master.read_or_create().await.unwrap();
        keystore.set_unavailable(true);
        assert_eq!(*master.read().await.unwrap().unwrap(), *key);
        assert!(master.available().await);
    }

    #[tokio::test]
    async fn a_call_past_the_time_limit_is_given_up_and_its_late_key_is_not_kept() {
        let keystore = Arc::new(MemoryKeystore::default());
        let master =
            master_for(&keystore, "a_call_past_the_time_limit_is_given_up_and_its_late_key_is_not_kept");
        keystore.block();
        assert_eq!(master.read_or_create().await.err(), Some(KeystoreError::TimedOut));
        keystore.release();
        // The late call stores its key; the given-up caller kept nothing,
        // so the next call reads the stored key from the key store.
        let late = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(secret) = keystore.secret(master.account()) {
                    return secret;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let calls = keystore.calls();
        assert_eq!(master.read().await.unwrap().unwrap().as_slice(), late.as_slice());
        assert_eq!(keystore.calls(), calls + 1);
    }

    #[tokio::test]
    async fn delete_removes_the_key_from_the_key_store_and_memory() {
        let keystore = Arc::new(MemoryKeystore::default());
        let master = master_for(&keystore, "delete_removes_the_key_from_the_key_store_and_memory");
        master.read_or_create().await.unwrap();
        master.delete().await.unwrap();
        assert_eq!(keystore.secret(master.account()), None);
        assert!(master.read().await.unwrap().is_none());
    }
}
