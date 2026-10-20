// SPDX-License-Identifier: GPL-2.0-or-later
//! Deleting part of this device's own typing data: the Data modal's Local tab
//! deleting local calendar days, and the ranges another device deleted from
//! this device's data (deleted_ranges/apply.rs).
//!
//! A local day overlaps one or two UTC day files, so whole files cannot be
//! removed. The rows inside the deleted ranges are appended again to the
//! same file with `is_deleted: true` and a newer `updated_at`: the files
//! stay append-only, and the LWW merge makes the marks win in this cache,
//! in a rebuild and on every device that replays the uploaded file.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use indexmap::IndexMap;
use pipette_js_json::{JsString, Object, Value};
use pipette_typing_analytics_db::{DeleteRange, TombstoneResult};

use crate::Error;
use crate::data_ops::{DataOps, blocking};
use crate::jsonl::paths::{device_day_jsonl_path, list_device_days, utc_day_boundary_ms};
use crate::jsonl::reader_writer::{append_lines_to_file, read_rows};
use crate::jsonl::row::{JsonlRow, RowKind, serialize_row};
use crate::pipeline::Recorder;
use crate::service::Ready;
use crate::sync_units::typing_analytics_device_day_sync_unit;

/// True for a time (a minute start, a session start) one of `ranges`
/// removes: in `[start, end)` and at or before the cutoff.
fn in_ranges(ranges: &[DeleteRange], ms: f64) -> bool {
    ranges.iter().any(|r| ms >= r.start_ms as f64 && ms < r.end_ms as f64 && ms <= r.cutoff_ms as f64)
}

fn payload(row: &JsonlRow) -> Option<&Object> {
    row.value().as_object()?.get("payload")?.as_object()
}

/// `rowTimeMs`: the time a row belongs to, the one its day file is picked
/// by: the minute start, or a session's start. `None` for scope rows.
fn row_time_ms(row: &JsonlRow) -> Option<f64> {
    let field = match row.kind() {
        RowKind::Scope => return None,
        RowKind::Session => "startMs",
        _ => "minuteTs",
    };
    match payload(row)?.get(field)? {
        Value::Number(ms) => Some(*ms),
        _ => None,
    }
}

fn updated_at(row: &JsonlRow) -> f64 {
    match row.value().as_object().and_then(|row| row.get("updated_at")) {
        Some(Value::Number(n)) => *n,
        _ => 0.0,
    }
}

fn is_deleted(row: &JsonlRow) -> bool {
    matches!(row.value().as_object().and_then(|row| row.get("is_deleted")), Some(Value::Bool(true)))
}

/// `daysOverlapping`: the days of `days` whose UTC day file can hold a row
/// one of `ranges` removes. Only existing files are walked, so a range from
/// 0 does not visit every day since 1970.
pub fn days_overlapping(days: &[String], ranges: &[DeleteRange]) -> Vec<String> {
    days.iter()
        .filter(|day| {
            let Ok((start, end)) = utc_day_boundary_ms(day) else { return false };
            ranges.iter().any(|r| r.start_ms < end && r.end_ms.min(r.cutoff_ms + 1) > start)
        })
        .cloned()
        .collect()
}

/// `cacheIdentity`: the cache row a JSONL row lands on, as the JSON text of
/// its primary key (an n-gram minute is one key; its pairs are its rows).
/// The row id is not enough: rows written before run tagging share one id
/// across the runs of a minute.
fn cache_identity(row: &JsonlRow) -> String {
    let empty = Object::new();
    let p = payload(row).unwrap_or(&empty);
    let get = |key: &str| p.get(key).cloned().unwrap_or(Value::Null);
    let mut key = vec![Value::from(row.kind().tag())];
    if row.kind() == RowKind::Session {
        key.push(get("id"));
    } else {
        let run = match p.get("runId") {
            None | Some(Value::Null) => Value::from(""),
            Some(run) => run.clone(),
        };
        key.extend([get("scopeId"), get("minuteTs"), run]);
        match row.kind() {
            RowKind::CharMinute => key.push(get("char")),
            RowKind::MatrixMinute => key.extend([get("row"), get("col"), get("layer")]),
            _ => {}
        }
    }
    pipette_js_json::stringify(&Value::Array(key))
}

