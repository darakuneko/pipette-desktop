// SPDX-License-Identifier: GPL-2.0-or-later
//! The deleted-ranges file of one (keyboard uid, machine hash): time ranges
//! deleted from that device's typing data, written by another device (the Sync
//! tab's delete) or by the owner itself (the Local tab's Delete All). Each
//! entry removes the rows whose time (minute start, session start) is in
//! `[startMs, endMs)` and at or before `cutoffMs`, the moment the delete was
//! asked for, so typing recorded after the delete stays. Entries never change
//! once written; devices combine their copies by taking the union of the ids.
//!
//! File: `{ "version": 1, "entries": [{ id, startMs, endMs, cutoffMs }] }`,
//! two-space indented, the entries sorted by (`cutoffMs`, id) so every
//! device writes the same file for the same set.

use std::collections::HashSet;

use pipette_js_json::{JsString, Object, Value};
use pipette_typing_analytics_db::DeleteRange;

use crate::jsonl::paths::{InvalidUtcDay, utc_day_boundary_ms};

const FILE_VERSION: f64 = 1.0;

/// Longest accepted id in UTF-16 code units, a bound on hostile input.
const MAX_ID_UNITS: usize = 128;

/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, Clone, PartialEq)]
pub struct DeletedRangeEntry {
    /// Any JavaScript string a file holds, a lone surrogate included.
    pub id: JsString,
    pub range: DeleteRange,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeletedRangesUnion {
    pub entries: Vec<DeletedRangeEntry>,
    /// The other side held an id this side lacks.
    pub local_changed: bool,
    /// This side holds an id the other side lacks.
    pub remote_needs_update: bool,
}

/// `Number.isSafeInteger(v) && v >= 0` (`-0` included, read as 0).
fn time(value: Option<&Value>) -> Option<i64> {
    match value {
        // Whole and within ±2^53, so the cast is exact.
        Some(Value::Number(n)) if n.fract() == 0.0 && *n >= 0.0 && *n <= MAX_SAFE_INTEGER => Some(*n as i64),
        _ => None,
    }
}

/// `isDeletedRangeEntry`: an object with an id of 1 to 128 UTF-16 code
/// units and three safe non-negative integer times, `endMs > startMs`.
pub fn parse_entry(value: &Value) -> Option<DeletedRangeEntry> {
    let Value::Object(e) = value else { return None };
    let Some(Value::String(id)) = e.get("id") else { return None };
    let units = id.utf16_units().len();
    if units == 0 || units > MAX_ID_UNITS {
        return None;
    }
    let (start_ms, end_ms, cutoff_ms) =
        (time(e.get("startMs"))?, time(e.get("endMs"))?, time(e.get("cutoffMs"))?);
    if end_ms <= start_ms {
        return None;
    }
    Some(DeletedRangeEntry { id: id.clone(), range: DeleteRange { start_ms, end_ms, cutoff_ms } })
}

/// The fixed order of a file: by `cutoffMs`, then by id as JavaScript
/// compares strings (UTF-16 code units). The sort is stable.
fn sort_entries(entries: &mut [DeletedRangeEntry]) {
    entries.sort_by_cached_key(|e| (e.range.cutoff_ms, e.id.utf16_units()));
}

/// `parseDeletedRangesFile`: the valid entries of a parsed file, the first
/// copy of each id kept, sorted; `None` when the file itself has the wrong
/// shape. Only the four known fields are kept.
pub fn parse_deleted_ranges_file(value: &Value) -> Option<Vec<DeletedRangeEntry>> {
    let Value::Object(file) = value else { return None };
    if !matches!(file.get("version"), Some(Value::Number(v)) if *v == FILE_VERSION) {
        return None;
    }
    let Some(Value::Array(items)) = file.get("entries") else { return None };
    let mut seen = HashSet::new();
    let mut entries: Vec<DeletedRangeEntry> =
        items.iter().filter_map(parse_entry).filter(|entry| seen.insert(entry.id.clone())).collect();
    sort_entries(&mut entries);
    Some(entries)
}

fn entry_value(entry: &DeletedRangeEntry) -> Value {
    let mut object = Object::new();
    object.insert("id", Value::String(entry.id.clone()));
    // Safe integers, so the conversions are exact.
    object.insert("startMs", Value::Number(entry.range.start_ms as f64));
    object.insert("endMs", Value::Number(entry.range.end_ms as f64));
    object.insert("cutoffMs", Value::Number(entry.range.cutoff_ms as f64));
    Value::Object(object)
}

/// `serializeDeletedRanges`: the file text, two-space indented.
pub fn serialize_deleted_ranges(entries: &[DeletedRangeEntry]) -> String {
    let mut file = Object::new();
    file.insert("version", Value::Number(FILE_VERSION));
    file.insert("entries", Value::Array(entries.iter().map(entry_value).collect()));
    pipette_js_json::stringify_with_gap(&Value::Object(file), "  ")
}

/// `unionDeletedRanges`: the union by id, sorted; for an id both sides
/// hold, the local copy is kept.
pub fn union_deleted_ranges(local: &[DeletedRangeEntry], other: &[DeletedRangeEntry]) -> DeletedRangesUnion {
    let local_ids: HashSet<&JsString> = local.iter().map(|e| &e.id).collect();
    let other_ids: HashSet<&JsString> = other.iter().map(|e| &e.id).collect();
    let added: Vec<&DeletedRangeEntry> = other.iter().filter(|e| !local_ids.contains(&e.id)).collect();
    let remote_needs_update = local.iter().any(|l| !other_ids.contains(&l.id));
    let local_changed = !added.is_empty();
    let mut entries: Vec<DeletedRangeEntry> = local.iter().chain(added).cloned().collect();
    sort_entries(&mut entries);
    DeletedRangesUnion { entries, local_changed, remote_needs_update }
}

/// A local day that is not a `YYYY-MM-DD` day a `Date` can hold
/// (`deletedRangesForLocalDays` throws a RangeError).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Invalid local day: {0}")]
pub struct InvalidLocalDay(pub String);

/// `deletedRangesForLocalDays`: one entry per run of consecutive local
/// calendar days of `dates` (any order, duplicates allowed), each from the
/// first day's local midnight to the midnight after the last day, all with
/// `cutoff_ms`. A run joins days whose ranges touch or overlap, so a 23 or
/// 25 hour day joins its neighbours too. The days are read in the system
/// time zone, as `localDayRangeMs` reads them.
pub fn deleted_ranges_for_local_days(
    dates: &[&str],
    cutoff_ms: i64,
    mut new_id: impl FnMut() -> String,
) -> Result<Vec<DeletedRangeEntry>, InvalidLocalDay> {
    let mut ranges = dates
        .iter()
        .map(|date| pipette_time::local_day_range_ms(date).ok_or_else(|| InvalidLocalDay((*date).to_owned())))
        .collect::<Result<Vec<(i64, i64)>, _>>()?;
    ranges.sort_by_key(|&(start, _)| start);
    let mut joined: Vec<(i64, i64)> = Vec::new();
    for (start, end) in ranges {
        match joined.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => joined.push((start, end)),
        }
    }
    Ok(joined
        .into_iter()
        .map(|(start_ms, end_ms)| DeletedRangeEntry {
            id: new_id().into(),
            range: DeleteRange { start_ms, end_ms, cutoff_ms },
        })
        .collect())
}

