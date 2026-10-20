// SPDX-License-Identifier: GPL-2.0-or-later
//! This device applying the ranges of its own hash's deleted-ranges file to
//! its own typing data:
//! the rows in them are marked deleted in its day files
//! (day_delete.rs), which then sync like any other change. The ids already
//! applied are kept in a local record (`deleted-ranges-applied.json`) so
//! each range is applied once; the range of this device's own Delete All
//! goes into the record once that delete has removed every day file
//! (retention.rs).

use std::sync::Arc;

use pipette_js_json::JsString;

use super::model::{DeletedRangeEntry, clip_to_utc_day};
use super::store::{read_applied_ids, read_deleted_ranges, write_applied_ids};
use crate::Error;
use crate::data_ops::{DataOps, blocking};
use crate::day_delete::mark_own_typing_in_ranges_on_chain;
use crate::jsonl::paths::{deleted_ranges_applied_path, keyboards_root};

/// Whether a reset holds a keyboard (`resetHoldsKeyboard`): nothing is
/// applied to a keyboard whose data a reset is removing.
pub type ResetHolds = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// The step an import runs right after it replaced one of this device's day
/// files (see [`DataOps::prepare_own_deleted_ranges_reapply`]).
pub struct Reapply {
    uid: String,
    ranges: Vec<pipette_typing_analytics_db::DeleteRange>,
}

impl Reapply {
    /// Marks again the rows of the replaced day inside the ranges; must
    /// run inside the import's flush chain task.
    pub async fn run(self, ops: &DataOps) -> Result<(), Error> {
        if !self.ranges.is_empty() {
            mark_own_typing_in_ranges_on_chain(ops.recorder(), &self.uid, self.ranges).await?;
        }
        Ok(())
    }
}

impl DataOps {
    /// `applyOwnDeletedRanges`: applies the entries of `uid` not yet in the
    /// record, as one flush chain task, and adds their ids to the record
    /// once that task has run without failing. Does nothing while `holds`
    /// says a reset holds `uid` (checked before queuing, when the task
    /// starts and before the record is written). The record is written into
    /// the existing device directory and never creates it, so a reset that
    /// removed the directory leaves it removed.
    pub async fn apply_own_deleted_ranges(
        &self,
        uid: &str,
        entries: Vec<DeletedRangeEntry>,
        holds: ResetHolds,
    ) -> Result<(), Error> {
        if entries.is_empty() || holds(uid) {
            return Ok(());
        }
        let (recorder, uid) = (self.recorder().clone(), uid.to_owned());
        self.on_chain(async move {
            if holds(&uid) {
                return Ok(());
            }
            let analytics = recorder.analytics().clone();
            let path = deleted_ranges_applied_path(
                analytics.user_data(),
                &uid,
                &analytics.ready().await?.machine_hash,
            );
            let record = path.clone();
            let mut applied = blocking(move || Ok::<_, Error>(read_applied_ids(&record))).await?;
            let pending: Vec<DeletedRangeEntry> =
                entries.into_iter().filter(|entry| !applied.contains(&entry.id)).collect();
            if pending.is_empty() {
                return Ok(());
            }
            let ranges = pending.iter().map(|entry| entry.range).collect();
            mark_own_typing_in_ranges_on_chain(&recorder, &uid, ranges).await?;
            if holds(&uid) {
                return Ok(());
            }
            applied.extend(pending.into_iter().map(|entry| entry.id));
            blocking(move || write_applied_ids(&path, &applied)).await
        })
        .await
    }

    /// `recordOwnDeletedRangeApplied`: adds `id` to `uid`'s applied record,
    /// as one flush chain task (the apply reads and writes the record on
    /// the same chain), for a range whose rows this device has removed
    /// itself. Like the apply, it writes into the existing directory.
    pub async fn record_own_deleted_range_applied(&self, uid: &str, id: JsString) -> Result<(), Error> {
        let (analytics, uid) = (self.analytics().clone(), uid.to_owned());
        self.on_chain(async move {
            let path = deleted_ranges_applied_path(
                analytics.user_data(),
                &uid,
                &analytics.ready().await?.machine_hash,
            );
            blocking(move || {
                let mut applied = read_applied_ids(&path);
                applied.insert(id);
                write_applied_ids(&path, &applied)
            })
            .await
        })
        .await
    }

    /// `prepareOwnDeletedRangesReapply`: for an import about to replace the
    /// day file of (`uid`, `machine_hash`, `utc_day`), inside its flush
    /// chain task: reads this device's own deleted ranges of `uid` (fails
    /// when they cannot be read, so the file is left as it is) and returns
    /// the step that marks again the rows of that day inside every range,
    /// applied before or not, so an import cannot bring deleted typing
    /// back. That includes the range of this device's own Delete All, so an
    /// export taken after that delete loses, on import, what was typed after
    /// the click within the same minute. Another device's file gets a step
    /// that does nothing.
    pub async fn prepare_own_deleted_ranges_reapply(
        &self,
        uid: &str,
        machine_hash: &str,
        utc_day: &str,
    ) -> Result<Reapply, Error> {
        let own = self.machine_hash().await?;
        let mut reapply = Reapply { uid: uid.to_owned(), ranges: Vec::new() };
        if machine_hash != own {
            return Ok(reapply);
        }
        let (user_data, owner, day) =
            (self.analytics().user_data().to_path_buf(), uid.to_owned(), utc_day.to_owned());
        reapply.ranges = blocking(move || {
            let ranges: Vec<_> =
                read_deleted_ranges(&user_data, &owner, &own)?.into_iter().map(|entry| entry.range).collect();
            Ok::<_, Error>(clip_to_utc_day(&ranges, &day).unwrap_or_default())
        })
        .await?;
        Ok(reapply)
    }

    /// `applyOwnDeletedRangesForAllKeyboards`: applies this device's own
    /// deleted-ranges file of every keyboard directory that has one (a
    /// missing file has no entries), at startup and after each sync pass.
    /// A keyboard whose file cannot be read or applied is logged and
    /// skipped.
    pub async fn apply_own_deleted_ranges_for_all_keyboards(&self, holds: ResetHolds) {
        let root = keyboards_root(self.analytics().user_data());
        let Ok(Ok(mut uids)) = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<String>> {
            let mut uids = Vec::new();
            for entry in std::fs::read_dir(root)? {
                let entry = entry?;
                if entry.file_type()?.is_dir()
                    && let Ok(uid) = entry.file_name().into_string()
                {
                    uids.push(uid);
                }
            }
            Ok(uids)
        })
        .await
        else {
            return;
        };
        uids.sort();
        let Ok(own) = self.machine_hash().await else { return };
        for uid in uids {
            let (user_data, owner, hash) =
                (self.analytics().user_data().to_path_buf(), uid.clone(), own.clone());
            let applied = async {
                let entries = blocking(move || read_deleted_ranges(&user_data, &owner, &hash)).await?;
                self.apply_own_deleted_ranges(&uid, entries, holds.clone()).await
            };
            if let Err(err) = applied.await {
                log::warn!("typing-analytics: deleted ranges of {uid} not applied: Error: {err}");
            }
        }
    }
}
