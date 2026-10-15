// SPDX-License-Identifier: GPL-2.0-or-later
//! The Analyze minute-stats range query (`listMinuteStatsInRangeForUid`,
//! typing-analytics-db-reads.ts): one row per minute, scopes that share a
//! minute merged, for the WPM and Interval charts.

use rusqlite::{Connection, named_params};
use serde::Serialize;

use crate::Error;
use crate::sql;

/// The app / typing-test / run filters of the Analyze view. An empty list
/// means no filter on that dimension.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScopeFilters {
    pub app_names: Vec<String>,
    pub typing_tests: Vec<String>,
    pub run_ids: Vec<String>,
}

/// `TypingMinuteStatsRow`. Every value is a double, as the renderer gets it
/// from the TypeScript side: SQLite's SUM / MIN / MAX of an INTEGER column
/// can still be REAL when a JSONL row carried a fractional number.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MinuteStatsRow {
    pub minute_ms: f64,
    pub keystrokes: f64,
    pub active_ms: f64,
    pub interval_min_ms: Option<f64>,
    pub interval_p25_ms: Option<f64>,
    pub interval_p50_ms: Option<f64>,
    pub interval_p75_ms: Option<f64>,
    pub interval_max_ms: Option<f64>,
    pub poll_p50_ms: Option<f64>,
    pub poll_p95_ms: Option<f64>,
}

pub(crate) fn minute_stats_in_range(
    conn: &Connection,
    uid: &str,
    since_ms: i64,
    until_ms: i64,
    filters: &ScopeFilters,
) -> Result<Vec<MinuteStatsRow>, Error> {
    let app_names = serde_json::to_string(&filters.app_names)?;
    let typing_tests = serde_json::to_string(&filters.typing_tests)?;
    let run_ids = serde_json::to_string(&filters.run_ids)?;
    let mut stmt = conn.prepare_cached(sql::SELECT_MINUTE_STATS_IN_RANGE_FOR_UID)?;
    let rows = stmt.query_map(
        named_params! {
            "@uid": uid, "@sinceMs": since_ms, "@untilMs": until_ms,
            "@appNamesJson": app_names, "@typingTestsJson": typing_tests, "@runIdsJson": run_ids,
        },
        |r| {
            Ok(MinuteStatsRow {
                minute_ms: r.get("minuteMs")?,
                keystrokes: r.get("keystrokes")?,
                active_ms: r.get("activeMs")?,
                interval_min_ms: r.get("intervalMinMs")?,
                interval_p25_ms: r.get("intervalP25Ms")?,
                interval_p50_ms: r.get("intervalP50Ms")?,
                interval_p75_ms: r.get("intervalP75Ms")?,
                interval_max_ms: r.get("intervalMaxMs")?,
                poll_p50_ms: r.get("pollP50Ms")?,
                poll_p95_ms: r.get("pollP95Ms")?,
            })
        },
    )?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}
