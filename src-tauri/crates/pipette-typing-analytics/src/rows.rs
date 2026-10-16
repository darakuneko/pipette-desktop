// SPDX-License-Identifier: GPL-2.0-or-later
//! The JSONL rows a flush writes (typing-analytics-rows.ts): the drained
//! minutes, the closed sessions and their scopes, split by keyboard and
//! UTC day. Every row of one flush has the same `updated_at`. The rows are
//! built as the objects the TypeScript code builds, key order included, so
//! the lines are the same bytes.

use std::sync::Arc;

use indexmap::{IndexMap, IndexSet};
use pipette_js_json::{Object, Value};

use crate::bigram_bucket::{bucketize_durations, bucketize_iki, sum_and_sum_squares};
use crate::fingerprint::Fingerprint;
use crate::jsonl::paths::utc_day_from_ms;
use crate::jsonl::row::{
    HIST_BUCKETS, bigram_minute_row_id, char_minute_row_id, matrix_minute_row_id, minute_stats_row_id,
    scope_row_id, session_row_id, trigram_minute_row_id,
};
use crate::minute_buffer::{MinuteSnapshot, OverlapCounts};
use crate::session_detector::FinalizedSession;

/// A keyboard's fingerprint and its scope key (`ResolvedScope`).
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedScope {
    pub fingerprint: Arc<Fingerprint>,
    pub scope_key: String,
}

impl ResolvedScope {
    pub fn new(fingerprint: Fingerprint) -> Self {
        let scope_key = fingerprint.scope_key();
        Self { fingerprint: Arc::new(fingerprint), scope_key }
    }
}

/// Keyboard uid → UTC day → the rows of that day file, the uids in the
/// order they first appear and the days in the order of their first row.
pub type RowsByUidDay = IndexMap<String, IndexMap<String, Vec<Value>>>;

fn count(n: u64) -> Value {
    Value::Number(n as f64)
}

fn nullable<T: Into<Value>>(value: Option<T>) -> Value {
    value.map_or(Value::Null, Into::into)
}

fn hist(buckets: [u32; HIST_BUCKETS]) -> Value {
    Value::Array(buckets.iter().map(|&n| Value::Number(f64::from(n))).collect())
}

fn row(id: String, kind: &str, updated_at: f64, payload: Object) -> Value {
    let mut row = Object::new();
    row.insert("id", id.into());
    row.insert("kind", kind.into());
    row.insert("updated_at", updated_at.into());
    row.insert("payload", payload.into());
    row.into()
}

fn scope_row(scope_key: &str, fingerprint: &Fingerprint, updated_at: f64) -> Value {
    let payload: Object = [
        ("id", scope_key.into()),
        ("machineHash", fingerprint.machine_hash.as_str().into()),
        ("osPlatform", fingerprint.os.platform.as_str().into()),
        ("osRelease", fingerprint.os.release.as_str().into()),
        ("osArch", fingerprint.os.arch.as_str().into()),
        ("keyboardUid", fingerprint.keyboard.uid.as_str().into()),
        ("keyboardVendorId", fingerprint.keyboard.vendor_id.into()),
        ("keyboardProductId", fingerprint.keyboard.product_id.into()),
        ("keyboardProductName", fingerprint.keyboard.product_name.as_str().into()),
    ]
    .into_iter()
    .collect();
    row(scope_row_id(scope_key), "scope", updated_at, payload)
}

/// `toNgramEntries`: each pair's or triple's histogram, count, sum and sum
/// of squares, and for a bigram with a known overlap its `oc` / `on`.
fn ngram_entries(
    samples: &IndexMap<String, Vec<f64>>,
    overlaps: Option<&IndexMap<String, OverlapCounts>>,
) -> Value {
    let mut entries = Object::new();
    for (key, values) in samples {
        let (sum, sum_sq) = sum_and_sum_squares(values);
        let mut entry: Object = [
            ("c", count(values.len() as u64)),
            ("h", hist(bucketize_iki(values))),
            ("s", sum.into()),
            ("sq", sum_sq.into()),
        ]
        .into_iter()
        .collect();
        if let Some(overlap) = overlaps.and_then(|overlaps| overlaps.get(key)) {
            entry.insert("oc", count(overlap.oc));
            entry.insert("on", count(overlap.on));
        }
        entries.insert(key.as_str(), entry.into());
    }
    entries.into()
}

