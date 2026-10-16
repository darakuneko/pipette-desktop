// SPDX-License-Identifier: GPL-2.0-or-later
//! The merge of a downloaded deleted-ranges bundle
//! (`keyboards/{uid}/devices/{hash}/deleted-ranges`) into the local file
//! (src/main/sync/typing-deleted-ranges-merge.ts): the union of the
//! entries by id, read, merged and written under the file's store lock.
//! What follows runs after that lock is released, with the merged entries
//! from memory: the store lock is not reentrant, and the follow-up must not
//! read the file under it again.
//!
//! A whole sync of the unit (download, merge, upload) runs under the unit's
//! `sync:` lock ([`crate::unit_locks`]), which the caller holds.

use std::sync::Arc;

use pipette_js_json::Value;
use pipette_typing_analytics::DataOps;
use pipette_typing_analytics::deleted_ranges::apply::ResetHolds;
use pipette_typing_analytics::deleted_ranges::{
    DeletedRangeEntry, DeletedRangesError, parse_deleted_ranges_file, union_deleted_ranges,
    update_deleted_ranges,
};
use pipette_typing_analytics::jsonl::DELETED_RANGES_FILENAME;
use pipette_typing_analytics_db::DeleteRange;
use tokio::task::JoinHandle;

use super::{AnalyticsEnv, MergeError, blocking, other, prop};
use crate::units::DeletedRangesUnit;

/// What a typing-analytics merge did.
#[derive(Debug)]
pub struct AnalyticsMerge {
    /// Drive lacks entries this device holds.
    pub remote_needs_update: bool,
    /// The apply of this device's own ranges to its own days, queued on the
    /// flush chain and not awaited: the caller may hold the unit's `sync:`
    /// lock, and the flush chain never waits on a sync lock. Dropping the
    /// handle leaves it running.
    pub own_apply: Option<JoinHandle<()>>,
}

/// The parsed file of a remote bundle. A bundle without a string file, or
/// whose file is not JSON, is malformed.
fn remote_file(bundle: &Value, unit: &str) -> Result<Value, MergeError> {
    let malformed = || MergeError::Malformed(unit.to_owned());
    let Some(Value::Object(files)) = prop(bundle, "files")? else { return Err(malformed()) };
    let Some(Value::String(raw)) = files.get(DELETED_RANGES_FILENAME) else { return Err(malformed()) };
    pipette_js_json::parse(&raw.to_string_lossy()).map_err(|_| malformed())
}

fn store_error(err: DeletedRangesError) -> MergeError {
    match err {
        DeletedRangesError::Io(err) => MergeError::Io(err),
        err => MergeError::Other(format!("{err}")),
    }
}

/// Merges `bundle`'s entries into the local file of `ranges` and answers
/// whether Drive lacks entries this device holds. For another device's
/// file every merged entry is then tombstoned in the cache in one
/// transaction, so a tombstone that failed on an earlier merge is made up
/// by the next one. For this device's own file the entries are queued to
/// be applied to its own day files (`apply_own_deleted_ranges`, which
/// skips the ids already applied). A local file that cannot be read fails
/// before the remote file's shape is looked at, and is left as it is.
pub async fn merge_typing_deleted_ranges_bundle(
    env: &AnalyticsEnv<'_>,
    unit: &str,
    bundle: &Value,
    ranges: DeletedRangesUnit<'_>,
    own_hash: &str,
) -> Result<AnalyticsMerge, MergeError> {
    let remote = parse_deleted_ranges_file(&remote_file(bundle, unit)?);
    let malformed = remote.is_none();
    let (locks, user_data, uid, hash) = (
        env.ctx.shared_locks(),
        env.ops.analytics().user_data().to_path_buf(),
        ranges.uid.to_owned(),
        ranges.machine_hash.to_owned(),
    );
    let union = blocking(move || {
        // A remote file of the wrong shape unions nothing, so nothing is
        // written; it is refused once the local read succeeded.
        update_deleted_ranges(&locks, &user_data, &uid, &hash, |local| {
            union_deleted_ranges(&local, remote.as_deref().unwrap_or_default())
        })
        .map_err(store_error)
    })
    .await?;
    if malformed {
        return Err(MergeError::Malformed(unit.to_owned()));
    }

    let own_apply = if union.entries.is_empty() {
        None
    } else if ranges.machine_hash != own_hash {
        let ready = env.ops.analytics().ready().await.map_err(other)?;
        let entries: Vec<DeleteRange> = union.entries.iter().map(|entry| entry.range).collect();
        let (uid, hash, now) =
            (ranges.uid.to_owned(), ranges.machine_hash.to_owned(), env.ops.analytics().now_ms());
        ready
            .db
            .call(move |db| db.tombstone_ranges_for_uid_hash(&uid, &hash, &entries, now))
            .await
            .map_err(other)?
            .map_err(other)?;
        None
    } else {
        Some(queue_own_apply(env.ops.clone(), ranges.uid, union.entries, env.holds.clone()))
    };
    Ok(AnalyticsMerge { remote_needs_update: union.remote_needs_update, own_apply })
}

fn queue_own_apply(
    ops: Arc<DataOps>,
    uid: &str,
    entries: Vec<DeletedRangeEntry>,
    holds: ResetHolds,
) -> JoinHandle<()> {
    let uid = uid.to_owned();
    tokio::spawn(async move {
        if let Err(err) = ops.apply_own_deleted_ranges(&uid, entries, holds).await {
            log::warn!("typing-analytics: deleted ranges of {uid} not applied: Error: {err}");
        }
    })
}

/// `queueOwnDeletedRangesApply`: queues the apply of this device's own
/// deleted ranges of every keyboard, read from the local files (the ids
/// already applied are skipped). Run at the end of each sync pass, so an
/// apply that a reset skipped or that failed is tried again even when Drive
/// has nothing new and no merge of the ranges unit runs. Not awaited by the
/// pass, which holds a sync lock while the apply waits on the flush chain.
pub fn queue_own_deleted_ranges_apply(ops: Arc<DataOps>, holds: ResetHolds) -> JoinHandle<()> {
    tokio::spawn(async move { ops.apply_own_deleted_ranges_for_all_keyboards(holds).await })
}
