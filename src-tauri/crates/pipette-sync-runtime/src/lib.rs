// SPDX-License-Identifier: GPL-2.0-or-later
//! The state the sync keeps in memory and shares across its passes
//! (src/main/sync/sync-runtime-state.ts): the sync lock, the reset lock
//! built on it and the lock-free writers ([`runtime`]).

pub mod runtime;

pub use runtime::{Busy, ResetKeyboards, SyncRuntime};