/// `buildSnapshotRows`. A minute whose only events were releases (a key
/// held across the minute's start) gets no minute-stats row, which would
/// make a day appear that nothing was typed on; its cells' rows still
/// carry the durations.
fn snapshot_rows(snapshot: &MinuteSnapshot, updated_at: f64) -> Vec<Value> {
    let (scope, minute_ts, run_id) =
        (snapshot.scope_id.as_str(), snapshot.minute_ts, snapshot.run_id.as_str());
    let tags = |payload: &mut Object| {
        payload.insert("appName", snapshot.app_name.clone().map_or(Value::Null, Value::String));
        payload.insert("typingTest", nullable(snapshot.typing_test.as_deref()));
        payload.insert("runId", run_id.into());
    };
    let head = |payload: &mut Object| {
        payload.insert("scopeId", scope.into());
        payload.insert("minuteTs", minute_ts.into());
    };
    let mut rows = Vec::new();
    if snapshot.keystrokes > 0 || !snapshot.char_counts.is_empty() {
        let mut payload = Object::new();
        head(&mut payload);
        payload.insert("keystrokes", count(snapshot.keystrokes));
        payload.insert("activeMs", snapshot.active_ms.into());
        payload.insert("intervalAvgMs", nullable(snapshot.interval_avg_ms));
        payload.insert("intervalMinMs", nullable(snapshot.interval_min_ms));
        payload.insert("intervalP25Ms", nullable(snapshot.interval_p25_ms));
        payload.insert("intervalP50Ms", nullable(snapshot.interval_p50_ms));
        payload.insert("intervalP75Ms", nullable(snapshot.interval_p75_ms));
        payload.insert("intervalMaxMs", nullable(snapshot.interval_max_ms));
        // No samples leaves both fields out rather than null.
        if let Some(p50) = snapshot.poll_p50_ms {
            payload.insert("pollP50Ms", p50.into());
            payload.insert("pollP95Ms", nullable(snapshot.poll_p95_ms));
        }
        tags(&mut payload);
        rows.push(row(minute_stats_row_id(scope, minute_ts, run_id), "minute-stats", updated_at, payload));
    }
    for (ch, &n) in &snapshot.char_counts {
        let mut payload = Object::new();
        head(&mut payload);
        payload.insert("char", ch.as_str().into());
        payload.insert("count", count(n));
        tags(&mut payload);
        rows.push(row(char_minute_row_id(scope, minute_ts, run_id, ch), "char-minute", updated_at, payload));
    }
    for cell in snapshot.matrix_counts.values() {
        let mut payload = Object::new();
        head(&mut payload);
        payload.insert("row", cell.row.into());
        payload.insert("col", cell.col.into());
        payload.insert("layer", cell.layer.into());
        payload.insert("keycode", cell.keycode.into());
        payload.insert("count", count(cell.count));
        payload.insert("tapCount", count(cell.tap_count));
        payload.insert("holdCount", count(cell.hold_count));
        // Only a cell with a release this minute carries durations.
        if !cell.durations.is_empty() {
            let (sum, sum_sq) = sum_and_sum_squares(&cell.durations);
            payload.insert("dh", hist(bucketize_durations(&cell.durations)));
            payload.insert("ds", sum.into());
            payload.insert("dq", sum_sq.into());
        }
        tags(&mut payload);
        let id = matrix_minute_row_id(scope, minute_ts, run_id, cell.row, cell.col, cell.layer);
        rows.push(row(id, "matrix-minute", updated_at, payload));
    }
    let ngrams = [
        ("bigram-minute", "bigrams", &snapshot.bigrams, Some(&snapshot.overlaps)),
        // Overlap is a property of pairs only.
        ("trigram-minute", "trigrams", &snapshot.trigrams, None),
    ];
    for (kind, field, samples, overlaps) in ngrams {
        if samples.is_empty() {
            continue;
        }
        let mut payload = Object::new();
        head(&mut payload);
        payload.insert(field, ngram_entries(samples, overlaps));
        tags(&mut payload);
        let id = if overlaps.is_some() {
            bigram_minute_row_id(scope, minute_ts, run_id)
        } else {
            trigram_minute_row_id(scope, minute_ts, run_id)
        };
        rows.push(row(id, kind, updated_at, payload));
    }
    rows
}

fn session_row(session: &FinalizedSession, scope_key: &str, updated_at: f64) -> Value {
    let payload: Object = [
        ("id", session.id.as_str().into()),
        ("scopeId", scope_key.into()),
        ("startMs", session.start_ms.into()),
        ("endMs", session.end_ms.into()),
    ]
    .into_iter()
    .collect();
    row(session_row_id(&session.id), "session", updated_at, payload)
}

/// `groupRowsByUidDay`: a minute's rows go to the UTC day of the minute, a
/// session's to the day it started on (a session across midnight stays
/// whole), and each scope row to every day of this flush that has a row of
/// that scope, after the day's other rows.
pub fn group_rows_by_uid_day(
    scopes_to_upsert: &IndexMap<String, Arc<Fingerprint>>,
    snapshots: &[MinuteSnapshot],
    sessions: &[(FinalizedSession, ResolvedScope)],
    updated_at: f64,
) -> RowsByUidDay {
    let mut rows_by_uid_day = RowsByUidDay::new();
    let mut scope_days: IndexMap<(String, String), IndexSet<String>> = IndexMap::new();
    let mut add = |uid: &str, day: &str, rows: &mut dyn Iterator<Item = Value>| {
        rows_by_uid_day.entry(uid.into()).or_default().entry(day.into()).or_default().extend(rows);
    };
    for snapshot in snapshots {
        let uid = &snapshot.fingerprint.keyboard.uid;
        let day = utc_day_from_ms(snapshot.minute_ts);
        scope_days.entry((uid.clone(), snapshot.scope_id.clone())).or_default().insert(day.clone());
        add(uid, &day, &mut snapshot_rows(snapshot, updated_at).into_iter());
    }
    for (session, resolved) in sessions {
        let uid = &resolved.fingerprint.keyboard.uid;
        let day = utc_day_from_ms(session.start_ms);
        scope_days.entry((uid.clone(), resolved.scope_key.clone())).or_default().insert(day.clone());
        add(uid, &day, &mut std::iter::once(session_row(session, &resolved.scope_key, updated_at)));
    }
    for (scope_key, fingerprint) in scopes_to_upsert {
        let uid = &fingerprint.keyboard.uid;
        let Some(days) = scope_days.get(&(uid.clone(), scope_key.clone())) else { continue };
        let scope = scope_row(scope_key, fingerprint, updated_at);
        for day in days {
            add(uid, day, &mut std::iter::once(scope.clone()));
        }
    }
    rows_by_uid_day
}
