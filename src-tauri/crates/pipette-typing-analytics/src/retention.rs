// SPDX-License-Identifier: GPL-2.0-or-later
//! Deleting everything a keyboard recorded (`deleteAllTypingForKeyboard`,
//! src/main/typing-analytics/typing-analytics-retention.ts): the Local
//! tab's Delete All (this device's data) and Reset Keyboard Data (every
//! device's rows in the cache).
//!
//! The order, and what each failure leaves:
//! 1. The keyboard's sessions are closed and what it buffered up to the
//!    cutoff is dropped (on the flush chain).
//! 2. For the Local tab, the range "everything up to the cutoff" is added
//!    to this device's own deleted-ranges file, which the other devices
//!    use to hide the rows they hold. A file that cannot be updated fails
//!    the delete here, before anything is removed.
//! 3. The day files are listed, then each is removed: a missing one counts
//!    as removed; any other failure is logged and the next one is tried.
//! 4. The keyboard's rows are tombstoned in the cache (this device's for
//!    the Local tab, every device's for the reset), and when any was, the
//!    listed days are announced; for the Local tab the ranges unit too.
//! 5. Only when every file was removed is the range recorded as applied,
//!    so this device never applies it to itself (that would also remove
//!    what was typed after the click in the same minute). Otherwise the
//!    next apply marks the rows of the files left. A failed record is
//!    logged and leaves the same state.

use pipette_typing_analytics_db::TombstoneResult;

use crate::Error;
use crate::data_ops::{DataOps, blocking};
use crate::deleted_ranges::{deleted_range_for_all, union_deleted_ranges, update_deleted_ranges};
use crate::jsonl::paths::{device_day_jsonl_path, list_device_days};
use crate::sync_units::{typing_analytics_device_day_sync_unit, typing_deleted_ranges_sync_unit};

/// Whose rows a delete of everything tombstones.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteScope {
    /// This device's (the Local tab's Delete All).
    Own,
    /// Every device's (Reset Keyboard Data).
    All,
}

fn touched(result: &TombstoneResult) -> u64 {
    result.char_minutes
        + result.matrix_minutes
        + result.minute_stats
        + result.bigram_minutes
        + result.trigram_minutes
        + result.sessions
}

impl DataOps {
    /// `deleteAllTypingForKeyboard`: see the module documentation.
    /// `cutoff_ms` is when the user asked for the delete; what was typed in
    /// later minutes stays buffered and is written afterwards.
    pub async fn delete_all_for_keyboard(
        &self,
        uid: &str,
        cutoff_ms: i64,
        scope: DeleteScope,
    ) -> Result<TombstoneResult, Error> {
        // A session left open would be written on quit and bring the
        // keyboard back into Analyze.
        self.recorder().close_sessions_for_uid(uid, |_| true);
        // Dropped, not flushed: a kept entry of the clicked minute would be
        // reopened by the next keystroke and written back with the counts
        // from before the delete.
        let (recorder, owner) = (self.recorder().clone(), uid.to_owned());
        self.on_chain(async move {
            recorder.drop_buffered_typing(&owner, |ms| ms <= cutoff_ms as f64);
            Ok(())
        })
        .await?;
        let ready = self.analytics().ready().await?;
        let hash = ready.machine_hash.clone();
        let user_data = self.analytics().user_data().to_path_buf();

        let range_id = match scope {
            DeleteScope::Own => {
                let entry = deleted_range_for_all(cutoff_ms, &self.new_id());
                let id = entry.id.clone();
                let (locks, user_data, uid, hash) =
                    (self.locks().clone(), user_data.clone(), uid.to_owned(), hash.clone());
                blocking(move || {
                    update_deleted_ranges(&locks, &user_data, &uid, &hash, |local| {
                        union_deleted_ranges(&local, &[entry])
                    })
                })
                .await?;
                Some(id)
            }
            DeleteScope::All => None,
        };

        // Listed before the removal, so the removed days can be announced.
        let (remove_file, day_files) = (self.remove_file().clone(), user_data.clone());
        let (owner, owner_hash) = (uid.to_owned(), hash.clone());
        let (days, every_file_removed) = blocking(move || {
            let days = list_device_days(&day_files, &owner, &owner_hash);
            let mut every_file_removed = true;
            for day in &days {
                match remove_file(&device_day_jsonl_path(&day_files, &owner, &owner_hash, day)) {
                    Ok(()) => {}
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(err) => {
                        every_file_removed = false;
                        log::warn!(
                            "typing-analytics per-day unlink failed for {owner}/{owner_hash}/{day}: Error: {err}"
                        );
                    }
                }
            }
            Ok::<_, Error>((days, every_file_removed))
        })
        .await?;

        let updated_at = self.analytics().now_ms();
        let (owner, owner_hash) = (uid.to_owned(), hash.clone());
        let result = ready
            .db
            .call(move |db| match scope {
                DeleteScope::Own => db.tombstone_all_for_uid_hash(&owner, &owner_hash, updated_at),
                DeleteScope::All => db.tombstone_all_for_uid(&owner, updated_at),
            })
            .await??;
        if touched(&result) > 0 {
            for day in &days {
                self.recorder().notify(&typing_analytics_device_day_sync_unit(uid, &hash, day));
            }
        }
        if let Some(id) = range_id {
            self.recorder().notify(&typing_deleted_ranges_sync_unit(uid, &hash));
            if every_file_removed && let Err(err) = self.record_own_deleted_range_applied(uid, id).await {
                log::warn!(
                    "typing-analytics: Delete All range of {uid} not recorded as applied: Error: {err}"
                );
            }
        }
        Ok(result)
    }
}
