// SPDX-License-Identifier: GPL-2.0-or-later
//! The master key of the files of `local/auth/`: 32 random bytes in the key
//! store under an account name of this userData directory
//! ([`key_account`]), so another userData directory has a key of its own.
//!
//! Every operation on the entry (read, create, delete) runs one at a time
//! behind one gate per account name in the process, and "missing, so
//! create" happens inside it: two creations at once would otherwise store
//! two keys, and the files written with the first would no longer open.
//!
//! A key that was read or created is kept in memory for the rest of the
//! process (zeroed when dropped), shared by every [`MasterKey`] of the same
//! account on the same key store ([`Keystore::identity`]). The memory changes only behind the gate: a read
//! keeps what it found there, and a delete empties it after removing the
//! entry, so no read keeps a key a delete removed. A delete also empties it
//! before waiting for the gate, so no call made after it began answers
//! from memory. A key store that fails is not remembered: the next call
//! asks it again.
//!
//! Each call runs on a thread of its own, detached, which holds the gate
//! until the key store answers. The caller gives up after
//! [`KEYSTORE_TIMEOUT`], counting the wait for the gate (a Linux key store
//! may wait on an unlock prompt), and gets [`KeystoreError::TimedOut`]. A
//! call that was given up still finishes on its thread, and a key it read
//! or created is kept in memory like any other. Later calls wait for the
//! gate instead of starting threads of their own, so a key store that
//! never answers holds one thread per account. The quit sequence never
//! waits for such a thread.

use std::collections::HashMap;
use std::hash::Hash;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, Weak};
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

/// Values shared in the process by key, while anything holds them.
type Registry<K, V> = OnceLock<Mutex<HashMap<K, Weak<V>>>>;

