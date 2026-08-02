// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze summary-query statements: heatmaps, the Data-modal "keyboards
// with typing data" listing, daily/interval summaries, the activity grid,
// per-layer usage, and per-cell (layer, row, col) totals — including the
// keypress-duration and by-day variants.

import type { Database as DatabaseType, Statement } from 'better-sqlite3'
import { appFilterClause, runIdFilterClause, typingTestFilterClause } from './filter-clauses'

export interface SummaryStatements {
  selectMatrixHeatmapStmt: Statement
  selectMatrixHeatmapInRangeStmt: Statement
  selectMatrixHeatmapInRangeForHashStmt: Statement
  selectKeyboardsWithTypingDataStmt: Statement
  selectDailySummariesForUidStmt: Statement
  selectDailySummariesForUidAndHashStmt: Statement
  selectIntervalSummariesForUidStmt: Statement
  selectIntervalSummariesForUidAndHashStmt: Statement
  selectActivityGridForUidStmt: Statement
  selectActivityGridForUidAndHashStmt: Statement
  selectLayerUsageForUidStmt: Statement
  selectLayerUsageForUidAndHashStmt: Statement
  selectMatrixCellsForUidStmt: Statement
  selectMatrixCellsForUidAndHashStmt: Statement
  selectMatrixDurationForUidStmt: Statement
  selectMatrixDurationForUidAndHashStmt: Statement
  selectMatrixCellsByDayForUidStmt: Statement
  selectMatrixCellsByDayForUidAndHashStmt: Statement
}

