// SPDX-License-Identifier: GPL-2.0-or-later
//! The sync's secrets at rest: a master key in the OS key store
//! ([`keystore`], [`master_key`]) and the files of `local/auth/` encrypted
//! with it ([`secret_file`]).
//!
//! The files are `tauri-*.bin`, never the 0.4 build's `*.enc`: this crate
//! neither reads nor writes those. The app removes them at startup
//! (`remove_v04_leftovers` in `pipette-fs/src/v04_leftovers.rs`).

// The dev key file keeps the master key in plain text, so only a debug
// build may have the code that reads its variable. Every bundled build is
// a release build without debug assertions.
#[cfg(all(feature = "dev-keystore", not(debug_assertions)))]
compile_error!(
    "the dev-keystore feature of pipette-secret-store is not allowed without debug assertions: it keeps \
     the master key in a plain-text file"
);

#[cfg(feature = "dev-keystore")]
mod dev_file;
pub mod keystore;
pub mod master_key;
pub mod secret_file;

#[cfg(feature = "dev-keystore")]
pub use dev_file::{DEV_KEYSTORE_ENV, DEV_KEYSTORE_FILE, FileKeystore, dev_keystore_from_env};
#[cfg(feature = "test-util")]
pub use keystore::MemoryKeystore;
pub use keystore::{KEYSTORE_SERVICE, Keystore, KeystoreError, OsKeystore, UnavailableKeystore};
pub use master_key::{KEY_LEN, KEYSTORE_TIMEOUT, MasterKey, key_account};
pub use secret_file::{
    FILE_MAGIC, ReadError, SecretFailure, SecretKind, SecretStore, StoreError, open_secret, seal_secret,
};
