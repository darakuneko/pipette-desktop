// SPDX-License-Identifier: GPL-2.0-or-later
//! The merge of a downloaded bundle into the local files (`mergeSyncUnit`
//! of src/main/sync/sync-merge-dispatch.ts), by the shape of its unit:
//! the keyboard names, a keyboard's settings, a pack roster or body, or an
//! index-based store. The typing-analytics day and deleted-ranges units
//! have merges of their own ([`merge_analytics_unit`]), which wait for the
//! cache's database thread.
//!
//! Each merge runs under the store lock its unit's writes take, writes
//! atomically, and reports `sync:unit-applied` (or the pack list change)
//! only after it wrote. It answers whether Drive needs this device's copy.

mod analytics_day;
mod deleted_ranges;
mod index_store;
mod packs;
mod settings;

use std::sync::Arc;

use pipette_entry_store::is_safe_path_segment;
use pipette_js_json::Value;
use pipette_keyboard_stores::{KeyboardMetaMergeError, StoreContext, apply_remote_keyboard_meta_index};
use pipette_sync_runtime::RemoteMemory;

pub use analytics_day::merge_device_day_bundle;
pub use deleted_ranges::{
    AnalyticsMerge, merge_typing_deleted_ranges_bundle, queue_own_deleted_ranges_apply,
};
pub use packs::PackRosters;
use pipette_typing_analytics::DataOps;
use pipette_typing_analytics::deleted_ranges::apply::ResetHolds;

use crate::units::{
    is_keyboard_meta_unit, pack_index_store, parse_deleted_ranges_unit, parse_device_day_unit,
    parse_pack_body_unit,
};

/// Which pack list changed (`i18n-pack:changed` / `theme-pack:changed`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PackKind {
    I18n,
    Theme,
}

/// Where the merges report what they wrote.
pub trait MergeEvents: Send + Sync {
    /// A merge rewrote `unit`'s local files (`sync:unit-applied`).
    fn unit_applied(&self, unit: &str);
    /// A merge of a pack unit ran (`i18n-pack:changed` / `theme-pack:changed`).
    fn pack_changed(&self, kind: PackKind);
}

/// What a merge works with.
pub struct MergeEnv<'a> {
    pub ctx: &'a StoreContext,
    pub events: &'a dyn MergeEvents,
    /// The Drive revisions handled; a roster merge forgets the body units
    /// it found missing, so the next pass downloads them.
    pub remote: &'a RemoteMemory,
    pub rosters: &'a PackRosters,
}

/// What the typing-analytics merges work with.
pub struct AnalyticsEnv<'a> {
    /// The write locks of the process: a deleted-ranges file is written
    /// under the lock of its unit, which its local writers take too.
    pub ctx: &'a StoreContext,
    /// The cache, the clock and this device's flush chain.
    pub ops: &'a Arc<DataOps>,
    /// Whether a reset holds a keyboard (`resetHoldsKeyboard`): nothing of
    /// this device's own ranges is applied to a keyboard a reset removes.
    pub holds: ResetHolds,
}

/// Why a merge failed. Nothing is recorded for a failed unit, so the next
/// pass tries it again.
#[derive(Debug, thiserror::Error)]
pub enum MergeError {
    /// The bundle or the unit name is not of a shape the merge accepts
    /// (`MalformedSyncBundleError`); the text carries only the unit name.
    #[error("malformed sync bundle index for {0}")]
    Malformed(String),
    /// A pack body arrived before the roster that brings its meta
    /// (`PackMetaPendingError`).
    #[error("sync: no local meta yet for {0}")]
    PackMetaPending(String),
    /// Where JavaScript throws a TypeError or a SyntaxError reading the
    /// bundle (a `null` bundle, a property of `null`, text that is not
    /// JSON).
    #[error("{0}")]
    Type(String),
    /// The unit is a typing-analytics day or deleted-ranges unit, which
    /// this merge does not handle.
    #[error("sync: {0} is not merged here")]
    NotHandled(String),
    #[error("{0}")]
    Other(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl From<pipette_pack_stores::sync::PackSyncError> for MergeError {
    fn from(err: pipette_pack_stores::sync::PackSyncError) -> Self {
        use pipette_pack_stores::sync::PackSyncError;
        match err {
            PackSyncError::Malformed(unit) => MergeError::Malformed(unit),
            PackSyncError::MetaPending(unit) => MergeError::PackMetaPending(unit),
            PackSyncError::Pack(err) => MergeError::Other(err.to_string()),
        }
    }
}

/// `bundle[key]`: reading a property of `null` throws; a value that is not
/// an object has none.
fn prop<'a>(bundle: &'a Value, key: &str) -> Result<Option<&'a Value>, MergeError> {
    match bundle {
        Value::Null => Err(MergeError::Type(format!("Cannot read properties of null (reading '{key}')"))),
        Value::Object(o) => Ok(o.get(key)),
        _ => Ok(None),
    }
}

