// SPDX-License-Identifier: GPL-2.0-or-later
//! Applying JSONL rows to the cache with the authoritative LWW merges: a
//! row replaces the cached one only when
//! its `updated_at` is newer, tombstone flag included. Every function here
//! runs inside the transaction of its caller.

use rusqlite::{CachedStatement, Savepoint, named_params};
use serde::Serialize;

use crate::Error;
use crate::jsonl::{JsonlRow, MinuteTags, NgramMinutePayload, RowCommon, RowPayload};
use crate::row_codec::encode_hist;
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

/// Scopes first so the per-minute rows' foreign keys resolve, then every
/// other row in file order.
/// Each statement is taken from the cache once per call, not once per row.
pub(crate) fn apply_rows(tx: &Savepoint<'_>, rows: &[JsonlRow]) -> Result<ApplyRowsResult, Error> {
    let mut result = ApplyRowsResult::default();
    let mut scope = tx.prepare_cached(sql::MERGE_SCOPE)?;
    for row in rows {
        if let RowPayload::Scope(p) = &row.payload {
            scope.execute(named_params! {
                "@id": p.id, "@machineHash": p.machine_hash, "@osPlatform": p.os_platform,
                "@osRelease": p.os_release, "@osArch": p.os_arch, "@keyboardUid": p.keyboard_uid,
                "@keyboardVendorId": p.keyboard_vendor_id, "@keyboardProductId": p.keyboard_product_id,
                "@keyboardProductName": p.keyboard_product_name,
                "@updatedAt": row.common.updated_at, "@isDeleted": deleted(&row.common),
            })?;
            result.scopes += 1;
        }
    }
    let mut char_minute = tx.prepare_cached(sql::MERGE_CHAR_MINUTE)?;
    let mut matrix_minute = tx.prepare_cached(sql::MERGE_MATRIX_MINUTE)?;
    let mut minute_stats = tx.prepare_cached(sql::MERGE_MINUTE_STATS)?;
    let mut session = tx.prepare_cached(sql::MERGE_SESSION)?;
    let mut bigram = tx.prepare_cached(sql::BIGRAM_MERGE)?;
    let mut trigram = tx.prepare_cached(sql::TRIGRAM_MERGE)?;
    for row in rows {
        let common = &row.common;
        match &row.payload {
            RowPayload::Scope(_) => {}
            RowPayload::CharMinute(p) => {
                char_minute.execute(named_params! {
                    "@scopeId": p.scope_id, "@minuteTs": p.minute_ts, "@char": p.char, "@count": p.count,
                    "@appName": p.tags.app_name, "@typingTest": p.tags.typing_test, "@runId": p.tags.run_id,
                    "@updatedAt": common.updated_at, "@isDeleted": deleted(common),
                })?;
                result.char_minutes += 1;
            }
            RowPayload::MatrixMinute(p) => {
                let dur_hist = p.duration.as_ref().map(|d| encode_hist(&d.hist)).transpose()?;
                matrix_minute.execute(named_params! {
                    "@scopeId": p.scope_id, "@minuteTs": p.minute_ts, "@row": p.row, "@col": p.col,
                    "@layer": p.layer, "@keycode": p.keycode, "@count": p.count,
                    "@tapCount": p.tap_count, "@holdCount": p.hold_count,
                    "@durHist": dur_hist.as_ref().map(|h| &h[..]), "@durSum": p.duration.as_ref().map(|d| d.sum),
                    "@durSumSq": p.duration.as_ref().map(|d| d.sum_sq),
                    "@appName": p.tags.app_name, "@typingTest": p.tags.typing_test, "@runId": p.tags.run_id,
                    "@updatedAt": common.updated_at, "@isDeleted": deleted(common),
                })?;
                result.matrix_minutes += 1;
            }
            RowPayload::MinuteStats(p) => {
                let [avg, min, p25, p50, p75, max] = p.intervals;
                minute_stats.execute(named_params! {
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
                session.execute(named_params! {
                    "@id": p.id, "@scopeId": p.scope_id, "@startMs": p.start_ms, "@endMs": p.end_ms,
                    "@updatedAt": common.updated_at, "@isDeleted": deleted(common),
                })?;
                result.sessions += 1;
            }
            RowPayload::BigramMinute(p) => {
                merge_ngrams(&mut bigram, true, p, common)?;
                result.bigram_minutes += 1;
            }
            RowPayload::TrigramMinute(p) => {
                merge_ngrams(&mut trigram, false, p, common)?;
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
    stmt: &mut CachedStatement<'_>,
    with_overlap: bool,
    p: &NgramMinutePayload,
    common: &RowCommon,
) -> Result<(), Error> {
    let MinuteTags { app_name, typing_test, run_id } = &p.tags;
    for (id, entry) in &p.entries {
        let hist = encode_hist(&entry.hist)?;
        let (sum, sum_sq) = entry.sums.unzip();
        let (overlap_count, overlap_n) = entry.overlap.unzip();
        if with_overlap {
            stmt.execute(named_params! {
                "@scopeId": p.scope_id, "@minuteTs": p.minute_ts, "@ngramId": id, "@count": entry.count,
                "@hist": &hist[..], "@sumIki": sum, "@sumSqIki": sum_sq,
                "@overlapCount": overlap_count, "@overlapN": overlap_n,
                "@appName": app_name, "@typingTest": typing_test, "@runId": run_id,
                "@updatedAt": common.updated_at, "@isDeleted": deleted(common),
            })?;
        } else {
            stmt.execute(named_params! {
                "@scopeId": p.scope_id, "@minuteTs": p.minute_ts, "@ngramId": id, "@count": entry.count,
                "@hist": &hist[..], "@sumIki": sum, "@sumSqIki": sum_sq,
                "@appName": app_name, "@typingTest": typing_test, "@runId": run_id,
                "@updatedAt": common.updated_at, "@isDeleted": deleted(common),
            })?;
        }
    }
    Ok(())
}