/// The field of an n-gram minute that holds its pairs or triples.
fn ngram_field(kind: RowKind) -> Option<&'static str> {
    match kind {
        RowKind::BigramMinute => Some("bigrams"),
        RowKind::TrigramMinute => Some("trigrams"),
        _ => None,
    }
}

/// The copy of one n-gram (a pair or triple of one minute) the LWW replay
/// keeps.
struct NgramWinner {
    updated_at: f64,
    is_deleted: bool,
    entry: Value,
}

/// A row to mark, before it gets the delete flag and its `updated_at`.
pub struct RowToMark {
    pub kind: RowKind,
    pub row: Object,
}

/// `collectRowsToMark`: the rows of one day file a delete must mark, one
/// per cache row. For most kinds that is the copy the LWW replay keeps (the
/// highest `updated_at`, the first one on a tie), skipped when that copy is
/// already deleted. The cache keeps an n-gram minute as one row per pair,
/// each with its own LWW, so the same rule runs per pair, and the minute's
/// mark carries exactly the pairs whose kept copy is live. Also returns the
/// highest `updated_at` of the matched rows.
pub fn collect_rows_to_mark(rows: &[JsonlRow], marks: impl Fn(f64) -> bool) -> (Vec<RowToMark>, f64) {
    let mut winners: IndexMap<String, &JsonlRow> = IndexMap::new();
    let mut ngrams: HashMap<String, IndexMap<JsString, NgramWinner>> = HashMap::new();
    let mut newest = 0.0_f64;
    for row in rows {
        if !row_time_ms(row).is_some_and(&marks) {
            continue;
        }
        let row_updated_at = updated_at(row);
        newest = newest.max(row_updated_at);
        let key = cache_identity(row);
        match winners.get_mut(&key) {
            Some(current) if row_updated_at > updated_at(current) => *current = row,
            Some(_) => {}
            None => {
                winners.insert(key.clone(), row);
            }
        }
        let Some(field) = ngram_field(row.kind()) else { continue };
        let by_pair = ngrams.entry(key).or_default();
        let Some(Value::Object(entries)) = payload(row).and_then(|p| p.get(field)) else { continue };
        for (pair, entry) in entries.iter() {
            if by_pair.get(pair).is_none_or(|kept| row_updated_at > kept.updated_at) {
                let winner = NgramWinner {
                    updated_at: row_updated_at,
                    is_deleted: is_deleted(row),
                    entry: entry.clone(),
                };
                by_pair.insert(pair.clone(), winner);
            }
        }
    }
    let mut result = Vec::new();
    for (key, row) in winners {
        let kind = row.kind();
        let Some(field) = ngram_field(kind) else {
            if !is_deleted(row)
                && let Some(object) = row.value().as_object()
            {
                result.push(RowToMark { kind, row: object.clone() });
            }
            continue;
        };
        let mut live = Object::new();
        for (pair, kept) in ngrams.get(&key).into_iter().flatten() {
            if !kept.is_deleted {
                live.insert(pair.clone(), kept.entry.clone());
            }
        }
        if live.is_empty() {
            continue;
        }
        // The newest copy carries the minute's tags; the delete flag and the
        // new updated_at are set by the caller.
        let mut minute = payload(row).cloned().unwrap_or_default();
        minute.insert(field, live.into());
        let updated = row.value().as_object().and_then(|r| r.get("updated_at")).cloned();
        let mark: Object = [
            ("id", Value::String(row.id().clone())),
            ("updated_at", updated.unwrap_or(Value::Null)),
            ("kind", Value::from(kind.tag())),
            ("payload", minute.into()),
        ]
        .into_iter()
        .collect();
        result.push(RowToMark { kind, row: mark });
    }
    (result, newest)
}

fn count_mark(result: &mut TombstoneResult, kind: RowKind) {
    match kind {
        RowKind::CharMinute => result.char_minutes += 1,
        RowKind::MatrixMinute => result.matrix_minutes += 1,
        RowKind::MinuteStats => result.minute_stats += 1,
        RowKind::BigramMinute => result.bigram_minutes += 1,
        RowKind::TrigramMinute => result.trigram_minutes += 1,
        RowKind::Session => result.sessions += 1,
        RowKind::Scope => {}
    }
}

