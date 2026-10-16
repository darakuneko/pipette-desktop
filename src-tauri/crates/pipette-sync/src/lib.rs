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
//! - [`unit_locks`]: the locks a whole sync of one unit holds;
//! - [`dispatch`]: the sync of one unit (its merge or upload) and the
//!   Drive revisions it records, with the envelope of [`codec`];
//! - [`scope`] and [`execute`]: the units a scope covers, and the full
//!   pass of `executeSync`;
//! - [`preflight`]: what every entry point runs before it touches data,
//!   with its parts in [`format`] and [`format_status`] (the sync-format
//!   marker and the status of the update banner) and [`password`] (the
//!   guard and the password-check);
//! - [`local_data`]: the export and import of the Data modal's Local Data;
//! - [`meta_backfill`]: the keyboard names a full download fills in;
//! - [`flush`] and [`polling`]: the debounced upload of the pending units
//!   and the poll for remote changes, which ends by tidying the Drive names
//!   with several copies ([`trash`]), and [`triggers`], what starts and
//!   stops them.

pub mod account;
pub mod bundle;
pub mod codec;
pub mod crypto;
pub mod dispatch;
pub mod execute;
pub mod flush;
pub mod format;
pub mod format_status;
mod limited;
pub mod local_data;
pub mod merge;
pub mod meta_backfill;
pub mod password;
pub mod polling;
pub mod preflight;
pub mod scope;
mod single_flight;
pub mod trash;
pub mod triggers;
pub mod typing_remote;
pub mod unit_locks;
pub mod units;
