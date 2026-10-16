// SPDX-License-Identifier: GPL-2.0-or-later
//! The Sync tab's delete of another device's typing data
//! (src/main/sync/typing-device-delete.ts). Nothing is removed from Drive
//! or from that device's day files: the deleted time ranges are added to
//! that device's deleted-ranges file, the rows in them are hidden in this
//! cache at once, and the file syncs like any other unit. The owner removes
//! the rows from its own files when it next merges the file
//! (deleted_ranges/apply.rs), and every device keeps them hidden when it
//! replays the day files (cache_rebuild.rs).

use pipette_typing_analytics_db::DeleteRange;

use crate::Error;
use crate::data_ops::{DataOps, blocking};
use crate::deleted_ranges::{
    DeletedRangeEntry, deleted_range_for_all, deleted_ranges_for_local_days, union_deleted_ranges,
    update_deleted_ranges,
};
use crate::sync_units::typing_deleted_ranges_sync_unit;

/// What the Sync tab deletes of a device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceDays {
    /// Local calendar days (`YYYY-MM-DD`, in this process's time zone).
    Local(Vec<String>),
    All,
}

impl DataOps {
    /// `deleteDeviceTypingData`: deletes `machine_hash`'s typing of `uid` on
    /// `days`, limited to what was recorded at or before `cutoff_ms`. Works
    /// offline. Refuses this device's own hash ([`Error::OwnDeviceDelete`]):
    /// its days are deleted from the Local tab.
    pub async fn delete_device_data(
        &self,
        uid: &str,
        machine_hash: &str,
        days: DeviceDays,
        cutoff_ms: i64,
    ) -> Result<(), Error> {
        if machine_hash == self.machine_hash().await? {
            return Err(Error::OwnDeviceDelete);
        }
        let entries: Vec<DeletedRangeEntry> = match &days {
            DeviceDays::All => vec![deleted_range_for_all(cutoff_ms, &self.new_id())],
            DeviceDays::Local(dates) => {
                let dates: Vec<&str> = dates.iter().map(String::as_str).collect();
                deleted_ranges_for_local_days(&dates, cutoff_ms, || self.new_id())?
            }
        };
        if entries.is_empty() {
            return Ok(());
        }
        let ranges: Vec<DeleteRange> = entries.iter().map(|entry| entry.range).collect();
        let (locks, user_data, owner, hash) = (
            self.locks().clone(),
            self.analytics().user_data().to_path_buf(),
            uid.to_owned(),
            machine_hash.to_owned(),
        );
        blocking(move || {
            update_deleted_ranges(&locks, &user_data, &owner, &hash, |local| {
                union_deleted_ranges(&local, &entries)
            })
        })
        .await?;
        // After the file's lock is released: the lock is not reentrant.
        let ready = self.analytics().ready().await?;
        let updated_at = self.analytics().now_ms();
        let (owner, hash) = (uid.to_owned(), machine_hash.to_owned());
        ready
            .db
            .call(move |db| db.tombstone_ranges_for_uid_hash(&owner, &hash, &ranges, updated_at))
            .await??;
        self.recorder().notify(&typing_deleted_ranges_sync_unit(uid, machine_hash));
        Ok(())
    }
}