/// `markOwnTypingInRangesOnChain`: deletes `uid`'s own typing in `ranges`.
/// Must run inside a flush chain task, so no flush writes in between: it
/// closes the active sessions that started in the ranges, drops the
/// buffered data of the ranges, then appends the delete marks to each
/// overlapping day file and applies them to the cache, announcing each day
/// that got marks. In-range rows whose kept copy is already a mark (written
/// by an earlier run whose cache step failed) are replayed into the cache
/// again, so a retry repairs the cache. Returns the marked rows per kind.
pub async fn mark_own_typing_in_ranges_on_chain(
    recorder: &Arc<Recorder>,
    uid: &str,
    ranges: Vec<DeleteRange>,
) -> Result<TombstoneResult, Error> {
    recorder.close_sessions_for_uid(uid, |ms| in_ranges(&ranges, ms));
    recorder.drop_buffered_typing(uid, |ms| in_ranges(&ranges, ms));
    // Fails before anything is written when the cache cannot be opened.
    let ready = recorder.analytics().ready().await?;
    let (recorder, uid) = (recorder.clone(), uid.to_owned());
    blocking(move || mark_day_files(&recorder, &ready, &uid, &ranges)).await
}

fn mark_day_files(
    recorder: &Recorder,
    ready: &Ready,
    uid: &str,
    ranges: &[DeleteRange],
) -> Result<TombstoneResult, Error> {
    let user_data: &Path = recorder.analytics().user_data();
    let hash = &ready.machine_hash;
    let marks = |ms: f64| in_ranges(ranges, ms);
    let mut by_day = Vec::new();
    let mut newest = 0.0_f64;
    for day in days_overlapping(&list_device_days(user_data, uid, hash), ranges) {
        // A listed day that cannot be read fails the task, so a caller that
        // records what it applied does not record this day as done.
        let rows = read_rows(&device_day_jsonl_path(user_data, uid, hash, &day), None, true)?.rows;
        let in_range: Vec<&JsonlRow> = rows
            .iter()
            .filter(|row| row.kind() == RowKind::Scope || row_time_ms(row).is_some_and(marks))
            .collect();
        if in_range.iter().any(|row| row.kind() != RowKind::Scope && is_deleted(row)) {
            let text: String = in_range.iter().map(|row| row.serialize()).collect();
            ready.db.call_blocking(move |db| db.apply_day_jsonl(&text))??;
        }
        let (found, newest_of_day) = collect_rows_to_mark(&rows, marks);
        if found.is_empty() {
            continue;
        }
        newest = newest.max(newest_of_day);
        by_day.push((day, found));
    }
    let mut result = TombstoneResult::default();
    if by_day.is_empty() {
        return Ok(result);
    }
    let updated_at = recorder.claim_own_row_updated_at(newest);
    for (day, found) in by_day {
        let mut lines = String::new();
        for RowToMark { kind, mut row } in found {
            row.insert("is_deleted", Value::Bool(true));
            row.insert("updated_at", Value::Number(updated_at));
            lines.push_str(&serialize_row(&row.into()));
            count_mark(&mut result, kind);
        }
        append_lines_to_file(&device_day_jsonl_path(user_data, uid, hash, &day), lines.clone())?;
        ready.db.call_blocking(move |db| db.apply_day_jsonl(&lines))??;
        recorder.notify(&typing_analytics_device_day_sync_unit(uid, hash, &day));
    }
    Ok(result)
}

