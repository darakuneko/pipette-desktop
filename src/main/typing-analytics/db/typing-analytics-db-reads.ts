// SPDX-License-Identifier: GPL-2.0-or-later
// Read-path methods for TypingAnalyticsDB: every Analyze/Data-modal query
// (daily/interval summaries, activity grid, layer usage, matrix cells and
// durations, minute-raw stats, rollover trend, Monitor App aggregates,
// n-gram range queries, sessions, peak records, remote device info) plus
// the sync-facing scope/live-row listers. Extends TypingAnalyticsDbWrites
// so it inherits the write methods without duplicating `this.stmts`.
// Split out of what used to be one 3,255-line file/class — see
// .claude/tasks/done/Task-split-typing-analytics-db.md.

import type {
  TypingKeyboardSummary,
  TypingDailySummary,
  TypingIntervalDailySummary,
  TypingActivityCell,
  TypingLayerUsageRow,
  TypingMatrixCellRow,
  TypingMatrixCellDailyRow,
  TypingMinuteStatsRow,
  TypingRolloverMinuteRow,
  TypingSessionRow,
  TypingBksMinuteRow,
  PeakRecords,
} from '../../../shared/types/typing-analytics'
import type {
  CharMinuteRow,
  MatrixMinuteRow,
  MinuteStatsRow,
  SessionRow,
  NgramMinuteCellRow,
  MatrixDurationCellRow,
} from './typing-analytics-db-types'
import { decodeHistBuffer, matrixCellsByDayDbRowToDailyRow } from './typing-analytics-row-codec'
import type { MatrixCellsByDayDbRow } from './typing-analytics-row-codec'
import { TypingAnalyticsDbWrites } from './typing-analytics-db-writes'

export abstract class TypingAnalyticsDbReads extends TypingAnalyticsDbWrites {
  /** Distinct keyboard uids present in typing_scopes for this machine.
   * Used by the sync layer to decide which analytics sync units exist. */
  listLocalKeyboardUids(machineHash: string): string[] {
    const rows = this.stmts.sync.selectLocalKeyboardUidsStmt.all({ machineHash }) as Array<{ keyboardUid: string }>
    return rows.map((r) => r.keyboardUid)
  }