export function prepareSummaryStatements(db: DatabaseType): SummaryStatements {
  return {
    // Aggregated per-(row, col) counts for the typing-view heatmap.
    // Restricted to one machine + one uid + one layer, and only rolls up
    // minutes at or after @sinceMinuteMs (already minute-floored by the
    // caller). Both tables' is_deleted flags are filtered so tombstoned
    // scopes and tombstoned minute rows are both excluded.
    selectMatrixHeatmapStmt: db.prepare(`
      SELECT m.row AS row, m.col AS col,
             SUM(m.count) AS total,
             SUM(m.tap_count) AS tap,
             SUM(m.hold_count) AS hold
        FROM typing_matrix_minute m
        JOIN typing_scopes s ON s.id = m.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND m.is_deleted = 0
         AND m.layer = @layer
         AND m.minute_ts >= @sinceMinuteMs
       GROUP BY m.row, m.col
    `),

    // Range-bounded matrix heatmap — used by the Analyze key-heatmap
    // tab where the user picks an explicit [sinceMs, untilMs) window.
    // Aggregates across every machine_hash (the Analyze tab can scope
    // device-wise at the renderer, but the SQL stays device-agnostic
    // so `deviceScope: 'all'` works without a second statement).
    // App filter: @appNamesJson is a JSON array of app names; an
    // empty array (`'[]'`) is the no-filter sentinel so the same
    // prepared statement covers single-app, multi-app and unfiltered
    // queries via SQLite's `json_each`.
    selectMatrixHeatmapInRangeStmt: db.prepare(`
      SELECT m.row AS row, m.col AS col,
             SUM(m.count) AS total,
             SUM(m.tap_count) AS tap,
             SUM(m.hold_count) AS hold
        FROM typing_matrix_minute m
        JOIN typing_scopes s ON s.id = m.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND m.is_deleted = 0
         AND m.layer = @layer
         AND m.minute_ts >= @sinceMs
         AND m.minute_ts < @untilMs
         ${appFilterClause('m.app_name')} ${typingTestFilterClause('m.typing_test')} ${runIdFilterClause('m.run_id')}
       GROUP BY m.row, m.col
    `),

    selectMatrixHeatmapInRangeForHashStmt: db.prepare(`
      SELECT m.row AS row, m.col AS col,
             SUM(m.count) AS total,
             SUM(m.tap_count) AS tap,
             SUM(m.hold_count) AS hold
        FROM typing_matrix_minute m
        JOIN typing_scopes s ON s.id = m.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND m.is_deleted = 0
         AND m.layer = @layer
         AND m.minute_ts >= @sinceMs
         AND m.minute_ts < @untilMs
         ${appFilterClause('m.app_name')} ${typingTestFilterClause('m.typing_test')} ${runIdFilterClause('m.run_id')}
       GROUP BY m.row, m.col
    `),

    // Data-modal queries. "Has typing data" is defined as "at least one
    // live minute-stats row under one of this uid's scopes" — minute_stats
    // is smaller than char_minute/matrix_minute so EXISTS is cheaper.
    //
    // Product name / vendor / product are aggregated via MAX because a
    // keyboard typed on multiple machines can surface different descriptor
    // values. MAX gives a deterministic-but-arbitrary pick; the renderer
    // treats this as a display label only.
    selectKeyboardsWithTypingDataStmt: db.prepare(`
      SELECT keyboard_uid AS uid,
             MAX(keyboard_product_name) AS productName,
             MAX(keyboard_vendor_id) AS vendorId,
             MAX(keyboard_product_id) AS productId
        FROM typing_scopes s
       WHERE s.is_deleted = 0
         AND EXISTS (
           SELECT 1 FROM typing_minute_stats t
            WHERE t.scope_id = s.id AND t.is_deleted = 0
         )
       GROUP BY keyboard_uid
       ORDER BY MAX(keyboard_product_name) COLLATE NOCASE
    `),

    // Daily aggregation. strftime with 'localtime' so day boundaries align
    // with the user's wall-clock expectation (today is "today" even near
    // midnight UTC). Sums across every scope with the same keyboard_uid —
    // different machines contribute additively.
    selectDailySummariesForUidStmt: db.prepare(`
      SELECT strftime('%Y-%m-%d', t.minute_ts / 1000, 'unixepoch', 'localtime') AS date,
             SUM(t.keystrokes) AS keystrokes,
             SUM(t.active_ms) AS activeMs
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
       GROUP BY date
       ORDER BY date DESC
    `),

    // Same as the cross-hash variant but restricted to one machine_hash
    // so the Local tab shows only this device's contribution and the
    // Sync tab can drill into a specific remote device.
    selectDailySummariesForUidAndHashStmt: db.prepare(`
      SELECT strftime('%Y-%m-%d', t.minute_ts / 1000, 'unixepoch', 'localtime') AS date,
             SUM(t.keystrokes) AS keystrokes,
             SUM(t.active_ms) AS activeMs
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
       GROUP BY date
       ORDER BY date DESC
    `),

    // Daily envelope + mean of the per-minute interval quartiles.
    // min/max are taken across every minute that carries a non-null
    // value; p25/p50/p75 are unweighted means (close enough for a
    // rhythm overview, and cheap on the existing column layout).
    selectIntervalSummariesForUidStmt: db.prepare(`
      SELECT strftime('%Y-%m-%d', t.minute_ts / 1000, 'unixepoch', 'localtime') AS date,
             MIN(t.interval_min_ms) AS intervalMinMs,
             AVG(t.interval_p25_ms) AS intervalP25Ms,
             AVG(t.interval_p50_ms) AS intervalP50Ms,
             AVG(t.interval_p75_ms) AS intervalP75Ms,
             MAX(t.interval_max_ms) AS intervalMaxMs
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.interval_p50_ms IS NOT NULL
       GROUP BY date
       ORDER BY date DESC
    `),

    selectIntervalSummariesForUidAndHashStmt: db.prepare(`
      SELECT strftime('%Y-%m-%d', t.minute_ts / 1000, 'unixepoch', 'localtime') AS date,
             MIN(t.interval_min_ms) AS intervalMinMs,
             AVG(t.interval_p25_ms) AS intervalP25Ms,
             AVG(t.interval_p50_ms) AS intervalP50Ms,
             AVG(t.interval_p75_ms) AS intervalP75Ms,
             MAX(t.interval_max_ms) AS intervalMaxMs
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.interval_p50_ms IS NOT NULL
       GROUP BY date
       ORDER BY date DESC
    `),

    // Hour-of-day × day-of-week activity grid for the Analyze heatmap.
    // Both dimensions are local-time via strftime to match the existing
    // daily summaries. Callers pass @sinceMs to clip to a period
    // (@sinceMs=0 = all time).
    selectActivityGridForUidStmt: db.prepare(`
      SELECT CAST(strftime('%w', t.minute_ts / 1000, 'unixepoch', 'localtime') AS INTEGER) AS dow,
             CAST(strftime('%H', t.minute_ts / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
             SUM(t.keystrokes) AS keystrokes
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
         ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
       GROUP BY dow, hour
    `),

    selectActivityGridForUidAndHashStmt: db.prepare(`
      SELECT CAST(strftime('%w', t.minute_ts / 1000, 'unixepoch', 'localtime') AS INTEGER) AS dow,
             CAST(strftime('%H', t.minute_ts / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
             SUM(t.keystrokes) AS keystrokes
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
         ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
       GROUP BY dow, hour
    `),

    // Per-layer keystroke totals for the Analyze > Layer tab. `layer`
    // is the live-active layer recorded on each press, so the GROUP BY
    // already reflects MO / LT / TG / etc. activations without having
    // to re-decode layer-op keycodes. Hash-scoped variant filters by
    // `machine_hash` the same way the activity-grid pair does.
    selectLayerUsageForUidStmt: db.prepare(`
      SELECT m.layer AS layer,
             SUM(m.count) AS keystrokes
        FROM typing_matrix_minute m
        JOIN typing_scopes s ON s.id = m.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND m.is_deleted = 0
         AND m.minute_ts >= @sinceMs
         AND m.minute_ts < @untilMs
         ${appFilterClause('m.app_name')} ${typingTestFilterClause('m.typing_test')} ${runIdFilterClause('m.run_id')}
       GROUP BY m.layer
       ORDER BY m.layer ASC
    `),

    selectLayerUsageForUidAndHashStmt: db.prepare(`
      SELECT m.layer AS layer,
             SUM(m.count) AS keystrokes
        FROM typing_matrix_minute m
        JOIN typing_scopes s ON s.id = m.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND m.is_deleted = 0
         AND m.minute_ts >= @sinceMs
         AND m.minute_ts < @untilMs
         ${appFilterClause('m.app_name')} ${typingTestFilterClause('m.typing_test')} ${runIdFilterClause('m.run_id')}
       GROUP BY m.layer
       ORDER BY m.layer ASC
    `),

    // Per-(layer, row, col) totals for the Analyze > Layer activations
    // mode. The aggregator in the renderer looks up each cell's
    // serialized QMK id from the keymap snapshot and dispatches
    // layer-op keycodes (MO / LT / TG / etc.) to their target layer.
    // We keep tap/hold splits alongside the total because LT / LM
    // only activate the layer on the hold arm — the tap arm goes to
    // the inner keycode and must not be counted.
    selectMatrixCellsForUidStmt: db.prepare(`
      SELECT m.layer AS layer,
             m.row AS row,
             m.col AS col,
             SUM(m.count) AS count,
             SUM(m.tap_count) AS tap,
             SUM(m.hold_count) AS hold
        FROM typing_matrix_minute m
        JOIN typing_scopes s ON s.id = m.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND m.is_deleted = 0
         AND m.minute_ts >= @sinceMs
         AND m.minute_ts < @untilMs
         ${appFilterClause('m.app_name')} ${typingTestFilterClause('m.typing_test')} ${runIdFilterClause('m.run_id')}
       GROUP BY m.layer, m.row, m.col
    `),

    selectMatrixCellsForUidAndHashStmt: db.prepare(`
      SELECT m.layer AS layer,
             m.row AS row,
             m.col AS col,
             SUM(m.count) AS count,
             SUM(m.tap_count) AS tap,
             SUM(m.hold_count) AS hold
        FROM typing_matrix_minute m
        JOIN typing_scopes s ON s.id = m.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND m.is_deleted = 0
         AND m.minute_ts >= @sinceMs
         AND m.minute_ts < @untilMs
         ${appFilterClause('m.app_name')} ${typingTestFilterClause('m.typing_test')} ${runIdFilterClause('m.run_id')}
       GROUP BY m.layer, m.row, m.col
    `),

    // Per-(scope, minute, cell) raw duration rows for the Analyze
    // keypress-duration aggregate. Unlike selectMatrixCellsForUidStmt
    // above, this can't SUM the histogram BLOB in SQL — it hands back
    // one row per contributing minute and lets bigram-aggregate.ts fold
    // hist/sum/sumSq in JS, the same shape as the n-gram range selects.
    // Rows with no duration sample that minute (dur_hist IS NULL) are
    // excluded rather than returned as an empty histogram — they
    // contribute nothing to the aggregate either way.
    selectMatrixDurationForUidStmt: db.prepare(`
      SELECT m.row AS row,
             m.col AS col,
             m.layer AS layer,
             m.minute_ts AS minuteTs,
             m.dur_hist AS durHist,
             m.dur_sum AS durSum,
             m.dur_sumsq AS durSumSq
        FROM typing_matrix_minute m
        JOIN typing_scopes s ON s.id = m.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND m.is_deleted = 0
         -- dh/ds/dq are written as an all-or-nothing triple by the
         -- validator (isValidDurationTriple in jsonl-row.ts), three
         -- modules away from this query — checking both columns here
         -- rather than trusting that invariant blindly means a future
         -- bug in that validator (or a hand-edited JSONL master) can't
         -- feed the mapper/aggregate a hist with no matching sum.
         AND m.dur_hist IS NOT NULL
         AND m.dur_sum IS NOT NULL
         AND m.minute_ts >= @sinceMs
         AND m.minute_ts < @untilMs
         ${appFilterClause('m.app_name')} ${typingTestFilterClause('m.typing_test')} ${runIdFilterClause('m.run_id')}
    `),

    selectMatrixDurationForUidAndHashStmt: db.prepare(`
      SELECT m.row AS row,
             m.col AS col,
             m.layer AS layer,
             m.minute_ts AS minuteTs,
             m.dur_hist AS durHist,
             m.dur_sum AS durSum,
             m.dur_sumsq AS durSumSq
        FROM typing_matrix_minute m
        JOIN typing_scopes s ON s.id = m.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND m.is_deleted = 0
         -- dh/ds/dq are written as an all-or-nothing triple by the
         -- validator (isValidDurationTriple in jsonl-row.ts), three
         -- modules away from this query — checking both columns here
         -- rather than trusting that invariant blindly means a future
         -- bug in that validator (or a hand-edited JSONL master) can't
         -- feed the mapper/aggregate a hist with no matching sum.
         AND m.dur_hist IS NOT NULL
         AND m.dur_sum IS NOT NULL
         AND m.minute_ts >= @sinceMs
         AND m.minute_ts < @untilMs
         ${appFilterClause('m.app_name')} ${typingTestFilterClause('m.typing_test')} ${runIdFilterClause('m.run_id')}
    `),

    // Per-(localDay, layer, row, col) totals for the Analyze Ergonomic
    // Learning Curve. strftime with 'localtime' so the day boundary
    // matches the daily summary / activity-grid queries above; the
    // renderer buckets the resulting rows by week / month before
    // folding them into ergonomic sub-scores. tap_count / hold_count
    // travel alongside count so future sub-views (e.g. tap-only
    // finger load) can subtract the hold portion without re-running
    // the SQL.
    selectMatrixCellsByDayForUidStmt: db.prepare(`
      SELECT strftime('%Y-%m-%d', m.minute_ts / 1000, 'unixepoch', 'localtime') AS date,
             m.layer AS layer,
             m.row AS row,
             m.col AS col,
             SUM(m.count) AS count,
             SUM(m.tap_count) AS tap,
             SUM(m.hold_count) AS hold
        FROM typing_matrix_minute m
        JOIN typing_scopes s ON s.id = m.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND m.is_deleted = 0
         AND m.minute_ts >= @sinceMs
         AND m.minute_ts < @untilMs
         ${appFilterClause('m.app_name')} ${typingTestFilterClause('m.typing_test')} ${runIdFilterClause('m.run_id')}
       GROUP BY date, m.layer, m.row, m.col
       ORDER BY date ASC
    `),

    selectMatrixCellsByDayForUidAndHashStmt: db.prepare(`
      SELECT strftime('%Y-%m-%d', m.minute_ts / 1000, 'unixepoch', 'localtime') AS date,
             m.layer AS layer,
             m.row AS row,
             m.col AS col,
             SUM(m.count) AS count,
             SUM(m.tap_count) AS tap,
             SUM(m.hold_count) AS hold
        FROM typing_matrix_minute m
        JOIN typing_scopes s ON s.id = m.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND m.is_deleted = 0
         AND m.minute_ts >= @sinceMs
         AND m.minute_ts < @untilMs
         ${appFilterClause('m.app_name')} ${typingTestFilterClause('m.typing_test')} ${runIdFilterClause('m.run_id')}
       GROUP BY date, m.layer, m.row, m.col
       ORDER BY date ASC
    `),

  }
}
