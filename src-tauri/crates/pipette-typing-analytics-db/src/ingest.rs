// SPDX-License-Identifier: GPL-2.0-or-later
//! The additive writes (ingest-statements.ts and `upsertScope`,
//! `writeMinute`, `insertSession` and `retainOwnData` of
//! typing-analytics-db-writes.ts). Unlike the JSONL apply, a minute written
//! twice adds up, and a tag that differs between two writes of a minute
//! becomes null (a mixed minute).
//!
//! The inputs deserialize from the TypeScript row shapes (camelCase keys,
//! an optional field absent or null).

use rusqlite::named_params;
use serde::Deserialize;

use crate::{Error, TypingAnalyticsDb, sql};

/// `TypingScopeRow` as `upsertScope` takes it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeInput {
    pub id: String,
    pub machine_hash: String,
    pub os_platform: String,
    pub os_release: String,
    pub os_arch: String,
    pub keyboard_uid: String,
    pub keyboard_vendor_id: f64,
    pub keyboard_product_id: f64,
    pub keyboard_product_name: String,
    pub updated_at: f64,
}

/// `MinuteStatsRow` as `writeMinute` takes it. Its tags are the minute's;
/// a char or matrix row without its own tag takes the minute's.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinuteStatsInput {
    pub scope_id: String,
    pub minute_ts: f64,
    pub keystrokes: f64,
    pub active_ms: f64,
    pub interval_avg_ms: Option<f64>,
    pub interval_min_ms: Option<f64>,
    #[serde(rename = "intervalP25Ms")]
    pub interval_p25_ms: Option<f64>,
    #[serde(rename = "intervalP50Ms")]
    pub interval_p50_ms: Option<f64>,
    #[serde(rename = "intervalP75Ms")]
    pub interval_p75_ms: Option<f64>,
    pub interval_max_ms: Option<f64>,
    #[serde(default)]
    pub app_name: Option<String>,
    #[serde(default)]
    pub typing_test: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
}

/// `CharMinuteRow`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharMinuteInput {
    pub scope_id: String,
    pub minute_ts: f64,
    pub char: String,
    pub count: f64,
    #[serde(default)]
    pub app_name: Option<String>,
    #[serde(default)]
    pub typing_test: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
}

/// `MatrixMinuteRow`; an absent tap or hold count is 0.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixMinuteInput {
    pub scope_id: String,
    pub minute_ts: f64,
    pub row: f64,
    pub col: f64,
    pub layer: f64,
    pub keycode: f64,
    pub count: f64,
    #[serde(default)]
    pub tap_count: Option<f64>,
    #[serde(default)]
    pub hold_count: Option<f64>,
    #[serde(default)]
    pub app_name: Option<String>,
    #[serde(default)]
    pub typing_test: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
}

/// `SessionRow`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInput {
    pub id: String,
    pub scope_id: String,
    pub start_ms: f64,
    pub end_ms: f64,
}

impl TypingAnalyticsDb {
    /// Insert a scope, or replace it when `updated_at` is newer, live again
    /// (`upsertScope`).
    pub fn upsert_scope(&mut self, row: &ScopeInput) -> Result<(), Error> {
        self.conn.prepare_cached(sql::UPSERT_SCOPE)?.execute(named_params! {
            "@id": row.id, "@machineHash": row.machine_hash, "@osPlatform": row.os_platform,
            "@osRelease": row.os_release, "@osArch": row.os_arch, "@keyboardUid": row.keyboard_uid,
            "@keyboardVendorId": row.keyboard_vendor_id, "@keyboardProductId": row.keyboard_product_id,
            "@keyboardProductName": row.keyboard_product_name, "@updatedAt": row.updated_at,
        })?;
        Ok(())
    }