/// `deletedRangeForAll`: every time at or before `cutoff_ms`.
pub fn deleted_range_for_all(cutoff_ms: i64, id: &str) -> DeletedRangeEntry {
    DeletedRangeEntry { id: id.into(), range: DeleteRange { start_ms: 0, end_ms: cutoff_ms + 1, cutoff_ms } }
}

/// `clipToUtcDay`: the parts of `ranges` inside `utc_day`. A day file only
/// holds rows whose time is in its UTC day, so applying the result to that
/// file touches nothing outside it.
pub fn clip_to_utc_day(ranges: &[DeleteRange], utc_day: &str) -> Result<Vec<DeleteRange>, InvalidUtcDay> {
    let (day_start, day_end) = utc_day_boundary_ms(utc_day)?;
    Ok(ranges
        .iter()
        .filter_map(|r| {
            let (start_ms, end_ms) = (r.start_ms.max(day_start), r.end_ms.min(day_end));
            (start_ms < end_ms).then_some(DeleteRange { start_ms, end_ms, cutoff_ms: r.cutoff_ms })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, cutoff_ms: i64) -> DeletedRangeEntry {
        DeletedRangeEntry { id: id.into(), range: DeleteRange { start_ms: 0, end_ms: 50, cutoff_ms } }
    }

    fn parse(text: &str) -> Option<DeletedRangeEntry> {
        parse_entry(&pipette_js_json::parse(text).unwrap())
    }

    #[test]
    fn checks_each_entry() {
        assert_eq!(parse(r#"{"id":"a","startMs":0,"endMs":50,"cutoffMs":100}"#), Some(entry("a", 100)));
        for text in [
            "null",
            r#"{"startMs":0,"endMs":1,"cutoffMs":1}"#,
            r#"{"id":"","startMs":0,"endMs":1,"cutoffMs":1}"#,
            r#"{"id":"a","startMs":5,"endMs":5,"cutoffMs":1}"#,
            r#"{"id":"a","startMs":-1,"endMs":5,"cutoffMs":1}"#,
            r#"{"id":"a","startMs":0.5,"endMs":5,"cutoffMs":1}"#,
            r#"{"id":"a","startMs":"0","endMs":5,"cutoffMs":1}"#,
            r#"{"id":"a","startMs":0,"endMs":5,"cutoffMs":1e400}"#,
            r#"{"id":"a","startMs":0,"endMs":9007199254740992,"cutoffMs":1}"#,
        ] {
            assert_eq!(parse(text), None, "{text}");
        }
        assert!(
            parse(&format!(r#"{{"id":"{}","startMs":0,"endMs":1,"cutoffMs":1}}"#, "x".repeat(129))).is_none()
        );
    }

    #[test]
    fn unions_by_id_keeping_the_local_copy() {
        let shared = DeletedRangeEntry {
            id: "a".into(),
            range: DeleteRange { start_ms: 0, end_ms: 10, cutoff_ms: 1 },
        };
        let result = union_deleted_ranges(&[entry("b", 2), entry("a", 9)], &[shared, entry("c", 2)]);
        assert_eq!(result.entries, [entry("b", 2), entry("c", 2), entry("a", 9)]);
        assert!(result.local_changed && result.remote_needs_update);
        let same = union_deleted_ranges(&[entry("a", 1)], &[entry("a", 1)]);
        assert!(!same.local_changed && !same.remote_needs_update);
    }

    #[test]
    fn delete_all_covers_the_cutoff() {
        assert_eq!(
            deleted_range_for_all(500, "x"),
            DeletedRangeEntry {
                id: "x".into(),
                range: DeleteRange { start_ms: 0, end_ms: 501, cutoff_ms: 500 }
            }
        );
        assert_eq!(deleted_ranges_for_local_days(&[], 1, || unreachable!()), Ok(Vec::new()));
        assert_eq!(
            deleted_ranges_for_local_days(&["2026-4-1"], 1, || "id".into()),
            Err(InvalidLocalDay("2026-4-1".into()))
        );
    }
}
