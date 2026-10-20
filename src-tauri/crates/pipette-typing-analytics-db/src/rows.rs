// SPDX-License-Identifier: GPL-2.0-or-later
//! The rows the reads answer, with the keys and key order of the objects
//! the TypeScript DB layer returns (the `Typing*` row types of
//! src/shared/types/typing-analytics.ts and the cache's own row types).
//! Every number is an f64, as JavaScript
//! holds it, so a REAL in an INTEGER column reads the same. A value the
//! TypeScript type calls a number but a statement can leave NULL is an
//! `Option`.

use rusqlite::Row;

use crate::js::{ToJs, js_object, object, sql_row};
use crate::jsonl::HIST_BUCKETS;
use crate::query::column;
use crate::row_codec::{decode_hist, local_date_string_to_ms};

sql_row! {
    /// `TypingKeyboardSummary`: a keyboard with live minute stats.
    pub struct KeyboardSummary {
        uid: String => "uid",
        product_name: String => "productName",
        vendor_id: f64 => "vendorId",
        product_id: f64 => "productId",
    }
}

sql_row! {
    /// `TypingDailySummary`: one local calendar day. `date` is null only for
    /// a minute SQLite's date functions cannot hold.
    pub struct DailySummary {
        date: Option<String> => "date",
        keystrokes: f64 => "keystrokes",
        active_ms: f64 => "activeMs",
    }
}

sql_row! {
    /// `TypingIntervalDailySummary`.
    pub struct IntervalDailySummary {
        date: Option<String> => "date",
        interval_min_ms: Option<f64> => "intervalMinMs",
        interval_p25_ms: Option<f64> => "intervalP25Ms",
        interval_p50_ms: Option<f64> => "intervalP50Ms",
        interval_p75_ms: Option<f64> => "intervalP75Ms",
        interval_max_ms: Option<f64> => "intervalMaxMs",
    }
}

sql_row! {
    /// `TypingActivityCell`: local day of the week (0 = Sunday) and hour.
    pub struct ActivityCell {
        dow: Option<f64> => "dow",
        hour: Option<f64> => "hour",
        keystrokes: f64 => "keystrokes",
    }
}

sql_row! {
    /// `TypingLayerUsageRow`.
    pub struct LayerUsageRow {
        layer: f64 => "layer",
        keystrokes: f64 => "keystrokes",
    }
}

sql_row! {
    /// `TypingMatrixCellRow`.
    pub struct MatrixCellRow {
        layer: f64 => "layer",
        row: f64 => "row",
        col: f64 => "col",
        count: f64 => "count",
        tap: f64 => "tap",
        hold: f64 => "hold",
    }
}

sql_row! {
    /// One cell of a heatmap aggregate (`aggregateMatrixCountsForUid*`),
    /// which the TypeScript side keys as `${row},${col}`.
    pub struct MatrixCounts {
        row: f64 => "row",
        col: f64 => "col",
        total: f64 => "total",
        tap: f64 => "tap",
        hold: f64 => "hold",
    }
}

js_object! {
    /// `TypingMatrixCellDailyRow`: `day_ms` is the local midnight of the
    /// day, NaN when the day cannot be read (as JavaScript's Date gives).
    pub struct MatrixCellDailyRow {
        day_ms: f64 => "dayMs",
        layer: f64 => "layer",
        row: f64 => "row",
        col: f64 => "col",
        count: f64 => "count",
        tap: f64 => "tap",
        hold: f64 => "hold",
    }
}

impl MatrixCellDailyRow {
    pub(crate) fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let date: Option<String> = column(row, 0, "date")?;
        Ok(Self {
            day_ms: date.as_deref().map_or(f64::NAN, local_date_string_to_ms),
            layer: column(row, 1, "layer")?,
            row: column(row, 2, "row")?,
            col: column(row, 3, "col")?,
            count: column(row, 4, "count")?,
            tap: column(row, 5, "tap")?,
            hold: column(row, 6, "hold")?,
        })
    }
}

js_object! {
    /// `MatrixDurationCellRow`: one cell's keypress durations in one minute.
    pub struct MatrixDurationCellRow {
        row: f64 => "row",
        col: f64 => "col",
        layer: f64 => "layer",
        minute_ts: f64 => "minuteTs",
        hist: [u32; HIST_BUCKETS] => "hist",
        sum: f64 => "sum",
        sum_sq: Option<f64> => "sumSq",
    }
}

impl MatrixDurationCellRow {
    pub(crate) fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        debug_assert_eq!(row.as_ref().column_name(4)?, "durHist");
        Ok(Self {
            row: column(row, 0, "row")?,
            col: column(row, 1, "col")?,
            layer: column(row, 2, "layer")?,
            minute_ts: column(row, 3, "minuteTs")?,
            hist: decode_hist(row.get_ref(4)?),
            sum: column(row, 5, "durSum")?,
            sum_sq: column(row, 6, "durSumSq")?,
        })
    }
}