    /// Add one minute's stats, chars and matrix cells (`writeMinute`), in
    /// one transaction.
    pub fn write_minute(
        &mut self,
        stats: &MinuteStatsInput,
        chars: &[CharMinuteInput],
        matrix: &[MatrixMinuteInput],
        updated_at: f64,
    ) -> Result<(), Error> {
        let app_name = stats.app_name.as_deref();
        let typing_test = stats.typing_test.as_deref();
        let run_id = stats.run_id.as_deref().unwrap_or("");
        let tx = self.conn.savepoint()?;
        tx.prepare_cached(sql::UPSERT_MINUTE_STATS)?.execute(named_params! {
            "@scopeId": stats.scope_id, "@minuteTs": stats.minute_ts, "@keystrokes": stats.keystrokes,
            "@activeMs": stats.active_ms, "@intervalAvgMs": stats.interval_avg_ms,
            "@intervalMinMs": stats.interval_min_ms, "@intervalP25Ms": stats.interval_p25_ms,
            "@intervalP50Ms": stats.interval_p50_ms, "@intervalP75Ms": stats.interval_p75_ms,
            "@intervalMaxMs": stats.interval_max_ms, "@appName": app_name, "@typingTest": typing_test,
            "@runId": run_id, "@updatedAt": updated_at,
        })?;
        {
            let mut upsert = tx.prepare_cached(sql::UPSERT_CHAR_MINUTE)?;
            for c in chars {
                upsert.execute(named_params! {
                    "@scopeId": c.scope_id, "@minuteTs": c.minute_ts, "@char": c.char, "@count": c.count,
                    "@appName": c.app_name.as_deref().or(app_name),
                    "@typingTest": c.typing_test.as_deref().or(typing_test),
                    "@runId": c.run_id.as_deref().unwrap_or(run_id), "@updatedAt": updated_at,
                })?;
            }
        }
        {
            let mut upsert = tx.prepare_cached(sql::UPSERT_MATRIX_MINUTE)?;
            for m in matrix {
                upsert.execute(named_params! {
                    "@scopeId": m.scope_id, "@minuteTs": m.minute_ts, "@row": m.row, "@col": m.col,
                    "@layer": m.layer, "@keycode": m.keycode, "@count": m.count,
                    "@tapCount": m.tap_count.unwrap_or(0.0), "@holdCount": m.hold_count.unwrap_or(0.0),
                    "@appName": m.app_name.as_deref().or(app_name),
                    "@typingTest": m.typing_test.as_deref().or(typing_test),
                    "@runId": m.run_id.as_deref().unwrap_or(run_id), "@updatedAt": updated_at,
                })?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Insert a session, or replace it when `updated_at` is newer, live
    /// again (`insertSession`).
    pub fn insert_session(&mut self, row: &SessionInput, updated_at: f64) -> Result<(), Error> {
        self.conn.prepare_cached(sql::INSERT_SESSION)?.execute(named_params! {
            "@id": row.id, "@scopeId": row.scope_id, "@startMs": row.start_ms, "@endMs": row.end_ms,
            "@updatedAt": updated_at,
        })?;
        Ok(())
    }

    /// Delete the rows of `machine_hash` before `cutoff_ms`: minutes that
    /// start before it and sessions that end before it (`retainOwnData`),
    /// in one transaction.
    pub fn retain_own_data(&mut self, machine_hash: &str, cutoff_ms: f64) -> Result<(), Error> {
        const STATEMENTS: [&str; 6] = [
            sql::DELETE_CHAR_MINUTE_BEFORE,
            sql::DELETE_MATRIX_MINUTE_BEFORE,
            sql::DELETE_MINUTE_STATS_BEFORE,
            sql::BIGRAM_DELETE_BEFORE,
            sql::TRIGRAM_DELETE_BEFORE,
            sql::DELETE_SESSIONS_BEFORE,
        ];
        let tx = self.conn.savepoint()?;
        for text in STATEMENTS {
            tx.prepare_cached(text)?
                .execute(named_params! { "@machineHash": machine_hash, "@cutoffMs": cutoff_ms })?;
        }
        tx.commit()?;
        Ok(())
    }
}
