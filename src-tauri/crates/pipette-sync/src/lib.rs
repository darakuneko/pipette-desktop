// SPDX-License-Identifier: GPL-2.0-or-later
//! The sync engine (src/main/sync/): the bundles, the merges, the passes
//! and their entry points, the password and its change, the trash and the
//! resets. It runs on `pipette_drive::DriveApi` and keeps its memory in
//! `pipette_sync_runtime::SyncRuntime`.
//!
//! - [`units`]: what a unit name says (its store, its lock, its shape);
//! - [`bundle`]: the bundle a unit is uploaded as, and the units a pass
//!   sends;
//! - [`merge`]: the merge of a downloaded bundle into the local files;
//! - [`unit_locks`]: the locks a whole sync of one unit holds.

pub mod bundle;
pub mod merge;
pub mod unit_locks;
pub mod units;
