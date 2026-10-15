// SPDX-License-Identifier: GPL-2.0-or-later
//! Applying JSONL rows to the cache with the authoritative LWW merges
//! (`applyRowsToCache`, apply-to-cache.ts, and the `merge*` methods of
//! typing-analytics-db-writes.ts), and tombstoning a device's deleted ranges
//! (`tombstoneRowsForUidHashInRanges`). Every function here runs inside a
//! transaction its caller in lib.rs owns.

use rusqlite::{Transaction, named_params};
use serde::Serialize;

use crate::Error;
use crate::jsonl::{HIST_BUCKETS, JsonlRow, MinuteTags, NgramMinutePayload, RowCommon, RowPayload};
use crate::sql;

/// Rows applied per kind (`ApplyRowsResult`). An n-gram row counts once
/// however many bigrams / trigrams it holds.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRowsResult {
    pub scopes: u64,
    pub char_minutes: u64,
    pub matrix_minutes: u64,
    pub minute_stats: u64,
    pub sessions: u64,
    pub bigram_minutes: u64,
    pub trigram_minutes: u64,
}

/// One deleted range of a device (`DeleteRange`, deleted-ranges.ts), already
/// clipped to the day file being replayed. A row is hidden when its time is
/// in `[start_ms, end_ms)` and at or before `cutoff_ms`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DeleteRange {
    pub start_ms: i64,
    pub end_ms: i64,
    pub cutoff_ms: i64,
}

/// Pack a histogram into 8 little-endian u32 (`encodeHistBuffer`,
/// typing-analytics-row-codec.ts): a negative bucket becomes 0 and a
/// fractional one is truncated, as Buffer.writeUInt32LE stores it. A bucket
/// above u32::MAX makes writeUInt32LE throw, which aborts the whole apply;
/// here it is an error with the same effect.
pub fn encode_hist(hist: &[f64; HIST_BUCKETS]) -> Result<Vec<u8>, Error> {
    let mut out = Vec::with_capacity(HIST_BUCKETS * 4);
    for &value in hist {
        let clamped = if value.is_finite() && value >= 0.0 { value } else { 0.0 };
        if clamped > f64::from(u32::MAX) {
            return Err(Error::HistogramBucketOutOfRange(value));
        }
        // In range and non-negative, so the cast only drops the fraction.
        out.extend_from_slice(&(clamped as u32).to_le_bytes());
    }
    Ok(out)
}

/// Scopes first so the per-minute rows' foreign keys resolve, then every
/// other row in file order.
pub fn apply_rows(tx: &Transaction<'_>, rows: &[JsonlRow]) -> Result<ApplyRowsResult, Error> {
    let mut result = ApplyRowsResult::default();
    for row in rows {
        if let RowPayload::Scope(p) = &row.payload {
            tx.prepare_cached(sql::MERGE_SCOPE)?.execute(named_params! {
                "@id": p.id, "@machineHash": p.machine_hash, "@osPlatform": p.os_platform,
                "@osRelease": p.os_release, "@osArch": p.os_arch, "@keyboardUid": p.keyboard_uid,
                "@keyboardVendorId": p.keyboard_vendor_id, "@keyboardProductId": p.keyboard_product_id,
                "@keyboardProductName": p.keyboard_product_name,
                "@updatedAt": row.common.updated_at, "@isDeleted": deleted(&row.common),
            })?;
            result.scopes += 1;
        }
    }
    for row in rows {
        let common = &row.common;
        match &row.payload {
            RowPayload::Scope(_) => {}
            RowPayload::CharMinute(p) => {
                tx.prepare_cached(sql::MERGE_CHAR_MINUTE)?.execute(named_params! {
                    "@scopeId": p.scope_id, "@minuteTs": p.minute_ts, "@char": p.char, "@count": p.count,
                    "@appName": p.tags.app_name, "@typingTest": p.tags.typing_test, "@runId": p.tags.run_id,
                    "@updatedAt": common.updated_at, "@isDeleted": deleted(common),
                })?;
                result.char_minutes += 1;
            }
            RowPayload::MatrixMinute(p) => {
                let dur_hist = p.duration.as_ref().map(|d| encode_hist(&d.hist)).transpose()?;
                tx.prepare_cached(sql::MERGE_MATRIX_MINUTE)?.execute(named_params! {
                    "@scopeId": p.scope_id, "@minuteTs": p.minute_ts, "@row": p.row, "@col": p.col,
                    "@layer": p.layer, "@keycode": p.keycode, "@count": p.count,
                    "@tapCount": p.tap_count, "@holdCount": p.hold_count,
                    "@durHist": dur_hist, "@durSum": p.duration.as_ref().map(|d| d.sum),
                    "@durSumSq": p.duration.as_ref().map(|d| d.sum_sq),
                    "@appName": p.tags.app_name, "@typingTest": p.tags.typing_test, "@runId": p.tags.run_id,
                    "@updatedAt": common.updated_at, "@isDeleted": deleted(common),
                })?;
                result.matrix_minutes += 1;
            }
            RowPayload::MinuteStats(p) => {
                let [avg, min, p25, p50, p75, max] = p.intervals;
                tx.prepare_cached(sql::MERGE_MINUTE_STATS)?.execute(named_params! {
                    "@scopeId": p.scope_id, "@minuteTs": p.minute_ts, "@keystrokes": p.keystrokes,
                    "@activeMs": p.active_ms, "@intervalAvgMs": avg, "@intervalMinMs": min,
                    "@intervalP25Ms": p25, "@intervalP50Ms": p50, "@intervalP75Ms": p75, "@intervalMaxMs": max,
                    "@pollP50Ms": p.poll_p50_ms, "@pollP95Ms": p.poll_p95_ms,
                    "@appName": p.tags.app_name, "@typingTest": p.tags.typing_test, "@runId": p.tags.run_id,
                    "@updatedAt": common.updated_at, "@isDeleted": deleted(common),
                })?;
                result.minute_stats += 1;
            }
            RowPayload::Session(p) => {
                tx.prepare_cached(sql::MERGE_SESSION)?.execute(named_params! {
                    "@id": p.id, "@scopeId": p.scope_id, "@startMs": p.start_ms, "@endMs": p.end_ms,
                    "@updatedAt": common.updated_at, "@isDeleted": deleted(common),
                })?;
                result.sessions += 1;
            }
            RowPayload::BigramMinute(p) => {
                merge_ngrams(tx, sql::MERGE_BIGRAM_MINUTE, true, p, common)?;
                result.bigram_minutes += 1;
            }
            RowPayload::TrigramMinute(p) => {
                merge_ngrams(tx, sql::MERGE_TRIGRAM_MINUTE, false, p, common)?;
                result.trigram_minutes += 1;
            }
        }
    }
    Ok(result)
}

