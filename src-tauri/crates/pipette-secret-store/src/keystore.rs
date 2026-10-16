// SPDX-License-Identifier: GPL-2.0-or-later
//! Where the master key lives: the OS key store ([`OsKeystore`]), or for the
//! tests an in-memory one ([`MemoryKeystore`], `test-util`) and one that
//! is never available ([`UnavailableKeystore`]).
//!
//! The calls block (a Linux key store may show an unlock prompt), so
//! [`crate::MasterKey`] runs them on a thread of their own with a time
//! limit.

use zeroize::Zeroizing;

/// The key store service of the master key: the app identifier.
pub const KEYSTORE_SERVICE: &str = "app.pipette.desktop";

/// Why the key store did not answer. Every one of these counts as
/// "the key store is unavailable" for the status of a secret.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KeystoreError {
    /// The key store refused or failed the call; the message is its own.
    #[error("the OS key store is unavailable: {0}")]
    Unavailable(String),
    /// The call did not finish within the time limit.
    #[error("the OS key store did not answer in time")]
    TimedOut,
}

/// One secret per account name under one service.
pub trait Keystore: Send + Sync {
    /// The secret of `account`; `None` when there is none.
    fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError>;
    /// Stores `secret` as the secret of `account`, replacing any.
    fn write(&self, account: &str, secret: &[u8]) -> Result<(), KeystoreError>;
    /// Removes the secret of `account`; one that is not there is no error.
    fn delete(&self, account: &str) -> Result<(), KeystoreError>;
    /// What names the store behind this instance, when other instances can
    /// reach the same one: instances with the same identity share the key
    /// in memory ([`crate::MasterKey`]), so a delete through one is seen by
    /// all. `None` (the default) when this instance is a store of its own.
    fn identity(&self) -> Option<String> {
        None
    }
}

/// The OS key store through the `keyring` crate: the Keychain on macOS,
/// the Credential Manager on Windows and the Secret Service on Linux. A
/// Linux session without a Secret Service (or without D-Bus) makes every
/// call [`KeystoreError::Unavailable`]; there is no fallback to a file.
pub struct OsKeystore {
    service: String,
}

impl OsKeystore {
    /// The key store entries of `service` ([`KEYSTORE_SERVICE`] in the app).
    pub fn new(service: impl Into<String>) -> Self {
        Self { service: service.into() }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
impl Keystore for OsKeystore {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        match self.entry(account)?.get_secret() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(unavailable(err)),
        }
    }

    fn write(&self, account: &str, secret: &[u8]) -> Result<(), KeystoreError> {
        self.entry(account)?.set_secret(secret).map_err(unavailable)
    }

    fn delete(&self, account: &str) -> Result<(), KeystoreError> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(unavailable(err)),
        }
    }

    /// Every instance of one service reaches the same entries.
    fn identity(&self) -> Option<String> {
        Some(format!("os/{}", self.service))
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
impl OsKeystore {
    fn entry(&self, account: &str) -> Result<keyring::Entry, KeystoreError> {
        keyring::Entry::new(&self.service, account).map_err(unavailable)
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn unavailable(err: keyring::Error) -> KeystoreError {
    KeystoreError::Unavailable(err.to_string())
}

/// No OS key store on other systems.
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
impl Keystore for OsKeystore {
    fn read(&self, _account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        Err(UnavailableKeystore::error())
    }

    fn write(&self, _account: &str, _secret: &[u8]) -> Result<(), KeystoreError> {
        Err(UnavailableKeystore::error())
    }

    fn delete(&self, _account: &str) -> Result<(), KeystoreError> {
        Err(UnavailableKeystore::error())
    }
}

/// A key store that is never available: what a session without one
/// gives, for the tests and for a key store setting the app does not know.
pub struct UnavailableKeystore;

impl UnavailableKeystore {
    fn error() -> KeystoreError {
        KeystoreError::Unavailable("no key store".to_owned())
    }
}

impl Keystore for UnavailableKeystore {
    fn read(&self, _account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        Err(Self::error())
    }

    fn write(&self, _account: &str, _secret: &[u8]) -> Result<(), KeystoreError> {
        Err(Self::error())
    }

    fn delete(&self, _account: &str) -> Result<(), KeystoreError> {
        Err(Self::error())
    }
}

#[cfg(feature = "test-util")]
pub use memory::MemoryKeystore;

#[cfg(feature = "test-util")]
mod memory {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Condvar, Mutex, PoisonError};

    use zeroize::Zeroizing;

    use super::{Keystore, KeystoreError};

    /// A key store in memory for the tests: it can be made unavailable,
    /// made to block until released, and counts its calls.
    #[derive(Default)]
    pub struct MemoryKeystore {
        secrets: Mutex<HashMap<String, Vec<u8>>>,
        unavailable: AtomicBool,
        calls: AtomicUsize,
        gate: Gate,
    }

    /// Holds the calls while closed.
    #[derive(Default)]
    struct Gate {
        closed: Mutex<bool>,
        opened: Condvar,
    }

    impl MemoryKeystore {
        /// Makes every later call fail (`true`) or answer (`false`).
        pub fn set_unavailable(&self, unavailable: bool) {
            self.unavailable.store(unavailable, Ordering::SeqCst);
        }

        /// Holds every later call until [`MemoryKeystore::release`].
        pub fn block(&self) {
            *self.gate.closed.lock().unwrap_or_else(PoisonError::into_inner) = true;
        }

        /// Lets the held calls and every later call through.
        pub fn release(&self) {
            *self.gate.closed.lock().unwrap_or_else(PoisonError::into_inner) = false;
            self.gate.opened.notify_all();
        }

        /// How many calls reached this key store.
        pub fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        /// The stored secret of `account`, for the tests' checks.
        pub fn secret(&self, account: &str) -> Option<Vec<u8>> {
            self.map().get(account).cloned()
        }

        /// Stores `secret` for `account` directly, bypassing the gates.
        pub fn insert(&self, account: &str, secret: &[u8]) {
            self.map().insert(account.to_owned(), secret.to_vec());
        }

        fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<u8>>> {
            self.secrets.lock().unwrap_or_else(PoisonError::into_inner)
        }

        fn enter(&self) -> Result<(), KeystoreError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut closed = self.gate.closed.lock().unwrap_or_else(PoisonError::into_inner);
            while *closed {
                closed = self.gate.opened.wait(closed).unwrap_or_else(PoisonError::into_inner);
            }
            drop(closed);
            if self.unavailable.load(Ordering::SeqCst) {
                return Err(KeystoreError::Unavailable("the test key store is unavailable".to_owned()));
            }
            Ok(())
        }
    }

    impl Keystore for MemoryKeystore {
        fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
            self.enter()?;
            Ok(self.map().get(account).cloned().map(Zeroizing::new))
        }

        fn write(&self, account: &str, secret: &[u8]) -> Result<(), KeystoreError> {
            self.enter()?;
            self.map().insert(account.to_owned(), secret.to_vec());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), KeystoreError> {
            self.enter()?;
            self.map().remove(account);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only the identity is asked: no call reaches the OS key store.
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    #[test]
    fn os_key_stores_of_one_service_have_one_identity() {
        let identity = |service: &str| OsKeystore::new(service).identity();
        assert_eq!(identity("a.service"), identity("a.service"));
        assert!(identity("a.service").is_some());
        assert_ne!(identity("a.service"), identity("b.service"));
        assert_eq!(UnavailableKeystore.identity(), None);
    }
}
