// SPDX-License-Identifier: GPL-2.0-or-later
//! The trim of a keyboard's run logs (`applyRunLogRetention` of
//! src/main/sync/entry-merge.ts), shared by the save of a run and the sync
//! merge of the runs unit.
//!
//! The live entries are ranked by `startedAt`, which never changes for a
//! run, rather than by a local clock, so every device that merges the same
//! entries keeps the same set.

use std::cmp::Reverse;

use crate::clocks::{clock_ms, mark_deleted};
use crate::entry::Entry;

/// Keeps the `max` live entries of `entries` with the latest `startedAt`
/// (on a tie, the greater id by UTF-16 code units) and tombstones the other
/// live ones at `now_ms`. Returns the entries as kept, tombstoned, then
/// already deleted, and the ones it tombstoned. With `max` or fewer live
/// entries nothing changes and the order is kept.
pub fn apply_run_log_retention(entries: Vec<Entry>, max: usize, now_ms: i64) -> (Vec<Entry>, Vec<Entry>) {
    if entries.iter().filter(|entry| !entry.is_deleted()).count() <= max {
        return (entries, Vec::new());
    }
    let (mut alive, dead): (Vec<Entry>, Vec<Entry>) =
        entries.into_iter().partition(|entry| !entry.is_deleted());
    // Stable, as `Array.prototype.sort` is.
    alive.sort_by_cached_key(|entry| {
        let id = entry.id().map(|id| id.utf16_units()).unwrap_or_default();
        Reverse((clock_ms(entry.get("startedAt")), id))
    });
    let mut evicted = alive.split_off(max);
    for entry in &mut evicted {
        mark_deleted(entry, now_ms);
    }
    let mut kept = alive;
    kept.extend(evicted.iter().cloned());
    kept.extend(dead);
    (kept, evicted)
}

#[cfg(test)]
mod tests {
    use pipette_js_json::Object;

    use super::*;

    fn entry(id: &str, started_at: &str, deleted: bool) -> Entry {
        let mut object = Object::new();
        object.insert("id", id.into());
        object.insert("startedAt", started_at.into());
        if deleted {
            object.insert("deletedAt", "2026-01-01T00:00:00.000Z".into());
        }
        Entry::from_object(object)
    }

    fn ids(entries: &[Entry]) -> Vec<&str> {
        entries.iter().map(|e| e.id().unwrap().as_str().unwrap()).collect()
    }

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn at_or_under_the_cap_nothing_changes() {
        let entries = vec![
            entry("b", "2026-01-01T00:00:00.000Z", false),
            entry("dead", "2026-01-03T00:00:00.000Z", true),
            entry("a", "2026-01-02T00:00:00.000Z", false),
        ];
        let (kept, evicted) = apply_run_log_retention(entries, 2, NOW);
        assert_eq!(ids(&kept), ["b", "dead", "a"]);
        assert!(evicted.is_empty());
    }

    #[test]
    fn keeps_the_latest_starts_with_the_greater_id_first_on_a_tie() {
        let entries = vec![
            entry("old", "2026-01-01T00:00:00.000Z", false),
            entry("dead", "2026-01-09T00:00:00.000Z", true),
            entry("a", "2026-01-05T00:00:00.000Z", false),
            entry("b", "2026-01-05T00:00:00.000Z", false),
            entry("unparsed", "not a date", false),
            entry("new", "2026-01-07T00:00:00.000Z", false),
        ];
        let (kept, evicted) = apply_run_log_retention(entries, 3, NOW);
        assert_eq!(ids(&kept), ["new", "b", "a", "old", "unparsed", "dead"]);
        assert_eq!(ids(&evicted), ["old", "unparsed"]);
        assert!(evicted.iter().all(Entry::is_deleted));
        assert!(kept[..3].iter().all(|e| !e.is_deleted()));
    }

    #[test]
    fn ids_compare_by_utf16_code_units() {
        // U+FF5E sorts after U+1F600 by code units (0xFF5E > 0xD83D) but
        // before it by code points.
        let entries = vec![
            entry("\u{1F600}", "2026-01-01T00:00:00.000Z", false),
            entry("\u{FF5E}", "2026-01-01T00:00:00.000Z", false),
        ];
        let (kept, _) = apply_run_log_retention(entries, 1, NOW);
        assert_eq!(ids(&kept), ["\u{FF5E}", "\u{1F600}"]);
    }
}