fn deleted(common: &RowCommon) -> i64 {
    i64::from(common.is_deleted)
}

/// One upsert per id of the minute (`mergeBigramMinute` /
/// `mergeTrigramMinute`). Only the bigram table has the overlap columns.
fn merge_ngrams(
    tx: &Transaction<'_>,
    sql_text: &str,
    with_overlap: bool,
    p: &NgramMinutePayload,
    common: &RowCommon,
) -> Result<(), Error> {
    let MinuteTags { app_name, typing_test, run_id } = &p.tags;
    let mut stmt = tx.prepare_cached(sql_text)?;
    for (id, entry) in &p.entries {
        let hist = encode_hist(&entry.hist)?;
        let (sum, sum_sq) = entry.sums.unzip();
        let (overlap_count, overlap_n) = entry.overlap.unzip();
        if with_overlap {
            stmt.execute(named_params! {
                "@scopeId": p.scope_id, "@minuteTs": p.minute_ts, "@ngramId": id, "@count": entry.count,
                "@hist": hist, "@sumIki": sum, "@sumSqIki": sum_sq,
                "@overlapCount": overlap_count, "@overlapN": overlap_n,
                "@appName": app_name, "@typingTest": typing_test, "@runId": run_id,
                "@updatedAt": common.updated_at, "@isDeleted": deleted(common),
            })?;
        } else {
            stmt.execute(named_params! {
                "@scopeId": p.scope_id, "@minuteTs": p.minute_ts, "@ngramId": id, "@count": entry.count,
                "@hist": hist, "@sumIki": sum, "@sumSqIki": sum_sq,
                "@appName": app_name, "@typingTest": typing_test, "@runId": run_id,
                "@updatedAt": common.updated_at, "@isDeleted": deleted(common),
            })?;
        }
    }
    Ok(())
}

/// Tombstone every live row of `machine_hash` for `uid` inside any of
/// `ranges`, bumping `updated_at`. Returns the rows changed.
pub fn tombstone_ranges(
    tx: &Transaction<'_>,
    uid: &str,
    machine_hash: &str,
    ranges: &[DeleteRange],
    updated_at: i64,
) -> Result<u64, Error> {
    const STATEMENTS: [&str; 6] = [
        sql::TOMBSTONE_CHAR_MINUTES_FOR_HASH_IN_RANGE,
        sql::TOMBSTONE_MATRIX_MINUTES_FOR_HASH_IN_RANGE,
        sql::TOMBSTONE_MINUTE_STATS_FOR_HASH_IN_RANGE,
        sql::TOMBSTONE_BIGRAM_MINUTES_FOR_HASH_IN_RANGE,
        sql::TOMBSTONE_TRIGRAM_MINUTES_FOR_HASH_IN_RANGE,
        sql::TOMBSTONE_SESSIONS_FOR_HASH_IN_RANGE,
    ];
    let mut changed = 0u64;
    for range in ranges {
        for text in STATEMENTS {
            changed += tx.prepare_cached(text)?.execute(named_params! {
                "@uid": uid, "@machineHash": machine_hash, "@startMs": range.start_ms,
                "@endMs": range.end_ms, "@cutoffMs": range.cutoff_ms, "@updatedAt": updated_at,
            })? as u64;
        }
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hist_buckets_truncate_clamp_and_reject_overflow() {
        let bytes = encode_hist(&[1.0, 2.9, -3.0, 0.0, 0.0, 0.0, 0.0, f64::from(u32::MAX)]).unwrap();
        assert_eq!(&bytes[..12], &[1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&bytes[28..], &[0xff; 4]);
        assert!(encode_hist(&[f64::from(u32::MAX) + 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]).is_err());
    }
}