impl DataOps {
    /// `deleteTypingDailySummaries`: deletes this device's typing of the
    /// local calendar `dates` (in this process's time zone), as one flush
    /// chain task. `cutoff_ms` is when the user asked for the delete: what
    /// was typed later stays. A text that is not a date is skipped.
    pub async fn delete_local_days(
        &self,
        uid: &str,
        dates: &[String],
        cutoff_ms: i64,
    ) -> Result<TombstoneResult, Error> {
        let ranges: Vec<DeleteRange> = dates
            .iter()
            .filter_map(|date| pipette_time::local_day_range_ms(date))
            .map(|(start_ms, end_ms)| DeleteRange { start_ms, end_ms, cutoff_ms })
            .collect();
        if ranges.is_empty() {
            return Ok(TombstoneResult::default());
        }
        let (recorder, uid) = (self.recorder().clone(), uid.to_owned());
        self.on_chain(async move { mark_own_typing_in_ranges_on_chain(&recorder, &uid, ranges).await }).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(line: &str) -> JsonlRow {
        JsonlRow::parse(line).unwrap()
    }

    fn minute(id: &str, updated_at: u32, deleted: bool, minute_ts: u32) -> JsonlRow {
        let flag = if deleted { r#","is_deleted":true"# } else { "" };
        row(&format!(
            r#"{{"id":"{id}","kind":"minute-stats","updated_at":{updated_at}{flag},"payload":{{"scopeId":"s","minuteTs":{minute_ts},"keystrokes":1,"activeMs":1,"intervalAvgMs":null,"intervalMinMs":null,"intervalP25Ms":null,"intervalP50Ms":null,"intervalP75Ms":null,"intervalMaxMs":null}}}}"#
        ))
    }

    fn bigrams(updated_at: u32, deleted: bool, pairs: &str) -> JsonlRow {
        let flag = if deleted { r#","is_deleted":true"# } else { "" };
        row(&format!(
            r#"{{"id":"b","kind":"bigram-minute","updated_at":{updated_at}{flag},"payload":{{"scopeId":"s","minuteTs":0,"bigrams":{{{pairs}}}}}}}"#
        ))
    }

    fn pair(n: u32) -> String {
        format!(r#""{n}_9":{{"c":{n},"h":[0,0,0,0,0,0,0,0]}}"#)
    }

    fn ids(found: &[RowToMark]) -> Vec<String> {
        found.iter().map(|m| pipette_js_json::stringify(&m.row.clone().into())).collect()
    }

    #[test]
    fn keeps_the_copy_the_replay_keeps_and_skips_ids_already_deleted() {
        let rows = [minute("a", 1, false, 0), minute("a", 3, false, 0), minute("a", 3, true, 0)];
        let (found, newest) = collect_rows_to_mark(&rows, |_| true);
        assert_eq!(newest, 3.0);
        assert_eq!(found.len(), 1);
        assert!(ids(&found)[0].contains(r#""updated_at":3,"payload""#));
        let (found, _) = collect_rows_to_mark(&[minute("a", 1, false, 0), minute("a", 2, true, 0)], |_| true);
        assert!(found.is_empty());
    }

    #[test]
    fn leaves_rows_outside_the_ranges_alone() {
        let (found, newest) = collect_rows_to_mark(&[minute("a", 5, false, 60_000)], |ms| ms < 60_000.0);
        assert!(found.is_empty());
        assert_eq!(newest, 0.0);
    }

    #[test]
    fn marks_the_pairs_whose_newest_copy_is_live_keeping_the_first_on_a_tie() {
        let rows = [
            bigrams(1, false, &format!("{},{}", pair(1), pair(2))),
            bigrams(2, true, &pair(1)),
            bigrams(2, false, &pair(3)),
            bigrams(1, true, &pair(3)),
        ];
        let (found, _) = collect_rows_to_mark(&rows, |_| true);
        let text = &ids(&found)[0];
        assert!(text.starts_with(r#"{"id":"b","updated_at":2,"kind":"bigram-minute","payload""#), "{text}");
        assert!(
            !text.contains(r#""1_9""#) && text.contains(r#""2_9""#) && text.contains(r#""3_9""#),
            "{text}"
        );
        let all_deleted = [bigrams(1, false, &pair(1)), bigrams(2, true, &pair(1))];
        assert!(collect_rows_to_mark(&all_deleted, |_| true).0.is_empty());
    }

    #[test]
    fn walks_the_days_a_range_touches_up_to_its_cutoff() {
        let days: Vec<String> = ["1970-01-01", "1970-01-02", "1970-01-03"].map(String::from).into();
        let day = 86_400_000;
        let range = DeleteRange { start_ms: day, end_ms: 2 * day, cutoff_ms: 3 * day };
        assert_eq!(days_overlapping(&days, &[range]), ["1970-01-02"]);
        let all = DeleteRange { start_ms: 0, end_ms: day + 2, cutoff_ms: day + 1 };
        assert_eq!(days_overlapping(&days, &[all]), ["1970-01-01", "1970-01-02"]);
        let at_end = DeleteRange { start_ms: 0, end_ms: day, cutoff_ms: day };
        assert_eq!(days_overlapping(&days, &[at_end]), ["1970-01-01"]);
    }
}