/// `bundle?.[key]` of a value read with `prop`: `None` for a missing or
/// `null` value too.
fn opt_prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(o)) => o.get(key),
        _ => None,
    }
}

/// Merges the remote `bundle` (the parsed plaintext) of `unit` into the
/// local files and answers whether Drive needs this device's copy.
/// `remote_modified_time` is the Drive file's `modifiedTime`, the body
/// clock of a pack body sent by an app that predates it.
pub fn merge_sync_unit(
    env: &MergeEnv<'_>,
    unit: &str,
    bundle: &Value,
    remote_modified_time: &str,
) -> Result<bool, MergeError> {
    if is_keyboard_meta_unit(unit) {
        let index = prop(bundle, "index")?.cloned().unwrap_or(Value::Null);
        let merged = apply_remote_keyboard_meta_index(env.ctx, &index).map_err(|err| match err {
            KeyboardMetaMergeError::Malformed => MergeError::Type(err.to_string()),
            KeyboardMetaMergeError::Store(err) => MergeError::Other(err.to_string()),
        })?;
        if merged.applied {
            env.events.unit_applied(unit);
        }
        return Ok(merged.remote_needs_update);
    }

    // The unit name may come from a Drive file name, which anyone who can
    // write to this app's Drive folder chooses: every segment must be a
    // safe path segment before any branch joins it into a path. Refusing
    // it as malformed lets the polling skip that revision instead of
    // retrying it every 3 minutes.
    let parts: Vec<&str> = unit.split('/').collect();
    if parts.iter().any(|p| !is_safe_path_segment(p)) {
        return Err(MergeError::Malformed(unit.to_owned()));
    }
    if parse_device_day_unit(unit).is_some() || parse_deleted_ranges_unit(unit).is_some() {
        return Err(MergeError::NotHandled(unit.to_owned()));
    }
    if let ["keyboards", uid, "settings"] = parts.as_slice() {
        return settings::merge_settings(env, unit, uid, bundle);
    }
    if let Some(store) = pack_index_store(unit) {
        return packs::merge_pack_index(env, store, unit, bundle);
    }
    if let Some((store, id)) = parse_pack_body_unit(unit) {
        return packs::merge_pack_body(env, store, id, bundle, remote_modified_time);
    }
    index_store::merge_index_store(env, unit, &parts, bundle)
}

/// Merges the remote `bundle` of a typing-analytics day or deleted-ranges
/// `unit` (what [`merge_sync_unit`] answers [`MergeError::NotHandled`]
/// for). A day answers that Drive needs nothing; a deleted-ranges unit
/// answers [`AnalyticsMerge`]. Any other unit is [`MergeError::NotHandled`].
pub async fn merge_analytics_unit(
    env: &AnalyticsEnv<'_>,
    unit: &str,
    bundle: &Value,
    own_hash: &str,
) -> Result<AnalyticsMerge, MergeError> {
    if let Some(day) = parse_device_day_unit(unit) {
        merge_device_day_bundle(env, bundle, day, own_hash).await?;
        return Ok(AnalyticsMerge { remote_needs_update: false, own_apply: None });
    }
    if let Some(ranges) = parse_deleted_ranges_unit(unit) {
        if !is_safe_path_segment(ranges.uid) || !is_safe_path_segment(ranges.machine_hash) {
            return Err(MergeError::Malformed(unit.to_owned()));
        }
        return merge_typing_deleted_ranges_bundle(env, unit, bundle, ranges, own_hash).await;
    }
    Err(MergeError::NotHandled(unit.to_owned()))
}