sql_row! {
    /// `TypingMinuteStatsRow`: one minute, the scopes sharing it merged.
    pub struct MinuteStatsRow {
        minute_ms: f64 => "minuteMs",
        keystrokes: f64 => "keystrokes",
        active_ms: f64 => "activeMs",
        interval_min_ms: Option<f64> => "intervalMinMs",
        interval_p25_ms: Option<f64> => "intervalP25Ms",
        interval_p50_ms: Option<f64> => "intervalP50Ms",
        interval_p75_ms: Option<f64> => "intervalP75Ms",
        interval_max_ms: Option<f64> => "intervalMaxMs",
        poll_p50_ms: Option<f64> => "pollP50Ms",
        poll_p95_ms: Option<f64> => "pollP95Ms",
    }
}

sql_row! {
    /// `TypingRolloverMinuteRow`.
    pub struct RolloverMinuteRow {
        minute_ts: f64 => "minuteTs",
        oc: f64 => "oc",
        on: f64 => "on",
    }
}

sql_row! {
    /// A name with its keystroke and active-time totals: an app, a typing
    /// test label, or the app usage's unknown bucket.
    pub struct NamedTotals {
        name: String => "name",
        keystrokes: f64 => "keystrokes",
        active_ms: f64 => "activeMs",
    }
}

sql_row! {
    /// One typing-test run in a range.
    pub struct TypingTestRun {
        run_id: String => "runId",
        keystrokes: f64 => "keystrokes",
        first_ms: f64 => "firstMs",
    }
}

sql_row! {
    /// `TypingSessionRow`.
    pub struct SessionRow {
        id: String => "id",
        start_ms: f64 => "startMs",
        end_ms: f64 => "endMs",
    }
}

sql_row! {
    /// `TypingBksMinuteRow`.
    pub struct BksMinuteRow {
        minute_ms: f64 => "minuteMs",
        backspace_count: f64 => "backspaceCount",
    }
}

sql_row! {
    /// A device of the keyboard other than this one.
    pub struct RemoteDeviceInfo {
        machine_hash: String => "machineHash",
        os_platform: String => "osPlatform",
        os_release: String => "osRelease",
    }
}

/// The physical-overlap sums of a bigram row; trigram rows have none.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Overlap {
    pub count: Option<f64>,
    pub n: Option<f64>,
}

/// `NgramMinuteCellRow`: one n-gram in one minute. `overlap` is `None` for
/// a trigram row, whose object has no overlap keys.
#[derive(Debug, Clone, PartialEq)]
pub struct NgramMinuteCellRow {
    pub ngram_id: String,
    pub minute_ts: f64,
    pub count: f64,
    pub hist: [u32; HIST_BUCKETS],
    pub sum_iki: Option<f64>,
    pub sum_sq_iki: Option<f64>,
    pub overlap: Option<Overlap>,
}

impl NgramMinuteCellRow {
    pub(crate) fn from_row(row: &Row<'_>, with_overlap: bool) -> rusqlite::Result<Self> {
        let overlap = if with_overlap {
            Some(Overlap { count: column(row, 6, "overlapCount")?, n: column(row, 7, "overlapN")? })
        } else {
            None
        };
        debug_assert_eq!(row.as_ref().column_name(3)?, "hist");
        Ok(Self {
            ngram_id: column(row, 0, "ngramId")?,
            minute_ts: column(row, 1, "minuteTs")?,
            count: column(row, 2, "count")?,
            hist: decode_hist(row.get_ref(3)?),
            sum_iki: column(row, 4, "sumIki")?,
            sum_sq_iki: column(row, 5, "sumSqIki")?,
            overlap,
        })
    }
}

impl ToJs for NgramMinuteCellRow {
    fn to_js(&self) -> pipette_js_json::Value {
        let common = [
            ("ngramId", self.ngram_id.to_js()),
            ("minuteTs", self.minute_ts.to_js()),
            ("count", self.count.to_js()),
            ("hist", self.hist.to_js()),
            ("sumIki", self.sum_iki.to_js()),
            ("sumSqIki", self.sum_sq_iki.to_js()),
        ];
        match self.overlap {
            None => object(common),
            Some(o) => {
                let [a, b, c, d, e, f] = common;
                object([a, b, c, d, e, f, ("overlapCount", o.count.to_js()), ("overlapN", o.n.to_js())])
            }
        }
    }
}

sql_row! {
    /// A per-minute peak and the minute it happened.
    pub struct PeakAt {
        value: f64 => "value",
        at_ms: f64 => "atMs",
    }
}

js_object! {
    /// The busiest local day.
    pub struct PeakDay {
        value: f64 => "value",
        day: Option<String> => "day",
    }
}

impl PeakDay {
    pub(crate) fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self { day: column(row, 0, "day")?, value: column(row, 1, "value")? })
    }
}

sql_row! {
    /// The longest session.
    pub struct LongestSession {
        duration_ms: f64 => "durationMs",
        started_at_ms: f64 => "startedAtMs",
    }
}

js_object! {
    /// `PeakRecords`: each record null when no row qualifies.
    pub struct PeakRecords {
        peak_wpm: Option<PeakAt> => "peakWpm",
        lowest_wpm: Option<PeakAt> => "lowestWpm",
        peak_keystrokes_per_min: Option<PeakAt> => "peakKeystrokesPerMin",
        peak_keystrokes_per_day: Option<PeakDay> => "peakKeystrokesPerDay",
        longest_session: Option<LongestSession> => "longestSession",
    }
}
