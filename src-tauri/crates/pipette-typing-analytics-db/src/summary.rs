// SPDX-License-Identifier: GPL-2.0-or-later
//! The summary reads (summary-query-statements.ts and their methods in
//! typing-analytics-db-reads.ts): the heatmaps, the keyboards with data,
//! the daily and interval summaries, the activity grid, the layer usage
//! and the per-cell totals. `machine_hash` narrows a read to one device;
//! `None` reads every device of the keyboard.
//!
//! The daily summaries, the interval summaries, the activity grid and the
//! cells by day group by SQLite's `localtime`, so they follow the time
//! zone of the process.

use crate::query::{Params, ScopeFilters, all, for_device};
use crate::rows::{
    ActivityCell, DailySummary, IntervalDailySummary, KeyboardSummary, LayerUsageRow, MatrixCellDailyRow,
    MatrixCellRow, MatrixCounts, MatrixDurationCellRow,
};
use crate::{Error, TypingAnalyticsDb, sql};

impl TypingAnalyticsDb {
    /// Per-cell totals of one device and layer from `since_minute_ms` on
    /// (`aggregateMatrixCountsForUid`).
    pub fn matrix_counts_since(
        &self,
        uid: &str,
        machine_hash: &str,
        layer: f64,
        since_minute_ms: f64,
    ) -> Result<Vec<MatrixCounts>, Error> {
        let params: Params<'_> = vec![
            ("@uid", &uid),
            ("@machineHash", &machine_hash),
            ("@layer", &layer),
            ("@sinceMinuteMs", &since_minute_ms),
        ];
        all(&self.conn, sql::SELECT_MATRIX_HEATMAP, &params, MatrixCounts::from_row)
    }

    /// Per-cell totals of one layer in `[since_ms, until_ms)`
    /// (`aggregateMatrixCountsForUidInRange`).
    pub fn matrix_counts_in_range(
        &self,
        uid: &str,
        machine_hash: Option<&str>,
        layer: f64,
        since_ms: f64,
        until_ms: f64,
        filters: &ScopeFilters,
    ) -> Result<Vec<MatrixCounts>, Error> {
        let json = filters.json()?;
        let mut params: Params<'_> =
            vec![("@uid", &uid), ("@layer", &layer), ("@sinceMs", &since_ms), ("@untilMs", &until_ms)];
        json.add(&mut params);
        let sql = for_device(
            machine_hash.as_ref(),
            sql::SELECT_MATRIX_HEATMAP_IN_RANGE,
            sql::SELECT_MATRIX_HEATMAP_IN_RANGE_FOR_HASH,
            &mut params,
        );
        all(&self.conn, sql, &params, MatrixCounts::from_row)
    }

    /// The keyboards with at least one live minute-stats row, by product
    /// name (`listKeyboardsWithTypingData`).
    pub fn keyboards_with_typing_data(&self) -> Result<Vec<KeyboardSummary>, Error> {
        all(&self.conn, sql::SELECT_KEYBOARDS_WITH_TYPING_DATA, &[], KeyboardSummary::from_row)
    }

    /// One row per local day, newest first (`listDailySummariesForUid*`).
    pub fn daily_summaries(
        &self,
        uid: &str,
        machine_hash: Option<&str>,
        filters: &ScopeFilters,
    ) -> Result<Vec<DailySummary>, Error> {
        let json = filters.json()?;
        let mut params: Params<'_> = vec![("@uid", &uid)];
        json.add(&mut params);
        let sql = for_device(
            machine_hash.as_ref(),
            sql::SELECT_DAILY_SUMMARIES_FOR_UID,
            sql::SELECT_DAILY_SUMMARIES_FOR_UID_AND_HASH,
            &mut params,
        );
        all(&self.conn, sql, &params, DailySummary::from_row)
    }

    /// One row per local day with interval data, newest first
    /// (`listIntervalSummariesForUid*`).
    pub fn interval_summaries(
        &self,
        uid: &str,
        machine_hash: Option<&str>,
    ) -> Result<Vec<IntervalDailySummary>, Error> {
        let mut params: Params<'_> = vec![("@uid", &uid)];
        let sql = for_device(
            machine_hash.as_ref(),
            sql::SELECT_INTERVAL_SUMMARIES_FOR_UID,
            sql::SELECT_INTERVAL_SUMMARIES_FOR_UID_AND_HASH,
            &mut params,
        );
        all(&self.conn, sql, &params, IntervalDailySummary::from_row)
    }

    /// Keystrokes per local day of the week and hour in `[since_ms,
    /// until_ms)` (`listActivityGridForUid*`).
    pub fn activity_grid(
        &self,
        uid: &str,
        machine_hash: Option<&str>,
        since_ms: f64,
        until_ms: f64,
        filters: &ScopeFilters,
    ) -> Result<Vec<ActivityCell>, Error> {
        let json = filters.json()?;
        let mut params: Params<'_> = vec![("@uid", &uid), ("@sinceMs", &since_ms), ("@untilMs", &until_ms)];
        json.add(&mut params);
        let sql = for_device(
            machine_hash.as_ref(),
            sql::SELECT_ACTIVITY_GRID_FOR_UID,
            sql::SELECT_ACTIVITY_GRID_FOR_UID_AND_HASH,
            &mut params,
        );
        all(&self.conn, sql, &params, ActivityCell::from_row)
    }

    /// Keystrokes per layer in `[since_ms, until_ms)`, by layer
    /// (`listLayerUsageForUid*`).
    pub fn layer_usage(
        &self,
        uid: &str,
        machine_hash: Option<&str>,
        since_ms: f64,
        until_ms: f64,
        filters: &ScopeFilters,
    ) -> Result<Vec<LayerUsageRow>, Error> {
        let json = filters.json()?;
        let mut params: Params<'_> = vec![("@uid", &uid), ("@sinceMs", &since_ms), ("@untilMs", &until_ms)];
        json.add(&mut params);
        let sql = for_device(
            machine_hash.as_ref(),
            sql::SELECT_LAYER_USAGE_FOR_UID,
            sql::SELECT_LAYER_USAGE_FOR_UID_AND_HASH,
            &mut params,
        );
        all(&self.conn, sql, &params, LayerUsageRow::from_row)
    }

    /// Per-(layer, row, col) totals in `[since_ms, until_ms)`
    /// (`listMatrixCellsForUid*`).
    pub fn matrix_cells(
        &self,
        uid: &str,
        machine_hash: Option<&str>,
        since_ms: f64,
        until_ms: f64,
        filters: &ScopeFilters,
    ) -> Result<Vec<MatrixCellRow>, Error> {
        let json = filters.json()?;
        let mut params: Params<'_> = vec![("@uid", &uid), ("@sinceMs", &since_ms), ("@untilMs", &until_ms)];
        json.add(&mut params);
        let sql = for_device(
            machine_hash.as_ref(),
            sql::SELECT_MATRIX_CELLS_FOR_UID,
            sql::SELECT_MATRIX_CELLS_FOR_UID_AND_HASH,
            &mut params,
        );
        all(&self.conn, sql, &params, MatrixCellRow::from_row)
    }

    /// Per-(cell, minute) keypress durations in `[since_ms, until_ms)` of
    /// the rows that have them (`listMatrixDurationCellsForUid*`).
    pub fn matrix_duration_cells(
        &self,
        uid: &str,
        machine_hash: Option<&str>,
        since_ms: f64,
        until_ms: f64,
        filters: &ScopeFilters,
    ) -> Result<Vec<MatrixDurationCellRow>, Error> {
        let json = filters.json()?;
        let mut params: Params<'_> = vec![("@uid", &uid), ("@sinceMs", &since_ms), ("@untilMs", &until_ms)];
        json.add(&mut params);
        let sql = for_device(
            machine_hash.as_ref(),
            sql::SELECT_MATRIX_DURATION_FOR_UID,
            sql::SELECT_MATRIX_DURATION_FOR_UID_AND_HASH,
            &mut params,
        );
        all(&self.conn, sql, &params, MatrixDurationCellRow::from_row)
    }

    /// Per-(local day, layer, row, col) totals in `[since_ms, until_ms)`,
    /// oldest day first (`listMatrixCellsByDayForUid*`).
    pub fn matrix_cells_by_day(
        &self,
        uid: &str,
        machine_hash: Option<&str>,
        since_ms: f64,
        until_ms: f64,
        filters: &ScopeFilters,
    ) -> Result<Vec<MatrixCellDailyRow>, Error> {
        let json = filters.json()?;
        let mut params: Params<'_> = vec![("@uid", &uid), ("@sinceMs", &since_ms), ("@untilMs", &until_ms)];
        json.add(&mut params);
        let sql = for_device(
            machine_hash.as_ref(),
            sql::SELECT_MATRIX_CELLS_BY_DAY_FOR_UID,
            sql::SELECT_MATRIX_CELLS_BY_DAY_FOR_UID_AND_HASH,
            &mut params,
        );
        all(&self.conn, sql, &params, MatrixCellDailyRow::from_row)
    }
}
