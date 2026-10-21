// SPDX-License-Identifier: GPL-2.0-or-later
//! The sync engine: the bundles, the merges, the passes and their entry points,
//! the password and its change, the trash and the resets. It runs on
//! `pipette_drive::DriveApi` and keeps its memory in
//! `pipette_sync_runtime::SyncRuntime`.
//!
//! - [`units`]: what a unit name says (its store, its lock, its shape);
//! - [`account`]: the sign-in and sign-out around the pending units;
//! - [`analytics`]: the Analyze panel's sync of one keyboard's typing
//!   analytics;
//! - [`bundle`]: the bundle a unit is uploaded as, and the units a pass
//!   sends;
//! - [`merge`]: the merge of a downloaded bundle into the local files;
//! - [`typing_remote`]: this device's typing days on Drive and their
//!   reconcile with the local files before an upload pass, and the Data
//!   modal's reads of other devices' days;
//! - [`unit_locks`]: the locks a whole sync of one unit holds;
//! - [`dispatch`]: the sync of one unit (its merge or upload) and the
//!   Drive revisions it records, with the envelope of [`codec`];
//! - [`scope`] and [`execute`]: the units a scope covers, and the full
//!   sync pass;
//! - [`preflight`]: what every entry point runs before it touches data,
//!   with its parts in [`format`] and [`format_status`] (the sync-format
//!   marker and the status of the update banner) and [`password`] (the
//!   guard, the password-check and the password change);
//! - [`scan`]: what is on Drive, read without merging it;
//! - [`reset`]: the resets and deletes of synced data, and the trash
//!   screen's actions ([`trash`]), failing with a [`data_error`];
//! - [`local_data`]: the export and import of the Data modal's Local Data;
//! - [`meta_backfill`]: the keyboard names a full download fills in;
//! - [`flush`] and [`polling`]: the debounced upload of the pending units
//!   and the poll for remote changes, which ends by tidying the Drive names
//!   with several copies ([`trash`]), and [`triggers`], what starts and
//!   stops them.

pub mod account;
pub mod analytics;
pub mod bundle;
pub mod codec;
pub mod crypto;
pub mod data_error;
mod day_uploads;
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
pub mod reset;
pub mod scan;
pub mod scope;
mod single_flight;
pub mod trash;
pub mod triggers;
pub mod typing_remote;
pub mod unit_locks;
pub mod units;
