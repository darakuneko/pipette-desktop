// SPDX-License-Identifier: GPL-2.0-or-later
//! Replaying one day file of a device into the cache while keeping that
//! device's deleted ranges hidden (`replayDayRowsHidingDeletedRanges`,
//! src/main/typing-analytics/deleted-ranges-cache.ts).
//!
//! It runs as one operation on the database thread: the ranges are read
//! right before the transaction, so a ranges file written while an earlier
//! day was being replayed is already used, and the rows and the ranges'
//! tombstones are written in that one transaction, so a reader never sees
//! an in-range row live. This device's own hash is never hidden this way:
//! its owner removes the rows from its own files.

use pipette_entry_store::Clock;
use pipette_typing_analytics_db::{ApplyRowsResult, DeleteRange, TypingAnalyticsDb};

/// Apply `text`, the day file of `machine_hash` for `uid`. For another
/// device, `deleted_ranges` gives that device's deleted ranges clipped to
/// the file's UTC day (an unreadable ranges file gives none), and the rows
/// in them are tombstoned at the clock's time.
pub fn replay_day_hiding_deleted_ranges(
    db: &mut TypingAnalyticsDb,
    text: &str,
    uid: &str,
    machine_hash: &str,
    own_hash: &str,
    clock: &dyn Clock,
    deleted_ranges: impl FnOnce() -> Vec<DeleteRange>,
) -> Result<ApplyRowsResult, pipette_typing_analytics_db::Error> {
    if machine_hash == own_hash {
        return db.apply_day_jsonl(text);
    }
    let ranges = deleted_ranges();
    db.apply_day_jsonl_hiding_ranges(text, uid, machine_hash, &ranges, clock.now_ms())
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use pipette_entry_store::FixedClock;
    use pipette_typing_analytics_db::{ScopeFilters, TypingAnalyticsDb};

    use super::*;

    const MINUTE: i64 = 60_000;

    fn day(hash: &str) -> String {
        let scope = format!(
            r#"{{"id":"s","kind":"scope","updated_at":1,"payload":{{"id":"scope-{hash}","machineHash":"{hash}","osPlatform":"linux","osRelease":"6.8.0","osArch":"x64","keyboardUid":"uid","keyboardVendorId":1,"keyboardProductId":2,"keyboardProductName":"K"}}}}"#
        );
        let minutes = (0..3).map(|i| {
            format!(
                r#"{{"id":"m","kind":"minute-stats","updated_at":1,"payload":{{"scopeId":"scope-{hash}","minuteTs":{},"keystrokes":1,"activeMs":1,"intervalAvgMs":null,"intervalMinMs":null,"intervalP25Ms":null,"intervalP50Ms":null,"intervalP75Ms":null,"intervalMaxMs":null}}}}"#,
                i * MINUTE
            )
        });
        std::iter::once(scope).chain(minutes).map(|line| line + "\n").collect()
    }

    fn live_minutes(db: &TypingAnalyticsDb, hash: &str) -> usize {
        db.minute_stats_in_range("uid", Some(hash), 0.0, 1e15, &ScopeFilters::default()).unwrap().len()
    }

    const RANGE: DeleteRange = DeleteRange { start_ms: 0, end_ms: 2 * MINUTE, cutoff_ms: 2 * MINUTE };

    #[test]
    fn hides_another_devices_ranges_in_the_same_replay() {
        let mut db = TypingAnalyticsDb::open_in_memory().unwrap();
        let clock = FixedClock::new(5);
        let applied =
            replay_day_hiding_deleted_ranges(&mut db, &day("remote"), "uid", "remote", "own", &clock, || {
                vec![RANGE]
            })
            .unwrap();
        assert_eq!(applied.minute_stats, 3);
        assert_eq!(live_minutes(&db, "remote"), 1);
    }

    #[test]
    fn never_reads_or_hides_the_own_devices_ranges() {
        let mut db = TypingAnalyticsDb::open_in_memory().unwrap();
        let read = Cell::new(false);
        replay_day_hiding_deleted_ranges(
            &mut db,
            &day("own"),
            "uid",
            "own",
            "own",
            &FixedClock::new(5),
            || {
                read.set(true);
                vec![RANGE]
            },
        )
        .unwrap();
        assert!(!read.get());
        assert_eq!(live_minutes(&db, "own"), 3);
    }
}
