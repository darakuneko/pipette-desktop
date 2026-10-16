// SPDX-License-Identifier: GPL-2.0-or-later
//! Tombstoning the rows of a keyboard (the tombstone methods of
//! typing-analytics-db-writes.ts): those of one device inside its deleted
//! ranges, all of a keyboard, or all of one device of a keyboard. Each
//! flips live rows only, so a row already tombstoned keeps the
//! `updated_at` it was tombstoned with, and leaves the scopes as they are.

use rusqlite::{Savepoint, named_params};
use serde::Serialize;

use crate::js::{ToJs, object};
use crate::{Error, TypingAnalyticsDb, sql};

/// One deleted range of a device (`DeleteRange`, deleted-ranges.ts). A row
/// is in it when its time is in `[start_ms, end_ms)` and at or before
/// `cutoff_ms`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeleteRange {
    pub start_ms: i64,
    pub end_ms: i64,
    pub cutoff_ms: i64,
}

/// Rows tombstoned per table (`TypingTombstoneResult`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TombstoneResult {
    pub char_minutes: u64,
    pub matrix_minutes: u64,
    pub minute_stats: u64,
    pub bigram_minutes: u64,
    pub trigram_minutes: u64,
    pub sessions: u64,
}

impl ToJs for TombstoneResult {
    fn to_js(&self) -> pipette_js_json::Value {
        let n = |count: u64| (count as f64).to_js();
        object([
            ("charMinutes", n(self.char_minutes)),
            ("matrixMinutes", n(self.matrix_minutes)),
            ("minuteStats", n(self.minute_stats)),
            ("bigramMinutes", n(self.bigram_minutes)),
            ("trigramMinutes", n(self.trigram_minutes)),
            ("sessions", n(self.sessions)),
        ])
    }
}

/// One statement per table, in the order of [`TombstoneResult`]'s fields,
/// which is the order they run in.
type PerTable = [&'static str; 6];

const IN_RANGE: PerTable = [
    sql::TOMBSTONE_CHAR_MINUTES_FOR_HASH_IN_RANGE,
    sql::TOMBSTONE_MATRIX_MINUTES_FOR_HASH_IN_RANGE,
    sql::TOMBSTONE_MINUTE_STATS_FOR_HASH_IN_RANGE,
    sql::BIGRAM_TOMBSTONE_FOR_HASH_IN_RANGE,
    sql::TRIGRAM_TOMBSTONE_FOR_HASH_IN_RANGE,
    sql::TOMBSTONE_SESSIONS_FOR_HASH_IN_RANGE,
];

const ALL: PerTable = [
    sql::TOMBSTONE_ALL_CHAR_MINUTES,
    sql::TOMBSTONE_ALL_MATRIX_MINUTES,
    sql::TOMBSTONE_ALL_MINUTE_STATS,
    sql::BIGRAM_TOMBSTONE_ALL,
    sql::TRIGRAM_TOMBSTONE_ALL,
    sql::TOMBSTONE_ALL_SESSIONS,
];

const ALL_FOR_HASH: PerTable = [
    sql::TOMBSTONE_ALL_CHAR_MINUTES_FOR_HASH,
    sql::TOMBSTONE_ALL_MATRIX_MINUTES_FOR_HASH,
    sql::TOMBSTONE_ALL_MINUTE_STATS_FOR_HASH,
    sql::BIGRAM_TOMBSTONE_ALL_FOR_HASH,
    sql::TRIGRAM_TOMBSTONE_ALL_FOR_HASH,
    sql::TOMBSTONE_ALL_SESSIONS_FOR_HASH,
];

impl TombstoneResult {
    fn add(&mut self, [c, m, s, b, t, x]: [u64; 6]) {
        self.char_minutes += c;
        self.matrix_minutes += m;
        self.minute_stats += s;
        self.bigram_minutes += b;
        self.trigram_minutes += t;
        self.sessions += x;
    }
}

fn run(
    tx: &Savepoint<'_>,
    statements: &PerTable,
    params: &[(&str, &dyn rusqlite::ToSql)],
) -> Result<[u64; 6], Error> {
    let mut counts = [0u64; 6];
    for (count, text) in counts.iter_mut().zip(statements) {
        *count = tx.prepare_cached(text)?.execute(params)? as u64;
    }
    Ok(counts)
}

/// Tombstone the live rows of `machine_hash` for `uid` whose time (a
/// minute's start, a session's start) is inside `[start_ms, end_ms)` and at
/// or before `cutoff_ms` of one of `ranges`, in the caller's transaction.
/// The counts are summed over the ranges.
pub(crate) fn tombstone_ranges(
    tx: &Savepoint<'_>,
    uid: &str,
    machine_hash: &str,
    ranges: &[DeleteRange],
    updated_at: i64,
) -> Result<TombstoneResult, Error> {
    let mut result = TombstoneResult::default();
    for range in ranges {
        let params = named_params! {
            "@uid": uid, "@machineHash": machine_hash, "@startMs": range.start_ms,
            "@endMs": range.end_ms, "@cutoffMs": range.cutoff_ms, "@updatedAt": updated_at,
        };
        result.add(run(tx, &IN_RANGE, params)?);
    }
    Ok(result)
}

impl TypingAnalyticsDb {
    /// Tombstone the rows of one device inside its deleted ranges
    /// (`tombstoneRowsForUidHashInRanges`), in one transaction.
    pub fn tombstone_ranges_for_uid_hash(
        &mut self,
        uid: &str,
        machine_hash: &str,
        ranges: &[DeleteRange],
        updated_at: i64,
    ) -> Result<TombstoneResult, Error> {
        let tx = self.conn.savepoint()?;
        let result = tombstone_ranges(&tx, uid, machine_hash, ranges, updated_at)?;
        tx.commit()?;
        Ok(result)
    }

    /// Tombstone every live row of a keyboard (`tombstoneAllRowsForUid`), in
    /// one transaction.
    pub fn tombstone_all_for_uid(&mut self, uid: &str, updated_at: i64) -> Result<TombstoneResult, Error> {
        let tx = self.conn.savepoint()?;
        let mut result = TombstoneResult::default();
        result.add(run(&tx, &ALL, named_params! { "@uid": uid, "@updatedAt": updated_at })?);
        tx.commit()?;
        Ok(result)
    }

    /// Tombstone every live row one device recorded for a keyboard
    /// (`tombstoneAllRowsForUidHash`), in one transaction.
    pub fn tombstone_all_for_uid_hash(
        &mut self,
        uid: &str,
        machine_hash: &str,
        updated_at: i64,
    ) -> Result<TombstoneResult, Error> {
        let tx = self.conn.savepoint()?;
        let mut result = TombstoneResult::default();
        let params = named_params! { "@uid": uid, "@machineHash": machine_hash, "@updatedAt": updated_at };
        result.add(run(&tx, &ALL_FOR_HASH, params)?);
        tx.commit()?;
        Ok(result)
    }
}