  /** Scope ids belonging to the local machine for a single keyboard uid.
   * Used by the delete APIs to scope tombstone emission to rows this
   * device actually owns (1-writer per JSONL file). */
  listOwnScopeIdsForUid(machineHash: string, uid: string): string[] {
    const rows = this.stmts.sync.selectOwnScopeIdsForUidStmt.all({ machineHash, uid }) as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  /** Live char-minute rows for a single scope within `[startMs, endMs)`. */
  listLiveCharMinutesForScope(scopeId: string, startMs: number, endMs: number): CharMinuteRow[] {
    return this.stmts.sync.selectLiveCharMinutesForScopeStmt.all({ scopeId, startMs, endMs }) as CharMinuteRow[]
  }

  /** Live matrix-minute rows for a single scope within `[startMs, endMs)`. */
  listLiveMatrixMinutesForScope(scopeId: string, startMs: number, endMs: number): MatrixMinuteRow[] {
    return this.stmts.sync.selectLiveMatrixMinutesForScopeStmt.all({ scopeId, startMs, endMs }) as MatrixMinuteRow[]
  }

  /** Live minute-stats rows for a single scope within `[startMs, endMs)`. */
  listLiveMinuteStatsForScope(scopeId: string, startMs: number, endMs: number): MinuteStatsRow[] {
    return this.stmts.sync.selectLiveMinuteStatsForScopeStmt.all({ scopeId, startMs, endMs }) as MinuteStatsRow[]
  }

  /** Live sessions overlapping `[startMs, endMs)` for a single scope.
   * Overlap semantics mirror the existing tombstone path: a session that
   * starts before the window but ends inside still qualifies. */
  listLiveSessionsForScope(scopeId: string, startMs: number, endMs: number): SessionRow[] {
    return this.stmts.sync.selectLiveSessionsForScopeStmt.all({ scopeId, startMs, endMs }) as SessionRow[]
  }

  /** Per-cell totals broken down into the overall press count plus the
   * tap / hold subcounts for LT and MT keys. The heatmap uses `total`
   * for the outer rect colour on non-tap-hold keys and the tap / hold
   * splits for the outer and inner rects of LT/MT keys. */
  aggregateMatrixCountsForUid(
    uid: string,
    machineHash: string,
    layer: number,
    sinceMinuteMs: number,
  ): Map<string, { total: number; tap: number; hold: number }> {
    const rows = this.stmts.summary.selectMatrixHeatmapStmt.all({ uid, machineHash, layer, sinceMinuteMs }) as Array<{
      row: number
      col: number
      total: number
      tap: number
      hold: number
    }>
    const result = new Map<string, { total: number; tap: number; hold: number }>()
    for (const r of rows) {
      result.set(`${r.row},${r.col}`, { total: r.total, tap: r.tap, hold: r.hold })
    }
    return result
  }

  /** Range-bounded per-cell totals for the Analyze key-heatmap tab.
   * `machineHash` is optional — omit to aggregate across every device
   * ("All devices"), pass one to scope to a single hash. */
  aggregateMatrixCountsForUidInRange(
    uid: string,
    layer: number,
    sinceMs: number,
    untilMs: number,
    machineHash?: string,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): Map<string, { total: number; tap: number; hold: number }> {
    const stmt = machineHash !== undefined
      ? this.stmts.summary.selectMatrixHeatmapInRangeForHashStmt
      : this.stmts.summary.selectMatrixHeatmapInRangeStmt
    const params = machineHash !== undefined
      ? { uid, machineHash, layer, sinceMs, untilMs, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }
      : { uid, layer, sinceMs, untilMs, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }
    const rows = stmt.all(params) as Array<{
      row: number
      col: number
      total: number
      tap: number
      hold: number
    }>
    const result = new Map<string, { total: number; tap: number; hold: number }>()
    for (const r of rows) {
      result.set(`${r.row},${r.col}`, { total: r.total, tap: r.tap, hold: r.hold })
    }
    return result
  }

  // --- Data modal queries -------------------------------------------

  /** Keyboards that currently have at least one live minute-stats row.
   * Aggregates across machines — a keyboard typed on two devices shows
   * up once with one representative product name. */
  listKeyboardsWithTypingData(): TypingKeyboardSummary[] {
    return this.stmts.summary.selectKeyboardsWithTypingDataStmt.all() as TypingKeyboardSummary[]
  }

  /** Daily summaries for a keyboard uid, grouped by local calendar day
   * and ordered newest first. Live rows only. */
  listDailySummariesForUid(
    uid: string,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): TypingDailySummary[] {
    return this.stmts.summary.selectDailySummariesForUidStmt.all({ uid, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }) as TypingDailySummary[]
  }

  /** Daily summaries for a keyboard uid restricted to a single
   * machine_hash. Same shape as {@link listDailySummariesForUid} but
   * drops any rows that aren't attributable to the requested hash so
   * the Local tab can show only this device's days and the Sync tab
   * can show one remote device at a time. */
  listDailySummariesForUidAndHash(
    uid: string,
    machineHash: string,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): TypingDailySummary[] {
    return this.stmts.summary.selectDailySummariesForUidAndHashStmt.all({ uid, machineHash, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }) as TypingDailySummary[]
  }

  /** Daily interval summaries (min/p25/p50/p75/max) for a keyboard uid,
   * grouped by local calendar day and ordered newest first. Minutes
   * with no interval data (single-keystroke minutes) are excluded. */
  listIntervalSummariesForUid(uid: string): TypingIntervalDailySummary[] {
    return this.stmts.summary.selectIntervalSummariesForUidStmt.all({ uid }) as TypingIntervalDailySummary[]
  }

  /** Same as {@link listIntervalSummariesForUid} but restricted to one
   * machine_hash so the Analyze view can show only the active device's
   * rhythm without any remote contribution. */
  listIntervalSummariesForUidAndHash(
    uid: string,
    machineHash: string,
  ): TypingIntervalDailySummary[] {
    return this.stmts.summary.selectIntervalSummariesForUidAndHashStmt.all({ uid, machineHash }) as TypingIntervalDailySummary[]
  }

  /** Hour-of-day × day-of-week activity grid for a keyboard uid in
   * `[sinceMs, untilMs)`. Pass `Number.MAX_SAFE_INTEGER` for untilMs to
   * include "now and onwards". Buckets with zero keystrokes are
   * omitted from the result — callers zero-fill when rendering. */
  listActivityGridForUid(
    uid: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): TypingActivityCell[] {
    return this.stmts.summary.selectActivityGridForUidStmt.all({ uid, sinceMs, untilMs, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }) as TypingActivityCell[]
  }

  /** Same as {@link listActivityGridForUid} but restricted to a single
   * machine_hash so the Analyze "This device" scope can exclude the
   * contribution of other devices. */
  listActivityGridForUidAndHash(
    uid: string,
    machineHash: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): TypingActivityCell[] {
    return this.stmts.summary.selectActivityGridForUidAndHashStmt.all({ uid, machineHash, sinceMs, untilMs, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }) as TypingActivityCell[]
  }

  /** Per-layer keystroke totals for the Analyze > Layer tab. Layers
   * with zero keystrokes in the window are omitted; callers zero-fill
   * against the current snapshot's layer count. Rows ordered by layer
   * index ASC. */
  listLayerUsageForUid(
    uid: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): TypingLayerUsageRow[] {
    return this.stmts.summary.selectLayerUsageForUidStmt.all({ uid, sinceMs, untilMs, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }) as TypingLayerUsageRow[]
  }

  /** Same as {@link listLayerUsageForUid} but restricted to one
   * machine_hash for the Analyze "This device" scope. */
  listLayerUsageForUidAndHash(
    uid: string,
    machineHash: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): TypingLayerUsageRow[] {
    return this.stmts.summary.selectLayerUsageForUidAndHashStmt.all({ uid, machineHash, sinceMs, untilMs, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }) as TypingLayerUsageRow[]
  }

  /** Per-(layer, row, col) press totals for the Analyze > Layer
   * activations mode. The renderer pairs each row with the keymap
   * snapshot to recover the QMK id and dispatch layer-op counts to
   * their target layer. */
  listMatrixCellsForUid(
    uid: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): TypingMatrixCellRow[] {
    return this.stmts.summary.selectMatrixCellsForUidStmt.all({ uid, sinceMs, untilMs, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }) as TypingMatrixCellRow[]
  }

  /** Same as {@link listMatrixCellsForUid} but restricted to one
   * machine_hash for the Analyze "This device" scope. */
  listMatrixCellsForUidAndHash(
    uid: string,
    machineHash: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): TypingMatrixCellRow[] {
    return this.stmts.summary.selectMatrixCellsForUidAndHashStmt.all({ uid, machineHash, sinceMs, untilMs, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }) as TypingMatrixCellRow[]
  }

  /** Per-(scope, minute, cell) raw duration rows in `[sinceMs, untilMs)`
   * for the Analyze keypress-duration aggregate. One row per minute a
   * cell had at least one `matrix-release` sample — the aggregation
   * layer (bigram-aggregate.ts) folds hist/sum/sumSq per cell across
   * rows, the same pattern as the n-gram range selects. */
  listMatrixDurationCellsForUid(
    uid: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): MatrixDurationCellRow[] {
    return this.toMatrixDurationCellRows(
      this.stmts.summary.selectMatrixDurationForUidStmt.all({ uid, sinceMs, untilMs, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }),
    )
  }

  /** Same as {@link listMatrixDurationCellsForUid} but restricted to one
   * machine_hash for the Analyze "This device" scope. */
  listMatrixDurationCellsForUidAndHash(
    uid: string,
    machineHash: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): MatrixDurationCellRow[] {
    return this.toMatrixDurationCellRows(
      this.stmts.summary.selectMatrixDurationForUidAndHashStmt.all({ uid, machineHash, sinceMs, untilMs, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }),
    )
  }

  private toMatrixDurationCellRows(raws: unknown): MatrixDurationCellRow[] {
    return (raws as { row: number; col: number; layer: number; minuteTs: number; durHist: Uint8Array; durSum: number; durSumSq: number }[]).map((r) => ({
      row: r.row,
      col: r.col,
      layer: r.layer,
      minuteTs: r.minuteTs,
      hist: decodeHistBuffer(r.durHist),
      sum: r.durSum,
      sumSq: r.durSumSq,
    }))
  }

  /** Per-(localDay, layer, row, col) press totals for the Analyze
   * Ergonomic Learning Curve. The SQL groups by a `localtime` date
   * string so day boundaries match the user's wall clock; we map that
   * string to a local-midnight epoch here so callers can do numeric
   * bucketing without parsing dates again. */
  listMatrixCellsByDayForUid(
    uid: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): TypingMatrixCellDailyRow[] {
    const rows = this.stmts.summary.selectMatrixCellsByDayForUidStmt.all({ uid, sinceMs, untilMs, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }) as MatrixCellsByDayDbRow[]
    return rows.map(matrixCellsByDayDbRowToDailyRow)
  }

  /** Same as {@link listMatrixCellsByDayForUid} but restricted to one
   * machine_hash. */
  listMatrixCellsByDayForUidAndHash(
    uid: string,
    machineHash: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): TypingMatrixCellDailyRow[] {
    const rows = this.stmts.summary.selectMatrixCellsByDayForUidAndHashStmt.all({ uid, machineHash, sinceMs, untilMs, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }) as MatrixCellsByDayDbRow[]
    return rows.map(matrixCellsByDayDbRowToDailyRow)
  }

  /** Minute-raw stats for the Analyze WPM / Interval charts over the
   * `[sinceMs, untilMs)` window. Callers bucket these on the renderer
   * side so the SQL layer is independent of the user-picked bucket
   * width. Rows ordered by minute_ts ASC. An empty `appScopes` array
   * (or omitted) keeps the result identical to the pre-filter
   * behaviour. */
  listMinuteStatsInRangeForUid(
    uid: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): TypingMinuteStatsRow[] {
    return this.stmts.range.selectMinuteStatsInRangeForUidStmt.all({
      uid,
      sinceMs,
      untilMs,
      appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes),
    }) as TypingMinuteStatsRow[]
  }