/// The value of `key` in `registry`, shared while anything holds it, and a
/// new one once nothing does.
fn shared<K: Eq + Hash, V: Default>(registry: &Registry<K, V>, key: K) -> Arc<V> {
    let mut values = lock(registry.get_or_init(Default::default));
    values.retain(|_, value| value.strong_count() > 0);
    if let Some(value) = values.get(&key).and_then(Weak::upgrade) {
        return value;
    }
    let value = Arc::new(V::default());
    values.insert(key, Arc::downgrade(&value));
    value
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The gate of the key store entry of `account`, shared by every
/// [`MasterKey`] of that account in the process, whatever its key store.
fn entry_gate(account: &str) -> Arc<tokio::sync::Mutex<()>> {
    static GATES: Registry<String, tokio::sync::Mutex<()>> = OnceLock::new();
    shared(&GATES, account.to_owned())
}

/// The key in memory.
type KeyCache = Mutex<Option<Arc<Key>>>;

/// Which key store a key in memory came from ([`Keystore::identity`]).
#[derive(PartialEq, Eq, Hash)]
enum StoreId {
    /// Every instance of this identity reaches the same entries.
    Shared(String),
    /// This instance only, by its address. Each [`MasterKey`] holds its key
    /// store, so the address names no other key store while the memory is
    /// in use.
    Instance(usize),
}

/// The memory of the key of `account` in `keystore`, shared by every
/// [`MasterKey`] of that account on the same key store in the process.
fn key_cache(keystore: &Arc<dyn Keystore>, account: &str) -> Arc<KeyCache> {
    static CACHES: Registry<(StoreId, String), KeyCache> = OnceLock::new();
    let store = match keystore.identity() {
        Some(identity) => StoreId::Shared(identity),
        None => StoreId::Instance(Arc::as_ptr(keystore).cast::<()>().addr()),
    };
    shared(&CACHES, (store, account.to_owned()))
}

/// The master key of one userData directory.
pub struct MasterKey {
    keystore: Arc<dyn Keystore>,
    account: String,
    /// Held by the thread of each key store call, so the calls on the entry
    /// run one at a time, in the order they reach it ([`entry_gate`]).
    gate: Arc<tokio::sync::Mutex<()>>,
    /// Changed behind the gate only, but for the emptying at the start of a
    /// delete ([`key_cache`]).
    cache: Arc<KeyCache>,
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
        Self { gate: entry_gate(&account), cache: key_cache(&keystore, &account), keystore, account, timeout }
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
        self.call(|keystore, account, cache| {
            if let Some(key) = lock(cache).clone() {
                return Ok(Some(key));
            }
            Ok(match read_entry(keystore, account)? {
                Stored::Key(key) => Some(remember(cache, key)),
                Stored::Missing | Stored::Malformed => None,
            })
        })
        .await
    }

    /// The key, created and stored first when the key store has none. An
    /// entry that holds no key is replaced: nothing opens with it anyway.
    pub async fn read_or_create(&self) -> Result<Arc<Key>, KeystoreError> {
        if let Some(key) = self.cached() {
            return Ok(key);
        }
        self.call(|keystore, account, cache| {
            if let Some(key) = lock(cache).clone() {
                return Ok(key);
            }
            let key = match read_entry(keystore, account)? {
                Stored::Key(key) => key,
                found => {
                    if matches!(found, Stored::Malformed) {
                        log::warn!("[secret-store] the key store entry holds no key; replacing it");
                    }
                    let key = new_key()?;
                    keystore.write(account, key.as_slice())?;
                    key
                }
            };
            Ok(remember(cache, key))
        })
        .await
    }

    /// Whether the key store answers: the probe of `isEncryptionAvailable`.
    /// A key already in memory counts as available.
    pub async fn available(&self) -> bool {
        self.read().await.is_ok()
    }

    /// Removes the key from the key store and from memory.
    pub async fn delete(&self) -> Result<(), KeystoreError> {
        *lock(&self.cache) = None;
        self.call(|keystore, account, cache| {
            let deleted = keystore.delete(account);
            // Behind the gate, after the removal: a read that ran before it
            // and kept the key does not keep it past the delete.
            *lock(cache) = None;
            deleted
        })
        .await
    }

    /// Empties the memory of the key, as a new process starts, so the next
    /// call asks the key store; for the tests that need a call to reach it.
    #[cfg(feature = "test-util")]
    pub fn forget(&self) {
        *lock(&self.cache) = None;
    }

    fn cached(&self) -> Option<Arc<Key>> {
        lock(&self.cache).clone()
    }

    /// Runs `op` on the entry on a detached thread behind the gate, and
    /// waits for the gate and the answer at most `self.timeout` in all.
    async fn call<T: Send + 'static>(
        &self,
        op: impl FnOnce(&dyn Keystore, &str, &KeyCache) -> Result<T, KeystoreError> + Send + 'static,
    ) -> Result<T, KeystoreError> {
        let deadline = tokio::time::Instant::now() + self.timeout;
        let Ok(gate) = tokio::time::timeout_at(deadline, Arc::clone(&self.gate).lock_owned()).await else {
            return Err(self.timed_out());
        };
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let keystore = Arc::clone(&self.keystore);
        let account = self.account.clone();
        let cache = Arc::clone(&self.cache);
        // The gate goes with the thread (and is let go when it cannot start).
        let spawned = std::thread::Builder::new().name("pipette-keystore".to_owned()).spawn(move || {
            let _gate = gate;
            // The receiver is gone once the caller gave up; the result is
            // dropped with the send.
            let _ = sender.send(op(keystore.as_ref(), &account, &cache));
        });
        if let Err(err) = spawned {
            return Err(KeystoreError::Unavailable(format!("could not start the key store call: {err}")));
        }
        match tokio::time::timeout_at(deadline, receiver).await {
            Ok(Ok(result)) => result,
            // The thread ended without an answer: the call panicked.
            Ok(Err(_)) => Err(KeystoreError::Unavailable("the key store call failed".to_owned())),
            Err(_) => Err(self.timed_out()),
        }
    }

    fn timed_out(&self) -> KeystoreError {
        log::warn!("[secret-store] the key store did not answer within {:?}", self.timeout);
        KeystoreError::TimedOut
    }
}

