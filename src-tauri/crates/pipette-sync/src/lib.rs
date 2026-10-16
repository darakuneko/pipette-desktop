// SPDX-License-Identifier: GPL-2.0-or-later
//! The sync engine (src/main/sync/): the bundles, the merges, the passes
//! and their entry points, the password and its change, the trash and the
//! resets. It runs on `pipette_drive::DriveApi` and keeps its memory in
//! `pipette_sync_runtime::SyncRuntime`.
//!
//! - [`units`]: what a unit name says (its store, its lock, its shape);
//! - [`account`]: the sign-in and sign-out around the pending units;
//! - [`bundle`]: the bundle a unit is uploaded as, and the units a pass
//!   sends;
//! - [`merge`]: the merge of a downloaded bundle into the local files;
//! - [`typing_remote`]: this device's typing days on Drive and their
//!   reconcile with the local files before an upload pass;
//! - [`unit_locks`]: the locks a whole sync of one unit holds.

pub mod account;
pub mod bundle;
pub mod merge;
pub mod typing_remote;
pub mod unit_locks;
pub mod units;