  /** Same as {@link listMinuteStatsInRangeForUid} but restricted to a
   * single machine_hash for the Analyze "This device" scope. */
  listMinuteStatsInRangeForUidAndHash(
    uid: string,
    machineHash: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): TypingMinuteStatsRow[] {
    return this.stmts.range.selectMinuteStatsInRangeForUidAndHashStmt.all({
      uid,
      machineHash,
      sinceMs,
      untilMs,
      appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes),
    }) as TypingMinuteStatsRow[]
  }

  /** Per-minute observed-rollover accumulators for the Analyze rollover
   * trend chart — see {@link selectRolloverMinutesStmt}. `machineHash`
   * `null` widens the scope to all devices (the Analyze "own" scope
   * resolves its own hash before calling this); minutes with no
   * determined-overlap bigram row are simply absent, not returned with
   * `on: 0`. The query's quoted `"on"` alias already matches
   * `TypingRolloverMinuteRow` field-for-field, so no rename is needed. */
  listRolloverMinutesInRange(
    uid: string,
    machineHash: string | null,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): TypingRolloverMinuteRow[] {
    return this.stmts.range.selectRolloverMinutesStmt.all({
      uid,
      machineHash,
      sinceMs,
      untilMs,
      appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes),
    }) as TypingRolloverMinuteRow[]
  }

  /** Distinct application names with keystroke totals over the range.
   * `machineHash === null` widens the scope to all devices. NULL
   * (mixed/unknown) minutes are excluded so the dropdown only lists
   * filterable values. */
  listAppsForUidInRange(
    uid: string,
    machineHash: string | null,
    sinceMs: number,
    untilMs: number,
  ): { name: string; keystrokes: number; activeMs: number }[] {
    return this.stmts.range.selectAppsForUidInRangeStmt.all({ uid, machineHash, sinceMs, untilMs }) as {
      name: string
      keystrokes: number
      activeMs: number
    }[]
  }

  /** Distinct typing_test labels with activity in range — the TypingTest
   * filter's option source. */
  listTypingTestsForUidInRange(
    uid: string,
    machineHash: string | null,
    sinceMs: number,
    untilMs: number,
  ): { name: string; keystrokes: number; activeMs: number }[] {
    return this.stmts.range.selectTypingTestsForUidInRangeStmt.all({ uid, machineHash, sinceMs, untilMs }) as {
      name: string
      keystrokes: number
      activeMs: number
    }[]
  }

  /** Distinct typing-test run ids with activity in range — the per-run
   * ("Results") filter's option source. Runs are the source of truth for
   * what exists; `typingTestScopes` narrows them to the selected
   * material(s) (empty = all). `firstMs` is the run's start minute, used to
   * label runs that have no saved typingTestResults entry. */
  listTypingTestRunsForUidInRange(
    uid: string,
    machineHash: string | null,
    sinceMs: number,
    untilMs: number,
    typingTestScopes: readonly string[] = [],
  ): { runId: string; keystrokes: number; firstMs: number }[] {
    return this.stmts.range.selectTypingTestRunsForUidInRangeStmt.all({
      uid,
      machineHash,
      sinceMs,
      untilMs,
      typingTestsJson: JSON.stringify(typingTestScopes),
    }) as { runId: string; keystrokes: number; firstMs: number }[]
  }

  /** Per-app keystroke / activeMs aggregates including a synthetic
   * `__unknown__` bucket for NULL (Monitor App off / mixed minute /
   * lookup failed). The renderer maps the sentinel to a localized
   * "Unknown" label. */
  getAppUsageForUidInRange(
    uid: string,
    machineHash: string | null,
    sinceMs: number,
    untilMs: number,
  ): { name: string; keystrokes: number; activeMs: number }[] {
    return this.stmts.range.selectAppUsageForUidInRangeStmt.all({ uid, machineHash, sinceMs, untilMs }) as {
      name: string
      keystrokes: number
      activeMs: number
    }[]
  }

  /** Per-app WPM aggregate. Only single-app minutes contribute (NULL
   * is excluded by the SQL); the renderer computes wpm =
   * keystrokes / 5 / activeMs * 60_000 from the returned keystrokes
   * + activeMs sums so it matches the WPM tab's existing formula. */
  getWpmByAppForUidInRange(
    uid: string,
    machineHash: string | null,
    sinceMs: number,
    untilMs: number,
  ): { name: string; keystrokes: number; activeMs: number }[] {
    return this.stmts.range.selectWpmByAppForUidInRangeStmt.all({ uid, machineHash, sinceMs, untilMs }) as {
      name: string
      keystrokes: number
      activeMs: number
    }[]
  }

  /** Per-(scope, minute, ngram) rows in `[sinceMs, untilMs)` for the
   * Analyze Bigrams / n-gram view. `gram` selects `typing_bigram_minute`
   * (2) or `typing_trigram_minute` (3) via {@link ngramStmts}. Hist is
   * decoded from the BLOB so the aggregation layer stays independent of
   * the on-disk encoding. Rows are ordered by `ngramId, minuteTs` so a
   * streaming aggregator can accumulate per-pair totals without sorting. */
  listNgramMinutesInRangeForUid(
    gram: 2 | 3,
    uid: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): NgramMinuteCellRow[] {
    return this.toNgramMinuteCellRows(
      this.stmts.ngram[gram].selectInRangeForUid.all({ uid, sinceMs, untilMs, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }),
    )
  }

  /** Same as {@link listNgramMinutesInRangeForUid} but restricted to a
   * single machine_hash for the Analyze "This device" scope. */
  listNgramMinutesInRangeForUidAndHash(
    gram: 2 | 3,
    uid: string,
    machineHash: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): NgramMinuteCellRow[] {
    return this.toNgramMinuteCellRows(
      this.stmts.ngram[gram].selectInRangeForUidAndHash.all({
        uid,
        machineHash,
        sinceMs,
        untilMs,
        appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes),
      }),
    )
  }

  private toNgramMinuteCellRows(raws: unknown): NgramMinuteCellRow[] {
    return (raws as {
      ngramId: string
      minuteTs: number
      count: number
      hist: Uint8Array
      sumIki: number | null
      sumSqIki: number | null
      // Absent (not selected) on a trigram query — see prepareNgramStatements.
      overlapCount?: number | null
      overlapN?: number | null
    }[]).map((r) => ({
      ngramId: r.ngramId,
      minuteTs: r.minuteTs,
      count: r.count,
      hist: decodeHistBuffer(r.hist),
      sumIki: r.sumIki,
      sumSqIki: r.sumSqIki,
      overlapCount: r.overlapCount,
      overlapN: r.overlapN,
    }))
  }

  /** @deprecated thin gram=2 wrapper kept for existing call sites
   * (hub-analytics.ts, tests) — prefer {@link listNgramMinutesInRangeForUid}. */
  listBigramMinutesInRangeForUid(
    uid: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): NgramMinuteCellRow[] {
    return this.listNgramMinutesInRangeForUid(2, uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
  }

  /** @deprecated thin gram=2 wrapper — see {@link listBigramMinutesInRangeForUid}. */
  listBigramMinutesInRangeForUidAndHash(
    uid: string,
    machineHash: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): NgramMinuteCellRow[] {
    return this.listNgramMinutesInRangeForUidAndHash(2, uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
  }

  /** @deprecated thin gram=3 wrapper — see {@link listBigramMinutesInRangeForUid}. */
  listTrigramMinutesInRangeForUid(
    uid: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): NgramMinuteCellRow[] {
    return this.listNgramMinutesInRangeForUid(3, uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
  }

  /** @deprecated thin gram=3 wrapper — see {@link listBigramMinutesInRangeForUid}. */
  listTrigramMinutesInRangeForUidAndHash(
    uid: string,
    machineHash: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): NgramMinuteCellRow[] {
    return this.listNgramMinutesInRangeForUidAndHash(3, uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
  }

  /** Live sessions that intersect `[sinceMs, untilMs)` for a keyboard
   * uid. Powers the Analyze session-distribution histogram. */
  listSessionsInRangeForUid(uid: string, sinceMs: number, untilMs: number): TypingSessionRow[] {
    return this.stmts.range.selectSessionsInRangeForUidStmt.all({ uid, sinceMs, untilMs }) as TypingSessionRow[]
  }

  /** Same as {@link listSessionsInRangeForUid} but restricted to a
   * single machine_hash for the Analyze "This device" scope. */
  listSessionsInRangeForUidAndHash(
    uid: string,
    machineHash: string,
    sinceMs: number,
    untilMs: number,
  ): TypingSessionRow[] {
    return this.stmts.range.selectSessionsInRangeForUidAndHashStmt.all({ uid, machineHash, sinceMs, untilMs }) as TypingSessionRow[]
  }

  /** Per-minute Backspace-share aggregate for `[sinceMs, untilMs)`.
   * Only minutes that received typing-test input contribute; general
   * matrix-path typing does not feed `typing_char_minute`. */
  listBksMinuteInRangeForUid(
    uid: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): TypingBksMinuteRow[] {
    return this.stmts.range.selectBksMinuteInRangeForUidStmt.all({ uid, sinceMs, untilMs, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }) as TypingBksMinuteRow[]
  }

  /** Same as {@link listBksMinuteInRangeForUid} but restricted to a
   * single machine_hash for the Analyze "This device" scope. */
  listBksMinuteInRangeForUidAndHash(
    uid: string,
    machineHash: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): TypingBksMinuteRow[] {
    return this.stmts.range.selectBksMinuteInRangeForUidAndHashStmt.all({ uid, machineHash, sinceMs, untilMs, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }) as TypingBksMinuteRow[]
  }

  /** Peak records for the Analyze summary cards across every scope of
   * this keyboard in the range. Any metric with no qualifying rows
   * comes back as null so the UI can render an empty placeholder. */
  getPeakRecordsInRangeForUid(
    uid: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): PeakRecords {
    // typing_sessions has no app_name column — sessions span multiple
    // minutes and the app focus can change during one. We deliberately
    // ignore appScopes for the session record so it stays a measure of
    // raw uninterrupted typing rather than vanishing when the user
    // crosses an app boundary mid-burst. The four minute-stats records
    // do honour the filter so the WPM / keystroke-per-minute peaks
    // match the rest of the per-app aggregates.
    const sessParams = { uid, sinceMs, untilMs }
    const params = { ...sessParams, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }
    const wpm = this.stmts.range.selectPeakWpmInRangeForUidStmt.get(params) as { value: number; atMs: number } | undefined
    const low = this.stmts.range.selectLowestWpmInRangeForUidStmt.get(params) as { value: number; atMs: number } | undefined
    const kpm = this.stmts.range.selectPeakKpmInRangeForUidStmt.get(params) as { value: number; atMs: number } | undefined
    const kpd = this.stmts.range.selectPeakKpdInRangeForUidStmt.get(params) as { day: string; value: number } | undefined
    const sess = this.stmts.range.selectLongestSessionInRangeForUidStmt.get(sessParams) as { durationMs: number; startedAtMs: number } | undefined
    return {
      peakWpm: wpm ? { value: wpm.value, atMs: wpm.atMs } : null,
      lowestWpm: low ? { value: low.value, atMs: low.atMs } : null,
      peakKeystrokesPerMin: kpm ? { value: kpm.value, atMs: kpm.atMs } : null,
      peakKeystrokesPerDay: kpd ? { value: kpd.value, day: kpd.day } : null,
      longestSession: sess ? { durationMs: sess.durationMs, startedAtMs: sess.startedAtMs } : null,
    }
  }

  /** Same as {@link getPeakRecordsInRangeForUid} but restricted to a
   * single machine_hash (the Analyze "This device" scope). */
  getPeakRecordsInRangeForUidAndHash(
    uid: string,
    machineHash: string,
    sinceMs: number,
    untilMs: number,
    appScopes: readonly string[] = [], typingTestScopes: readonly string[] = [], runIdScopes: readonly string[] = [],
  ): PeakRecords {
    const sessParams = { uid, machineHash, sinceMs, untilMs }
    const params = { ...sessParams, appNamesJson: JSON.stringify(appScopes), typingTestsJson: JSON.stringify(typingTestScopes), runIdsJson: JSON.stringify(runIdScopes) }
    const wpm = this.stmts.range.selectPeakWpmInRangeForUidAndHashStmt.get(params) as { value: number; atMs: number } | undefined
    const low = this.stmts.range.selectLowestWpmInRangeForUidAndHashStmt.get(params) as { value: number; atMs: number } | undefined
    const kpm = this.stmts.range.selectPeakKpmInRangeForUidAndHashStmt.get(params) as { value: number; atMs: number } | undefined
    const kpd = this.stmts.range.selectPeakKpdInRangeForUidAndHashStmt.get(params) as { day: string; value: number } | undefined
    const sess = this.stmts.range.selectLongestSessionInRangeForUidAndHashStmt.get(sessParams) as { durationMs: number; startedAtMs: number } | undefined
    return {
      peakWpm: wpm ? { value: wpm.value, atMs: wpm.atMs } : null,
      lowestWpm: low ? { value: low.value, atMs: low.atMs } : null,
      peakKeystrokesPerMin: kpm ? { value: kpm.value, atMs: kpm.atMs } : null,
      peakKeystrokesPerDay: kpd ? { value: kpd.value, day: kpd.day } : null,
      longestSession: sess ? { durationMs: sess.durationMs, startedAtMs: sess.startedAtMs } : null,
    }
  }

  /** Per-remote device info (machine_hash + OS) for devices that hold
   * at least one live minute-stats row for this keyboard. Used by the
   * Analyze > Device filter to label entries with their OS. */
  listRemoteDeviceInfosForUid(
    uid: string,
    ownHash: string,
  ): Array<{ machineHash: string; osPlatform: string; osRelease: string }> {
    return this.stmts.sync.selectRemoteHashesForUidStmt.all({ uid, ownHash }) as Array<{
      machineHash: string
      osPlatform: string
      osRelease: string
    }>
  }
}