/// Keeps `key` in `cache`; runs behind the gate.
fn remember(cache: &KeyCache, key: Key) -> Arc<Key> {
    let key = Arc::new(key);
    *lock(cache) = Some(Arc::clone(&key));
    key
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
    use std::future::Future;
    use std::pin::Pin;
    use std::task::Poll;

    use super::*;
    use crate::keystore::MemoryKeystore;

    /// An account of the test's own: the gates are per account in the
    /// process, and the tests run in parallel.
    fn account(test: &str) -> String {
        format!("local-auth-key/test-{test}")
    }

    fn master_for(keystore: &Arc<MemoryKeystore>, test: &str) -> MasterKey {
        MasterKey::with_timeout(keystore.clone(), account(test), Duration::from_millis(200))
    }

    fn master_with_time(keystore: &Arc<MemoryKeystore>, test: &str) -> MasterKey {
        MasterKey::with_timeout(keystore.clone(), account(test), Duration::from_secs(5))
    }

    /// Polls `future` once and tells whether it is still pending.
    async fn pending_after_one_poll<F: Future>(mut future: Pin<&mut F>) -> bool {
        std::future::poll_fn(|cx| Poll::Ready(future.as_mut().poll(cx).is_pending())).await
    }

    /// Waits until `calls` key store calls have started (on their threads).
    async fn until_calls(keystore: &MemoryKeystore, calls: usize) {
        while keystore.calls() < calls {
            tokio::task::yield_now().await;
        }
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
        let first = master_with_time(&keystore, "concurrent_creations_store_a_single_key");
        let second = master_with_time(&keystore, "concurrent_creations_store_a_single_key");
        // The first creation waits in the key store while the second starts:
        // the second must wait for it, not read "missing" too.
        keystore.block();
        let first_create = first.read_or_create();
        tokio::pin!(first_create);
        assert!(pending_after_one_poll(first_create.as_mut()).await);
        until_calls(&keystore, 1).await;
        let second_create = second.read_or_create();
        tokio::pin!(second_create);
        assert!(pending_after_one_poll(second_create.as_mut()).await);
        assert_eq!(keystore.calls(), 1, "the second creation must wait for the first");
        keystore.release();
        let (a, b) = tokio::join!(first_create, second_create);
        assert_eq!(*a.unwrap(), *b.unwrap());
        assert_eq!(
            keystore.secret(&account).as_deref(),
            Some(first.read().await.unwrap().unwrap().as_slice())
        );
    }

    #[tokio::test]
    async fn the_masters_of_one_key_store_and_account_share_the_key_in_memory() {
        let keystore = Arc::new(MemoryKeystore::default());
        let test = "the_masters_of_one_key_store_and_account_share_the_key_in_memory";
        let first = master_for(&keystore, test);
        let key = first.read_or_create().await.unwrap();
        let calls = keystore.calls();
        assert_eq!(*master_for(&keystore, test).read().await.unwrap().unwrap(), *key);
        assert_eq!(keystore.calls(), calls);
        // Another key store instance (another process) has its own memory.
        let other = Arc::new(MemoryKeystore::default());
        assert!(master_for(&other, test).read().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_delete_through_one_master_removes_the_key_from_the_memory_of_the_others() {
        let keystore = Arc::new(MemoryKeystore::default());
        let test = "a_delete_through_one_master_removes_the_key_from_the_memory_of_the_others";
        let first = master_for(&keystore, test);
        let second = master_for(&keystore, test);
        let old = first.read_or_create().await.unwrap();
        second.delete().await.unwrap();
        assert!(first.read().await.unwrap().is_none());
        let new = first.read_or_create().await.unwrap();
        assert_ne!(*new, *old);
        assert_eq!(*second.read_or_create().await.unwrap(), *new);
    }

    /// A key store instance that reaches the store of `inner` under
    /// `identity`, as two `OsKeystore`s of one service do.
    struct SameStore {
        inner: Arc<MemoryKeystore>,
        identity: &'static str,
    }

    impl Keystore for SameStore {
        fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
            self.inner.read(account)
        }

        fn write(&self, account: &str, secret: &[u8]) -> Result<(), KeystoreError> {
            self.inner.write(account, secret)
        }

        fn delete(&self, account: &str) -> Result<(), KeystoreError> {
            self.inner.delete(account)
        }

        fn identity(&self) -> Option<String> {
            Some(self.identity.to_owned())
        }
    }

    #[tokio::test]
    async fn instances_of_one_key_store_identity_share_a_delete() {
        let store = Arc::new(MemoryKeystore::default());
        let test = "instances_of_one_key_store_identity_share_a_delete";
        let instance = || -> Arc<dyn Keystore> {
            Arc::new(SameStore { inner: store.clone(), identity: "test/instances_of_one_identity" })
        };
        let first = MasterKey::with_timeout(instance(), account(test), Duration::from_secs(5));
        let second = MasterKey::with_timeout(instance(), account(test), Duration::from_secs(5));
        let old = first.read_or_create().await.unwrap();
        let calls = store.calls();
        assert_eq!(*second.read().await.unwrap().unwrap(), *old);
        assert_eq!(store.calls(), calls, "the second instance reads the shared memory");
        second.delete().await.unwrap();
        assert!(first.read().await.unwrap().is_none());
        assert_ne!(*first.read_or_create().await.unwrap(), *old);
    }

    #[tokio::test]
    async fn a_read_that_found_the_key_before_a_delete_does_not_keep_it_past_the_delete() {
        let keystore = Arc::new(MemoryKeystore::default());
        let test = "a_read_that_found_the_key_before_a_delete_does_not_keep_it_past_the_delete";
        keystore.insert(&account(test), &[7; KEY_LEN]);
        let reader = master_with_time(&keystore, test);
        let deleter = master_with_time(&keystore, test);
        // The read holds the gate in the key store; the delete waits behind it.
        keystore.block();
        let read = reader.read();
        tokio::pin!(read);
        assert!(pending_after_one_poll(read.as_mut()).await);
        until_calls(&keystore, 1).await;
        let delete = deleter.delete();
        tokio::pin!(delete);
        assert!(pending_after_one_poll(delete.as_mut()).await);
        keystore.release();
        let (read, delete) = tokio::join!(read, delete);
        assert_eq!(read.unwrap().as_deref(), Some(&Zeroizing::new([7; KEY_LEN])));
        delete.unwrap();
        assert_eq!(keystore.secret(&account(test)), None);
        assert!(reader.read().await.unwrap().is_none());
        assert!(deleter.read().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_read_that_starts_during_a_delete_waits_for_it() {
        let keystore = Arc::new(MemoryKeystore::default());
        let master = master_with_time(&keystore, "a_read_that_starts_during_a_delete_waits_for_it");
        master.read_or_create().await.unwrap();
        let calls = keystore.calls();
        keystore.block();
        let delete = master.delete();
        tokio::pin!(delete);
        assert!(pending_after_one_poll(delete.as_mut()).await);
        until_calls(&keystore, calls + 1).await;
        // The memory was emptied when the delete began: the read goes to
        // the gate, behind the delete.
        let read = master.read();
        tokio::pin!(read);
        assert!(pending_after_one_poll(read.as_mut()).await);
        keystore.release();
        let (delete, read) = tokio::join!(delete, read);
        delete.unwrap();
        assert!(read.unwrap().is_none());
        assert!(master.read().await.unwrap().is_none());
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
    async fn calls_past_the_time_limit_wait_for_the_one_under_way_instead_of_starting_threads() {
        let keystore = Arc::new(MemoryKeystore::default());
        let master = master_for(
            &keystore,
            "calls_past_the_time_limit_wait_for_the_one_under_way_instead_of_starting_threads",
        );
        keystore.block();
        assert_eq!(master.read_or_create().await.err(), Some(KeystoreError::TimedOut));
        assert_eq!(keystore.calls(), 1);
        // The given-up creation still holds the gate: the later calls wait
        // for it and give up in turn, without a thread of their own.
        for _ in 0..3 {
            assert_eq!(master.read().await.err(), Some(KeystoreError::TimedOut));
        }
        assert_eq!(keystore.calls(), 1);
        keystore.release();
        // The late creation stores its key and keeps it in memory; the
        // next call waits for it and needs no key store call of its own.
        let calls_of_the_creation = 2;
        let key =
            MasterKey::with_timeout(keystore.clone(), master.account().to_owned(), Duration::from_secs(5))
                .read()
                .await
                .unwrap()
                .unwrap();
        assert_eq!(keystore.secret(master.account()).as_deref(), Some(key.as_slice()));
        assert_eq!(keystore.calls(), calls_of_the_creation);
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
