// SPDX-License-Identifier: GPL-2.0-or-later
//! The state the sync keeps in memory and shares across its passes
//! (src/main/sync/sync-runtime-state.ts): the sync lock, the reset lock
//! built on it, the lock-free writers, the password change, the token
//! switch and the quit ([`runtime`]); the Drive revisions handled and the
//! files created ([`remote_state`]); the password-check last opened and the
//! sync-format marker ([`memory`]); and where progress goes ([`progress`]).
//! None of it is written to disk.

use std::sync::{Mutex, MutexGuard, PoisonError};

pub mod memory;
pub mod progress;
pub mod remote_state;
pub mod runtime;

pub use memory::{CredentialMemory, SyncFormatMemory, ValidatedPasswordCheck};
pub use progress::{ProgressSink, SyncCredentialFailureReason, SyncDirection, SyncProgress, SyncStatus};
pub use remote_state::{RemoteMemory, RemoteRevision};
pub use runtime::{Busy, ResetKeyboards, SyncRuntime};

/// Locks `mutex`, taking the data of a poisoned one: every value behind
/// these mutexes stays consistent when a holder panics.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
