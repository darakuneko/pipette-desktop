// SPDX-License-Identifier: GPL-2.0-or-later
// SQLite-backed storage for typing analytics. Provides a typed, synchronous
// API on top of better-sqlite3 for the service layer to consume.

import Database from 'better-sqlite3'
import type { Database as DatabaseType, Statement } from 'better-sqlite3'
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CREATE_SCHEMA_SQL, SCHEMA_VERSION } from './schema'

export interface TypingScopeRow {
  id: string
  machineHash: string
  osPlatform: string
  osRelease: string
  osArch: string
  keyboardUid: string
  keyboardVendorId: number
  keyboardProductId: number
  keyboardProductName: string
  updatedAt: number
  isDeleted?: boolean
}

export interface CharMinuteRow {
  scopeId: string
  minuteTs: number
  char: string
  count: number
}

export interface MatrixMinuteRow {
  scopeId: string
  minuteTs: number
  row: number
  col: number
  layer: number
  keycode: number
  count: number
  /** Portion of `count` attributed to a tap on the release edge for
   * LT/MT keys. Defaults to 0 when the row came from a non-tap-hold
   * press (older ingestion path, test fixtures, or still-held keys). */
  tapCount?: number
  /** Portion of `count` attributed to a hold on the release edge.
   * Defaults to 0 for the same reasons as `tapCount`. */
  holdCount?: number
}

export interface MinuteStatsRow {
  scopeId: string
  minuteTs: number
  keystrokes: number
  activeMs: number
  intervalAvgMs: number | null
  intervalMinMs: number | null
  intervalP25Ms: number | null
  intervalP50Ms: number | null
  intervalP75Ms: number | null
  intervalMaxMs: number | null
}

export interface SessionRow {
  id: string
  scopeId: string
  startMs: number
  endMs: number
}

/** Row shapes carried across sync bundles. Live columns plus the
 * updated_at / is_deleted metadata the merge layer needs for LWW. */
export interface CharMinuteExportRow extends CharMinuteRow {
  updatedAt: number
  isDeleted: boolean
}
export interface MatrixMinuteExportRow extends MatrixMinuteRow {
  updatedAt: number
  isDeleted: boolean
}
export interface MinuteStatsExportRow extends MinuteStatsRow {
  updatedAt: number
  isDeleted: boolean
}
export interface SessionExportRow extends SessionRow {
  updatedAt: number
  isDeleted: boolean
}

export type {
  TypingKeyboardSummary,
  TypingDailySummary,
  TypingIntervalDailySummary,
  TypingActivityCell,
  TypingMinuteStatsRow,
  TypingSessionRow,
  TypingBksMinuteRow,
  TypingTombstoneResult,
  PeakRecords,
} from '../../../shared/types/typing-analytics'

export class TypingAnalyticsDB {
  private readonly db: DatabaseType
  private readonly upsertScopeStmt: Statement
  private readonly upsertCharMinuteStmt: Statement
  private readonly upsertMatrixMinuteStmt: Statement
  private readonly upsertMinuteStatsStmt: Statement
  private readonly insertSessionStmt: Statement
  private readonly mergeScopeStmt: Statement
  private readonly mergeCharMinuteStmt: Statement
  private readonly mergeMatrixMinuteStmt: Statement
  private readonly mergeMinuteStatsStmt: Statement
  private readonly mergeSessionStmt: Statement
  private readonly selectScopesForUidStmt: Statement
  private readonly selectCharMinutesForUidStmt: Statement
  private readonly selectMatrixMinutesForUidStmt: Statement
  private readonly selectMinuteStatsForUidStmt: Statement
  private readonly selectSessionsForUidStmt: Statement
  private readonly selectLocalKeyboardUidsStmt: Statement
  private readonly selectMatrixHeatmapStmt: Statement
  private readonly selectMatrixHeatmapInRangeStmt: Statement
  private readonly selectMatrixHeatmapInRangeForHashStmt: Statement
  private readonly selectKeyboardsWithTypingDataStmt: Statement
  private readonly selectDailySummariesForUidStmt: Statement
  private readonly selectDailySummariesForUidAndHashStmt: Statement
  private readonly selectIntervalSummariesForUidStmt: Statement
  private readonly selectIntervalSummariesForUidAndHashStmt: Statement
  private readonly selectActivityGridForUidStmt: Statement
  private readonly selectActivityGridForUidAndHashStmt: Statement
  private readonly selectMinuteStatsInRangeForUidStmt: Statement
  private readonly selectMinuteStatsInRangeForUidAndHashStmt: Statement
  private readonly selectSessionsInRangeForUidStmt: Statement
  private readonly selectSessionsInRangeForUidAndHashStmt: Statement
  private readonly selectBksMinuteInRangeForUidStmt: Statement
  private readonly selectBksMinuteInRangeForUidAndHashStmt: Statement
  private readonly selectPeakWpmInRangeForUidStmt: Statement
  private readonly selectPeakWpmInRangeForUidAndHashStmt: Statement
  private readonly selectPeakKpmInRangeForUidStmt: Statement
  private readonly selectPeakKpmInRangeForUidAndHashStmt: Statement
  private readonly selectPeakKpdInRangeForUidStmt: Statement
  private readonly selectPeakKpdInRangeForUidAndHashStmt: Statement
  private readonly selectLongestSessionInRangeForUidStmt: Statement
  private readonly selectLongestSessionInRangeForUidAndHashStmt: Statement
  private readonly selectRemoteHashesForUidStmt: Statement
  private readonly selectOwnScopeIdsForUidStmt: Statement
  private readonly selectLiveCharMinutesForScopeStmt: Statement
  private readonly selectLiveMatrixMinutesForScopeStmt: Statement
  private readonly selectLiveMinuteStatsForScopeStmt: Statement
  private readonly selectLiveSessionsForScopeStmt: Statement
  private readonly tombstoneCharMinutesInRangeStmt: Statement
  private readonly tombstoneCharMinutesForHashInRangeStmt: Statement
  private readonly tombstoneMatrixMinutesForHashInRangeStmt: Statement
  private readonly tombstoneMinuteStatsForHashInRangeStmt: Statement
  private readonly tombstoneSessionsForHashInRangeStmt: Statement
  private readonly tombstoneMatrixMinutesInRangeStmt: Statement
  private readonly tombstoneMinuteStatsInRangeStmt: Statement
  private readonly tombstoneSessionsInRangeStmt: Statement
  private readonly tombstoneAllCharMinutesStmt: Statement
  private readonly tombstoneAllMatrixMinutesStmt: Statement
  private readonly tombstoneAllMinuteStatsStmt: Statement
  private readonly tombstoneAllSessionsStmt: Statement
  private readonly deleteCharMinuteBeforeStmt: Statement
  private readonly deleteMatrixMinuteBeforeStmt: Statement
  private readonly deleteMinuteStatsBeforeStmt: Statement
  private readonly deleteSessionsBeforeStmt: Statement
  private readonly getMetaStmt: Statement
  private readonly setMetaStmt: Statement

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.exec(CREATE_SCHEMA_SQL)

    this.getMetaStmt = this.db.prepare('SELECT value FROM typing_analytics_meta WHERE key = ?')
    this.setMetaStmt = this.db.prepare(`
      INSERT INTO typing_analytics_meta (key, value) VALUES (@key, @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)

    const stored = this.getMeta('schema_version')
    if (stored == null) {
      this.setMeta('schema_version', String(SCHEMA_VERSION))
    } else if (Number(stored) !== SCHEMA_VERSION) {
      this.migrateSchema(Number(stored))
      this.setMeta('schema_version', String(SCHEMA_VERSION))
    }

    this.upsertScopeStmt = this.db.prepare(`
      INSERT INTO typing_scopes (
        id, machine_hash, os_platform, os_release, os_arch,
        keyboard_uid, keyboard_vendor_id, keyboard_product_id, keyboard_product_name,
        updated_at, is_deleted
      ) VALUES (
        @id, @machineHash, @osPlatform, @osRelease, @osArch,
        @keyboardUid, @keyboardVendorId, @keyboardProductId, @keyboardProductName,
        @updatedAt, 0
      )
      ON CONFLICT(id) DO UPDATE SET
        machine_hash = excluded.machine_hash,
        os_platform = excluded.os_platform,
        os_release = excluded.os_release,
        os_arch = excluded.os_arch,
        keyboard_uid = excluded.keyboard_uid,
        keyboard_vendor_id = excluded.keyboard_vendor_id,
        keyboard_product_id = excluded.keyboard_product_id,
        keyboard_product_name = excluded.keyboard_product_name,
        updated_at = excluded.updated_at,
        is_deleted = 0
      WHERE excluded.updated_at > typing_scopes.updated_at
    `)

    this.upsertCharMinuteStmt = this.db.prepare(`
      INSERT INTO typing_char_minute (scope_id, minute_ts, char, count, updated_at, is_deleted)
      VALUES (@scopeId, @minuteTs, @char, @count, @updatedAt, 0)
      ON CONFLICT(scope_id, minute_ts, char) DO UPDATE SET
        count = typing_char_minute.count + excluded.count,
        updated_at = excluded.updated_at,
        is_deleted = 0
    `)

    this.upsertMatrixMinuteStmt = this.db.prepare(`
      INSERT INTO typing_matrix_minute (
        scope_id, minute_ts, row, col, layer, keycode, count,
        tap_count, hold_count,
        updated_at, is_deleted
      )
      VALUES (
        @scopeId, @minuteTs, @row, @col, @layer, @keycode, @count,
        @tapCount, @holdCount,
        @updatedAt, 0
      )
      ON CONFLICT(scope_id, minute_ts, row, col, layer) DO UPDATE SET
        count = typing_matrix_minute.count + excluded.count,
        tap_count = typing_matrix_minute.tap_count + excluded.tap_count,
        hold_count = typing_matrix_minute.hold_count + excluded.hold_count,
        keycode = excluded.keycode,
        updated_at = excluded.updated_at,
        is_deleted = 0
    `)

    this.upsertMinuteStatsStmt = this.db.prepare(`
      INSERT INTO typing_minute_stats (
        scope_id, minute_ts, keystrokes, active_ms,
        interval_avg_ms, interval_min_ms,
        interval_p25_ms, interval_p50_ms, interval_p75_ms, interval_max_ms,
        updated_at, is_deleted
      )
      VALUES (
        @scopeId, @minuteTs, @keystrokes, @activeMs,
        @intervalAvgMs, @intervalMinMs,
        @intervalP25Ms, @intervalP50Ms, @intervalP75Ms, @intervalMaxMs,
        @updatedAt, 0
      )
      ON CONFLICT(scope_id, minute_ts) DO UPDATE SET
        keystrokes = typing_minute_stats.keystrokes + excluded.keystrokes,
        active_ms = typing_minute_stats.active_ms + excluded.active_ms,
        interval_avg_ms = excluded.interval_avg_ms,
        interval_min_ms = MIN(typing_minute_stats.interval_min_ms, excluded.interval_min_ms),
        interval_p25_ms = excluded.interval_p25_ms,
        interval_p50_ms = excluded.interval_p50_ms,
        interval_p75_ms = excluded.interval_p75_ms,
        interval_max_ms = MAX(typing_minute_stats.interval_max_ms, excluded.interval_max_ms),
        updated_at = excluded.updated_at,
        is_deleted = 0
    `)

    this.insertSessionStmt = this.db.prepare(`
      INSERT INTO typing_sessions (id, scope_id, start_ms, end_ms, updated_at, is_deleted)
      VALUES (@id, @scopeId, @startMs, @endMs, @updatedAt, 0)
      ON CONFLICT(id) DO UPDATE SET
        start_ms = excluded.start_ms,
        end_ms = excluded.end_ms,
        updated_at = excluded.updated_at,
        is_deleted = 0
      WHERE excluded.updated_at > typing_sessions.updated_at
    `)

    this.deleteCharMinuteBeforeStmt = this.db.prepare(`
      DELETE FROM typing_char_minute
       WHERE scope_id IN (SELECT id FROM typing_scopes WHERE machine_hash = @machineHash)
         AND minute_ts < @cutoffMs
    `)

    this.deleteMatrixMinuteBeforeStmt = this.db.prepare(`
      DELETE FROM typing_matrix_minute
       WHERE scope_id IN (SELECT id FROM typing_scopes WHERE machine_hash = @machineHash)
         AND minute_ts < @cutoffMs
    `)

    this.deleteMinuteStatsBeforeStmt = this.db.prepare(`
      DELETE FROM typing_minute_stats
       WHERE scope_id IN (SELECT id FROM typing_scopes WHERE machine_hash = @machineHash)
         AND minute_ts < @cutoffMs
    `)

    this.deleteSessionsBeforeStmt = this.db.prepare(`
      DELETE FROM typing_sessions
       WHERE scope_id IN (SELECT id FROM typing_scopes WHERE machine_hash = @machineHash)
         AND end_ms < @cutoffMs
    `)

    // Authoritative LWW upserts for sync merge. Unlike the additive
    // ingestion upserts above, these replace the target row wholesale,
    // respect the incoming is_deleted flag, and only fire when
    // excluded.updated_at is strictly newer than the existing row.
    this.mergeScopeStmt = this.db.prepare(`
      INSERT INTO typing_scopes (
        id, machine_hash, os_platform, os_release, os_arch,
        keyboard_uid, keyboard_vendor_id, keyboard_product_id, keyboard_product_name,
        updated_at, is_deleted
      ) VALUES (
        @id, @machineHash, @osPlatform, @osRelease, @osArch,
        @keyboardUid, @keyboardVendorId, @keyboardProductId, @keyboardProductName,
        @updatedAt, @isDeleted
      )
      ON CONFLICT(id) DO UPDATE SET
        machine_hash = excluded.machine_hash,
        os_platform = excluded.os_platform,
        os_release = excluded.os_release,
        os_arch = excluded.os_arch,
        keyboard_uid = excluded.keyboard_uid,
        keyboard_vendor_id = excluded.keyboard_vendor_id,
        keyboard_product_id = excluded.keyboard_product_id,
        keyboard_product_name = excluded.keyboard_product_name,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted
      WHERE excluded.updated_at > typing_scopes.updated_at
    `)

    this.mergeCharMinuteStmt = this.db.prepare(`
      INSERT INTO typing_char_minute (
        scope_id, minute_ts, char, count, updated_at, is_deleted
      )
      VALUES (
        @scopeId, @minuteTs, @char, @count, @updatedAt, @isDeleted
      )
      ON CONFLICT(scope_id, minute_ts, char) DO UPDATE SET
        count = excluded.count,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted
      WHERE excluded.updated_at > typing_char_minute.updated_at
    `)

    this.mergeMatrixMinuteStmt = this.db.prepare(`
      INSERT INTO typing_matrix_minute (
        scope_id, minute_ts, row, col, layer, keycode, count,
        tap_count, hold_count,
        updated_at, is_deleted
      )
      VALUES (
        @scopeId, @minuteTs, @row, @col, @layer, @keycode, @count,
        @tapCount, @holdCount,
        @updatedAt, @isDeleted
      )
      ON CONFLICT(scope_id, minute_ts, row, col, layer) DO UPDATE SET
        keycode = excluded.keycode,
        count = excluded.count,
        tap_count = excluded.tap_count,
        hold_count = excluded.hold_count,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted
      WHERE excluded.updated_at > typing_matrix_minute.updated_at
    `)

    this.mergeMinuteStatsStmt = this.db.prepare(`
      INSERT INTO typing_minute_stats (
        scope_id, minute_ts, keystrokes, active_ms,
        interval_avg_ms, interval_min_ms,
        interval_p25_ms, interval_p50_ms, interval_p75_ms, interval_max_ms,
        updated_at, is_deleted
      )
      VALUES (
        @scopeId, @minuteTs, @keystrokes, @activeMs,
        @intervalAvgMs, @intervalMinMs,
        @intervalP25Ms, @intervalP50Ms, @intervalP75Ms, @intervalMaxMs,
        @updatedAt, @isDeleted
      )
      ON CONFLICT(scope_id, minute_ts) DO UPDATE SET
        keystrokes = excluded.keystrokes,
        active_ms = excluded.active_ms,
        interval_avg_ms = excluded.interval_avg_ms,
        interval_min_ms = excluded.interval_min_ms,
        interval_p25_ms = excluded.interval_p25_ms,
        interval_p50_ms = excluded.interval_p50_ms,
        interval_p75_ms = excluded.interval_p75_ms,
        interval_max_ms = excluded.interval_max_ms,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted
      WHERE excluded.updated_at > typing_minute_stats.updated_at
    `)

    this.mergeSessionStmt = this.db.prepare(`
      INSERT INTO typing_sessions (
        id, scope_id, start_ms, end_ms, updated_at, is_deleted
      )
      VALUES (
        @id, @scopeId, @startMs, @endMs, @updatedAt, @isDeleted
      )
      ON CONFLICT(id) DO UPDATE SET
        scope_id = excluded.scope_id,
        start_ms = excluded.start_ms,
        end_ms = excluded.end_ms,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted
      WHERE excluded.updated_at > typing_sessions.updated_at
    `)

    // Sync export selects. Live rows within the live window or tombstones
    // within the longer tombstone window. typing_scopes is selected without
    // a time filter so every scope a remote might reference still resolves
    // its FK parent on the receiving side.
    this.selectScopesForUidStmt = this.db.prepare(`
      SELECT id, machine_hash AS machineHash,
             os_platform AS osPlatform, os_release AS osRelease, os_arch AS osArch,
             keyboard_uid AS keyboardUid,
             keyboard_vendor_id AS keyboardVendorId,
             keyboard_product_id AS keyboardProductId,
             keyboard_product_name AS keyboardProductName,
             updated_at AS updatedAt,
             is_deleted AS isDeleted
        FROM typing_scopes
       WHERE keyboard_uid = @uid
         AND (is_deleted = 0 OR updated_at >= @tombstoneSinceMs)
    `)

    this.selectCharMinutesForUidStmt = this.db.prepare(`
      SELECT c.scope_id AS scopeId, c.minute_ts AS minuteTs, c.char AS char,
             c.count AS count, c.updated_at AS updatedAt, c.is_deleted AS isDeleted
        FROM typing_char_minute c
        JOIN typing_scopes s ON s.id = c.scope_id
       WHERE s.keyboard_uid = @uid
         AND (
           (c.is_deleted = 0 AND c.minute_ts >= @liveSinceMinuteMs)
           OR
           (c.is_deleted = 1 AND c.updated_at >= @tombstoneSinceMs)
         )
    `)

    this.selectMatrixMinutesForUidStmt = this.db.prepare(`
      SELECT m.scope_id AS scopeId, m.minute_ts AS minuteTs,
             m.row AS row, m.col AS col, m.layer AS layer,
             m.keycode AS keycode, m.count AS count,
             m.tap_count AS tapCount, m.hold_count AS holdCount,
             m.updated_at AS updatedAt, m.is_deleted AS isDeleted
        FROM typing_matrix_minute m
        JOIN typing_scopes s ON s.id = m.scope_id
       WHERE s.keyboard_uid = @uid
         AND (
           (m.is_deleted = 0 AND m.minute_ts >= @liveSinceMinuteMs)
           OR
           (m.is_deleted = 1 AND m.updated_at >= @tombstoneSinceMs)
         )
    `)

    this.selectMinuteStatsForUidStmt = this.db.prepare(`
      SELECT t.scope_id AS scopeId, t.minute_ts AS minuteTs,
             t.keystrokes AS keystrokes, t.active_ms AS activeMs,
             t.interval_avg_ms AS intervalAvgMs,
             t.interval_min_ms AS intervalMinMs,
             t.interval_p25_ms AS intervalP25Ms,
             t.interval_p50_ms AS intervalP50Ms,
             t.interval_p75_ms AS intervalP75Ms,
             t.interval_max_ms AS intervalMaxMs,
             t.updated_at AS updatedAt, t.is_deleted AS isDeleted
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND (
           (t.is_deleted = 0 AND t.minute_ts >= @liveSinceMinuteMs)
           OR
           (t.is_deleted = 1 AND t.updated_at >= @tombstoneSinceMs)
         )
    `)

    this.selectSessionsForUidStmt = this.db.prepare(`
      SELECT x.id AS id, x.scope_id AS scopeId,
             x.start_ms AS startMs, x.end_ms AS endMs,
             x.updated_at AS updatedAt, x.is_deleted AS isDeleted
        FROM typing_sessions x
        JOIN typing_scopes s ON s.id = x.scope_id
       WHERE s.keyboard_uid = @uid
         AND (
           (x.is_deleted = 0 AND x.start_ms >= @liveSinceStartMs)
           OR
           (x.is_deleted = 1 AND x.updated_at >= @tombstoneSinceMs)
         )
    `)

    this.selectLocalKeyboardUidsStmt = this.db.prepare(`
      SELECT DISTINCT keyboard_uid AS keyboardUid
        FROM typing_scopes
       WHERE machine_hash = @machineHash
         AND is_deleted = 0
    `)

    // Aggregated per-(row, col) counts for the typing-view heatmap.
    // Restricted to one machine + one uid + one layer, and only rolls up
    // minutes at or after @sinceMinuteMs (already minute-floored by the
    // caller). Both tables' is_deleted flags are filtered so tombstoned
    // scopes and tombstoned minute rows are both excluded.
    this.selectMatrixHeatmapStmt = this.db.prepare(`
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
    `)

    // Range-bounded matrix heatmap — used by the Analyze key-heatmap
    // tab where the user picks an explicit [sinceMs, untilMs) window.
    // Aggregates across every machine_hash (the Analyze tab can scope
    // device-wise at the renderer, but the SQL stays device-agnostic
    // so `deviceScope: 'all'` works without a second statement).
    this.selectMatrixHeatmapInRangeStmt = this.db.prepare(`
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
       GROUP BY m.row, m.col
    `)

    this.selectMatrixHeatmapInRangeForHashStmt = this.db.prepare(`
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
       GROUP BY m.row, m.col
    `)

    // Data-modal queries. "Has typing data" is defined as "at least one
    // live minute-stats row under one of this uid's scopes" — minute_stats
    // is smaller than char_minute/matrix_minute so EXISTS is cheaper.
    //
    // Product name / vendor / product are aggregated via MAX because a
    // keyboard typed on multiple machines can surface different descriptor
    // values. MAX gives a deterministic-but-arbitrary pick; the renderer
    // treats this as a display label only.
    this.selectKeyboardsWithTypingDataStmt = this.db.prepare(`
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
    `)

    // Daily aggregation. strftime with 'localtime' so day boundaries align
    // with the user's wall-clock expectation (today is "today" even near
    // midnight UTC). Sums across every scope with the same keyboard_uid —
    // different machines contribute additively.
    this.selectDailySummariesForUidStmt = this.db.prepare(`
      SELECT strftime('%Y-%m-%d', t.minute_ts / 1000, 'unixepoch', 'localtime') AS date,
             SUM(t.keystrokes) AS keystrokes,
             SUM(t.active_ms) AS activeMs
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND t.is_deleted = 0
       GROUP BY date
       ORDER BY date DESC
    `)

    // Same as the cross-hash variant but restricted to one machine_hash
    // so the Local tab shows only this device's contribution and the
    // Sync tab can drill into a specific remote device.
    this.selectDailySummariesForUidAndHashStmt = this.db.prepare(`
      SELECT strftime('%Y-%m-%d', t.minute_ts / 1000, 'unixepoch', 'localtime') AS date,
             SUM(t.keystrokes) AS keystrokes,
             SUM(t.active_ms) AS activeMs
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND t.is_deleted = 0
       GROUP BY date
       ORDER BY date DESC
    `)

    // Daily envelope + mean of the per-minute interval quartiles.
    // min/max are taken across every minute that carries a non-null
    // value; p25/p50/p75 are unweighted means (close enough for a
    // rhythm overview, and cheap on the existing column layout).
    this.selectIntervalSummariesForUidStmt = this.db.prepare(`
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
    `)

    this.selectIntervalSummariesForUidAndHashStmt = this.db.prepare(`
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
    `)

    // Hour-of-day × day-of-week activity grid for the Analyze heatmap.
    // Both dimensions are local-time via strftime to match the existing
    // daily summaries. Callers pass @sinceMs to clip to a period
    // (@sinceMs=0 = all time).
    this.selectActivityGridForUidStmt = this.db.prepare(`
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
       GROUP BY dow, hour
    `)

    this.selectActivityGridForUidAndHashStmt = this.db.prepare(`
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
       GROUP BY dow, hour
    `)

    // Minute-raw rows for the Analyze WPM / Interval charts. The client
    // buckets these based on the user-picked datetime range, so the SQL
    // only groups by minute_ts (a scope can legitimately write to the
    // same minute_ts bucket more than once when a machine_hash change
    // lands; SUM / MIN / AVG / MAX merges those scopes into one row).
    this.selectMinuteStatsInRangeForUidStmt = this.db.prepare(`
      SELECT t.minute_ts AS minuteMs,
             SUM(t.keystrokes) AS keystrokes,
             SUM(t.active_ms) AS activeMs,
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
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
       GROUP BY t.minute_ts
       ORDER BY t.minute_ts ASC
    `)

    this.selectMinuteStatsInRangeForUidAndHashStmt = this.db.prepare(`
      SELECT t.minute_ts AS minuteMs,
             SUM(t.keystrokes) AS keystrokes,
             SUM(t.active_ms) AS activeMs,
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
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
       GROUP BY t.minute_ts
       ORDER BY t.minute_ts ASC
    `)

    // Sessions whose start falls inside [@sinceMs, @untilMs). We filter
    // on `start_ms` so "last 24 hours" captures every session the user
    // started today regardless of how long it ran — containment on both
    // edges excluded too many real-world sessions (a 30-minute run
    // that straddles the window boundary would otherwise vanish). The
    // session's *full* length is still reported; that matches how the
    // user experienced it.
    this.selectSessionsInRangeForUidStmt = this.db.prepare(`
      SELECT t.id AS id,
             t.start_ms AS startMs,
             t.end_ms AS endMs
        FROM typing_sessions t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.start_ms >= @sinceMs
         AND t.start_ms < @untilMs
       ORDER BY t.start_ms ASC
    `)

    this.selectSessionsInRangeForUidAndHashStmt = this.db.prepare(`
      SELECT t.id AS id,
             t.start_ms AS startMs,
             t.end_ms AS endMs
        FROM typing_sessions t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.start_ms >= @sinceMs
         AND t.start_ms < @untilMs
       ORDER BY t.start_ms ASC
    `)

    // Per-minute Backspace counts for the Analyze error-proxy
    // overlay. Sourced from `typing_matrix_minute` so all capture
    // paths (HID matrix reads, typing-test, Vial input) contribute.
    //
    // Matching three Backspace shapes:
    //   - `KC_BSPC` direct (keycode == 0x2A = 42) → every press counts
    //   - `LT(layer, KC_BSPC)` (0x4000-0x4FFF, inner byte == 0x2A)
    //     → count only `tap_count`; holds activate a layer, not delete
    //   - `MT(mod, KC_BSPC)` (0x2000-0x2FFF, inner byte == 0x2A)
    //     → same tap-count rule, holds are modifiers
    //
    // Rows with zero Backspace contribution are filtered by `HAVING`
    // so the result only carries minutes that actually registered a
    // delete — matches the renderer's "skip empty bucket" behaviour.
    this.selectBksMinuteInRangeForUidStmt = this.db.prepare(`
      SELECT t.minute_ts AS minuteMs,
             SUM(CASE
               WHEN t.keycode = 42 THEN t.count
               WHEN (t.keycode & 255) = 42
                 AND ((t.keycode & 57344) = 16384 OR (t.keycode & 57344) = 8192)
               THEN t.tap_count
               ELSE 0
             END) AS backspaceCount
        FROM typing_matrix_minute t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
       GROUP BY t.minute_ts
       HAVING backspaceCount > 0
       ORDER BY t.minute_ts ASC
    `)

    this.selectBksMinuteInRangeForUidAndHashStmt = this.db.prepare(`
      SELECT t.minute_ts AS minuteMs,
             SUM(CASE
               WHEN t.keycode = 42 THEN t.count
               WHEN (t.keycode & 255) = 42
                 AND ((t.keycode & 57344) = 16384 OR (t.keycode & 57344) = 8192)
               THEN t.tap_count
               ELSE 0
             END) AS backspaceCount
        FROM typing_matrix_minute t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
       GROUP BY t.minute_ts
       HAVING backspaceCount > 0
       ORDER BY t.minute_ts ASC
    `)

    // Peak records: four narrow aggregates that feed the summary cards
    // at the top of Analyze. Each statement returns at most one row.
    // The WPM formula is `keystrokes * 12000 / active_ms` (five chars
    // per word, sixty thousand ms per minute); active_ms == 0 rows are
    // filtered out so the division is always safe.
    this.selectPeakWpmInRangeForUidStmt = this.db.prepare(`
      SELECT (total.keystrokes * 12000.0 / total.active_ms) AS value,
             total.minute_ts AS atMs
        FROM (
          SELECT t.minute_ts,
                 SUM(t.keystrokes) AS keystrokes,
                 SUM(t.active_ms) AS active_ms
            FROM typing_minute_stats t
            JOIN typing_scopes s ON s.id = t.scope_id
           WHERE s.keyboard_uid = @uid
             AND s.is_deleted = 0
             AND t.is_deleted = 0
             AND t.minute_ts >= @sinceMs
             AND t.minute_ts < @untilMs
           GROUP BY t.minute_ts
        ) AS total
       WHERE total.active_ms > 0
       ORDER BY value DESC
       LIMIT 1
    `)

    this.selectPeakWpmInRangeForUidAndHashStmt = this.db.prepare(`
      SELECT (total.keystrokes * 12000.0 / total.active_ms) AS value,
             total.minute_ts AS atMs
        FROM (
          SELECT t.minute_ts,
                 SUM(t.keystrokes) AS keystrokes,
                 SUM(t.active_ms) AS active_ms
            FROM typing_minute_stats t
            JOIN typing_scopes s ON s.id = t.scope_id
           WHERE s.keyboard_uid = @uid
             AND s.machine_hash = @machineHash
             AND s.is_deleted = 0
             AND t.is_deleted = 0
             AND t.minute_ts >= @sinceMs
             AND t.minute_ts < @untilMs
           GROUP BY t.minute_ts
        ) AS total
       WHERE total.active_ms > 0
       ORDER BY value DESC
       LIMIT 1
    `)

    this.selectPeakKpmInRangeForUidStmt = this.db.prepare(`
      SELECT SUM(t.keystrokes) AS value, t.minute_ts AS atMs
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
       GROUP BY t.minute_ts
       HAVING value > 0
       ORDER BY value DESC
       LIMIT 1
    `)

    this.selectPeakKpmInRangeForUidAndHashStmt = this.db.prepare(`
      SELECT SUM(t.keystrokes) AS value, t.minute_ts AS atMs
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
       GROUP BY t.minute_ts
       HAVING value > 0
       ORDER BY value DESC
       LIMIT 1
    `)

    this.selectPeakKpdInRangeForUidStmt = this.db.prepare(`
      SELECT strftime('%Y-%m-%d', t.minute_ts / 1000, 'unixepoch', 'localtime') AS day,
             SUM(t.keystrokes) AS value
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
       GROUP BY day
       HAVING value > 0
       ORDER BY value DESC
       LIMIT 1
    `)

    this.selectPeakKpdInRangeForUidAndHashStmt = this.db.prepare(`
      SELECT strftime('%Y-%m-%d', t.minute_ts / 1000, 'unixepoch', 'localtime') AS day,
             SUM(t.keystrokes) AS value
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
       GROUP BY day
       HAVING value > 0
       ORDER BY value DESC
       LIMIT 1
    `)

    this.selectLongestSessionInRangeForUidStmt = this.db.prepare(`
      SELECT (t.end_ms - t.start_ms) AS durationMs,
             t.start_ms AS startedAtMs
        FROM typing_sessions t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.start_ms >= @sinceMs
         AND t.start_ms < @untilMs
       ORDER BY durationMs DESC
       LIMIT 1
    `)

    this.selectLongestSessionInRangeForUidAndHashStmt = this.db.prepare(`
      SELECT (t.end_ms - t.start_ms) AS durationMs,
             t.start_ms AS startedAtMs
        FROM typing_sessions t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.start_ms >= @sinceMs
         AND t.start_ms < @untilMs
       ORDER BY durationMs DESC
       LIMIT 1
    `)

    // Remote devices (machine_hash != @ownHash) that currently hold at
    // least one live minute-stats row for this keyboard. Powers the
    // Sync > Typing > Device tree: each returned hash gets its own
    // subnode. Sorted for deterministic UI ordering.
    this.selectRemoteHashesForUidStmt = this.db.prepare(`
      SELECT DISTINCT s.machine_hash AS machineHash
        FROM typing_scopes s
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash != @ownHash
         AND s.is_deleted = 0
         AND EXISTS (
           SELECT 1 FROM typing_minute_stats t
            WHERE t.scope_id = s.id AND t.is_deleted = 0
         )
       ORDER BY s.machine_hash
    `)

    // Row-listing queries scoped to a single scope_id — used by the
    // delete APIs to build tombstone JSONL rows for our own machine's
    // scope only. The range window is half-open `[startMs, endMs)` for
    // minute rows and overlap (`end_ms > startMs AND start_ms < endMs`)
    // for sessions that can span day boundaries.
    this.selectOwnScopeIdsForUidStmt = this.db.prepare(`
      SELECT id FROM typing_scopes
       WHERE machine_hash = @machineHash
         AND keyboard_uid = @uid
         AND is_deleted = 0
    `)

    this.selectLiveCharMinutesForScopeStmt = this.db.prepare(`
      SELECT scope_id AS scopeId, minute_ts AS minuteTs, char, count
        FROM typing_char_minute
       WHERE scope_id = @scopeId
         AND minute_ts >= @startMs
         AND minute_ts < @endMs
         AND is_deleted = 0
    `)

    this.selectLiveMatrixMinutesForScopeStmt = this.db.prepare(`
      SELECT scope_id AS scopeId, minute_ts AS minuteTs,
             row, col, layer, keycode, count,
             tap_count AS tapCount, hold_count AS holdCount
        FROM typing_matrix_minute
       WHERE scope_id = @scopeId
         AND minute_ts >= @startMs
         AND minute_ts < @endMs
         AND is_deleted = 0
    `)

    this.selectLiveMinuteStatsForScopeStmt = this.db.prepare(`
      SELECT scope_id AS scopeId, minute_ts AS minuteTs,
             keystrokes, active_ms AS activeMs,
             interval_avg_ms AS intervalAvgMs,
             interval_min_ms AS intervalMinMs,
             interval_p25_ms AS intervalP25Ms,
             interval_p50_ms AS intervalP50Ms,
             interval_p75_ms AS intervalP75Ms,
             interval_max_ms AS intervalMaxMs
        FROM typing_minute_stats
       WHERE scope_id = @scopeId
         AND minute_ts >= @startMs
         AND minute_ts < @endMs
         AND is_deleted = 0
    `)

    this.selectLiveSessionsForScopeStmt = this.db.prepare(`
      SELECT id, scope_id AS scopeId, start_ms AS startMs, end_ms AS endMs
        FROM typing_sessions
       WHERE scope_id = @scopeId
         AND end_ms > @startMs
         AND start_ms < @endMs
         AND is_deleted = 0
    `)

    // Tombstone range deletes. Only flips live rows (is_deleted = 0) so
    // existing tombstones keep their original updated_at for GC purposes.
    const tombstoneRangeWhere = `
      scope_id IN (SELECT id FROM typing_scopes WHERE keyboard_uid = @uid)
        AND is_deleted = 0
    `
    this.tombstoneCharMinutesInRangeStmt = this.db.prepare(`
      UPDATE typing_char_minute
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${tombstoneRangeWhere}
         AND minute_ts >= @startMs AND minute_ts < @endMs
    `)
    this.tombstoneMatrixMinutesInRangeStmt = this.db.prepare(`
      UPDATE typing_matrix_minute
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${tombstoneRangeWhere}
         AND minute_ts >= @startMs AND minute_ts < @endMs
    `)
    this.tombstoneMinuteStatsInRangeStmt = this.db.prepare(`
      UPDATE typing_minute_stats
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${tombstoneRangeWhere}
         AND minute_ts >= @startMs AND minute_ts < @endMs
    `)
    // Sessions use overlap semantics instead of start_ms-containment so a
    // session that spans midnight (start before the window, end inside)
    // still gets tombstoned when the user deletes that day. Matches the
    // per-minute rows that contribute to the same day bucket.
    this.tombstoneSessionsInRangeStmt = this.db.prepare(`
      UPDATE typing_sessions
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${tombstoneRangeWhere}
         AND end_ms > @startMs AND start_ms < @endMs
    `)

    // Hash-scoped range variants — Sync-delete of another device's day
    // removes only that device's rows while keeping same-day contributions
    // from other hashes intact.
    const tombstoneHashRangeWhere = `
      scope_id IN (
        SELECT id FROM typing_scopes
         WHERE keyboard_uid = @uid AND machine_hash = @machineHash
      )
        AND is_deleted = 0
    `
    this.tombstoneCharMinutesForHashInRangeStmt = this.db.prepare(`
      UPDATE typing_char_minute
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${tombstoneHashRangeWhere}
         AND minute_ts >= @startMs AND minute_ts < @endMs
    `)
    this.tombstoneMatrixMinutesForHashInRangeStmt = this.db.prepare(`
      UPDATE typing_matrix_minute
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${tombstoneHashRangeWhere}
         AND minute_ts >= @startMs AND minute_ts < @endMs
    `)
    this.tombstoneMinuteStatsForHashInRangeStmt = this.db.prepare(`
      UPDATE typing_minute_stats
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${tombstoneHashRangeWhere}
         AND minute_ts >= @startMs AND minute_ts < @endMs
    `)
    this.tombstoneSessionsForHashInRangeStmt = this.db.prepare(`
      UPDATE typing_sessions
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${tombstoneHashRangeWhere}
         AND end_ms > @startMs AND start_ms < @endMs
    `)

    this.tombstoneAllCharMinutesStmt = this.db.prepare(`
      UPDATE typing_char_minute
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${tombstoneRangeWhere}
    `)
    this.tombstoneAllMatrixMinutesStmt = this.db.prepare(`
      UPDATE typing_matrix_minute
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${tombstoneRangeWhere}
    `)
    this.tombstoneAllMinuteStatsStmt = this.db.prepare(`
      UPDATE typing_minute_stats
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${tombstoneRangeWhere}
    `)
    this.tombstoneAllSessionsStmt = this.db.prepare(`
      UPDATE typing_sessions
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${tombstoneRangeWhere}
    `)
  }

  upsertScope(row: TypingScopeRow): void {
    this.upsertScopeStmt.run({
      id: row.id,
      machineHash: row.machineHash,
      osPlatform: row.osPlatform,
      osRelease: row.osRelease,
      osArch: row.osArch,
      keyboardUid: row.keyboardUid,
      keyboardVendorId: row.keyboardVendorId,
      keyboardProductId: row.keyboardProductId,
      keyboardProductName: row.keyboardProductName,
      updatedAt: row.updatedAt,
    })
  }

  writeMinute(
    stats: MinuteStatsRow,
    charCounts: CharMinuteRow[],
    matrixCounts: MatrixMinuteRow[],
    updatedAt: number,
  ): void {
    const upsertTx = this.db.transaction(() => {
      this.upsertMinuteStatsStmt.run({
        scopeId: stats.scopeId,
        minuteTs: stats.minuteTs,
        keystrokes: stats.keystrokes,
        activeMs: stats.activeMs,
        intervalAvgMs: stats.intervalAvgMs,
        intervalMinMs: stats.intervalMinMs,
        intervalP25Ms: stats.intervalP25Ms,
        intervalP50Ms: stats.intervalP50Ms,
        intervalP75Ms: stats.intervalP75Ms,
        intervalMaxMs: stats.intervalMaxMs,
        updatedAt,
      })
      for (const c of charCounts) {
        this.upsertCharMinuteStmt.run({
          scopeId: c.scopeId,
          minuteTs: c.minuteTs,
          char: c.char,
          count: c.count,
          updatedAt,
        })
      }
      for (const m of matrixCounts) {
        this.upsertMatrixMinuteStmt.run({
          scopeId: m.scopeId,
          minuteTs: m.minuteTs,
          row: m.row,
          col: m.col,
          layer: m.layer,
          keycode: m.keycode,
          count: m.count,
          tapCount: m.tapCount ?? 0,
          holdCount: m.holdCount ?? 0,
          updatedAt,
        })
      }
    })
    upsertTx()
  }

  insertSession(row: SessionRow, updatedAt: number): void {
    this.insertSessionStmt.run({
      id: row.id,
      scopeId: row.scopeId,
      startMs: row.startMs,
      endMs: row.endMs,
      updatedAt,
    })
  }

  /** Remove data for the local machine older than the cutoff timestamp. */
  retainOwnData(machineHash: string, cutoffMs: number): void {
    const tx = this.db.transaction(() => {
      this.deleteCharMinuteBeforeStmt.run({ machineHash, cutoffMs })
      this.deleteMatrixMinuteBeforeStmt.run({ machineHash, cutoffMs })
      this.deleteMinuteStatsBeforeStmt.run({ machineHash, cutoffMs })
      this.deleteSessionsBeforeStmt.run({ machineHash, cutoffMs })
    })
    tx()
  }

  /** Distinct keyboard uids present in typing_scopes for this machine.
   * Used by the sync layer to decide which analytics sync units exist. */
  listLocalKeyboardUids(machineHash: string): string[] {
    const rows = this.selectLocalKeyboardUidsStmt.all({ machineHash }) as Array<{ keyboardUid: string }>
    return rows.map((r) => r.keyboardUid)
  }

  /** Scope ids belonging to the local machine for a single keyboard uid.
   * Used by the delete APIs to scope tombstone emission to rows this
   * device actually owns (1-writer per JSONL file). */
  listOwnScopeIdsForUid(machineHash: string, uid: string): string[] {
    const rows = this.selectOwnScopeIdsForUidStmt.all({ machineHash, uid }) as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  /** Live char-minute rows for a single scope within `[startMs, endMs)`. */
  listLiveCharMinutesForScope(scopeId: string, startMs: number, endMs: number): CharMinuteRow[] {
    return this.selectLiveCharMinutesForScopeStmt.all({ scopeId, startMs, endMs }) as CharMinuteRow[]
  }

  /** Live matrix-minute rows for a single scope within `[startMs, endMs)`. */
  listLiveMatrixMinutesForScope(scopeId: string, startMs: number, endMs: number): MatrixMinuteRow[] {
    return this.selectLiveMatrixMinutesForScopeStmt.all({ scopeId, startMs, endMs }) as MatrixMinuteRow[]
  }

  /** Live minute-stats rows for a single scope within `[startMs, endMs)`. */
  listLiveMinuteStatsForScope(scopeId: string, startMs: number, endMs: number): MinuteStatsRow[] {
    return this.selectLiveMinuteStatsForScopeStmt.all({ scopeId, startMs, endMs }) as MinuteStatsRow[]
  }

  /** Live sessions overlapping `[startMs, endMs)` for a single scope.
   * Overlap semantics mirror the existing tombstone path: a session that
   * starts before the window but ends inside still qualifies. */
  listLiveSessionsForScope(scopeId: string, startMs: number, endMs: number): SessionRow[] {
    return this.selectLiveSessionsForScopeStmt.all({ scopeId, startMs, endMs }) as SessionRow[]
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
    const rows = this.selectMatrixHeatmapStmt.all({ uid, machineHash, layer, sinceMinuteMs }) as Array<{
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
  ): Map<string, { total: number; tap: number; hold: number }> {
    const stmt = machineHash !== undefined
      ? this.selectMatrixHeatmapInRangeForHashStmt
      : this.selectMatrixHeatmapInRangeStmt
    const params = machineHash !== undefined
      ? { uid, machineHash, layer, sinceMs, untilMs }
      : { uid, layer, sinceMs, untilMs }
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
    return this.selectKeyboardsWithTypingDataStmt.all() as TypingKeyboardSummary[]
  }

  /** Daily summaries for a keyboard uid, grouped by local calendar day
   * and ordered newest first. Live rows only. */
  listDailySummariesForUid(uid: string): TypingDailySummary[] {
    return this.selectDailySummariesForUidStmt.all({ uid }) as TypingDailySummary[]
  }

  /** Daily summaries for a keyboard uid restricted to a single
   * machine_hash. Same shape as {@link listDailySummariesForUid} but
   * drops any rows that aren't attributable to the requested hash so
   * the Local tab can show only this device's days and the Sync tab
   * can show one remote device at a time. */
  listDailySummariesForUidAndHash(
    uid: string,
    machineHash: string,
  ): TypingDailySummary[] {
    return this.selectDailySummariesForUidAndHashStmt.all({ uid, machineHash }) as TypingDailySummary[]
  }

  /** Daily interval summaries (min/p25/p50/p75/max) for a keyboard uid,
   * grouped by local calendar day and ordered newest first. Minutes
   * with no interval data (single-keystroke minutes) are excluded. */
  listIntervalSummariesForUid(uid: string): TypingIntervalDailySummary[] {
    return this.selectIntervalSummariesForUidStmt.all({ uid }) as TypingIntervalDailySummary[]
  }

  /** Same as {@link listIntervalSummariesForUid} but restricted to one
   * machine_hash so the Analyze view can show only the active device's
   * rhythm without any remote contribution. */
  listIntervalSummariesForUidAndHash(
    uid: string,
    machineHash: string,
  ): TypingIntervalDailySummary[] {
    return this.selectIntervalSummariesForUidAndHashStmt.all({ uid, machineHash }) as TypingIntervalDailySummary[]
  }

  /** Hour-of-day × day-of-week activity grid for a keyboard uid in
   * `[sinceMs, untilMs)`. Pass `Number.MAX_SAFE_INTEGER` for untilMs to
   * include "now and onwards". Buckets with zero keystrokes are
   * omitted from the result — callers zero-fill when rendering. */
  listActivityGridForUid(uid: string, sinceMs: number, untilMs: number): TypingActivityCell[] {
    return this.selectActivityGridForUidStmt.all({ uid, sinceMs, untilMs }) as TypingActivityCell[]
  }

  /** Same as {@link listActivityGridForUid} but restricted to a single
   * machine_hash so the Analyze "This device" scope can exclude the
   * contribution of other devices. */
  listActivityGridForUidAndHash(
    uid: string,
    machineHash: string,
    sinceMs: number,
    untilMs: number,
  ): TypingActivityCell[] {
    return this.selectActivityGridForUidAndHashStmt.all({ uid, machineHash, sinceMs, untilMs }) as TypingActivityCell[]
  }

  /** Minute-raw stats for the Analyze WPM / Interval charts over the
   * `[sinceMs, untilMs)` window. Callers bucket these on the renderer
   * side so the SQL layer is independent of the user-picked bucket
   * width. Rows ordered by minute_ts ASC. */
  listMinuteStatsInRangeForUid(uid: string, sinceMs: number, untilMs: number): TypingMinuteStatsRow[] {
    return this.selectMinuteStatsInRangeForUidStmt.all({ uid, sinceMs, untilMs }) as TypingMinuteStatsRow[]
  }

  /** Same as {@link listMinuteStatsInRangeForUid} but restricted to a
   * single machine_hash for the Analyze "This device" scope. */
  listMinuteStatsInRangeForUidAndHash(
    uid: string,
    machineHash: string,
    sinceMs: number,
    untilMs: number,
  ): TypingMinuteStatsRow[] {
    return this.selectMinuteStatsInRangeForUidAndHashStmt.all({ uid, machineHash, sinceMs, untilMs }) as TypingMinuteStatsRow[]
  }

  /** Live sessions that intersect `[sinceMs, untilMs)` for a keyboard
   * uid. Powers the Analyze session-distribution histogram. */
  listSessionsInRangeForUid(uid: string, sinceMs: number, untilMs: number): TypingSessionRow[] {
    return this.selectSessionsInRangeForUidStmt.all({ uid, sinceMs, untilMs }) as TypingSessionRow[]
  }

  /** Same as {@link listSessionsInRangeForUid} but restricted to a
   * single machine_hash for the Analyze "This device" scope. */
  listSessionsInRangeForUidAndHash(
    uid: string,
    machineHash: string,
    sinceMs: number,
    untilMs: number,
  ): TypingSessionRow[] {
    return this.selectSessionsInRangeForUidAndHashStmt.all({ uid, machineHash, sinceMs, untilMs }) as TypingSessionRow[]
  }

  /** Per-minute Backspace-share aggregate for `[sinceMs, untilMs)`.
   * Only minutes that received typing-test input contribute; general
   * matrix-path typing does not feed `typing_char_minute`. */
  listBksMinuteInRangeForUid(uid: string, sinceMs: number, untilMs: number): TypingBksMinuteRow[] {
    return this.selectBksMinuteInRangeForUidStmt.all({ uid, sinceMs, untilMs }) as TypingBksMinuteRow[]
  }

  /** Same as {@link listBksMinuteInRangeForUid} but restricted to a
   * single machine_hash for the Analyze "This device" scope. */
  listBksMinuteInRangeForUidAndHash(
    uid: string,
    machineHash: string,
    sinceMs: number,
    untilMs: number,
  ): TypingBksMinuteRow[] {
    return this.selectBksMinuteInRangeForUidAndHashStmt.all({ uid, machineHash, sinceMs, untilMs }) as TypingBksMinuteRow[]
  }

  /** Peak records for the Analyze summary cards across every scope of
   * this keyboard in the range. Any metric with no qualifying rows
   * comes back as null so the UI can render an empty placeholder. */
  getPeakRecordsInRangeForUid(uid: string, sinceMs: number, untilMs: number): PeakRecords {
    const params = { uid, sinceMs, untilMs }
    const wpm = this.selectPeakWpmInRangeForUidStmt.get(params) as { value: number; atMs: number } | undefined
    const kpm = this.selectPeakKpmInRangeForUidStmt.get(params) as { value: number; atMs: number } | undefined
    const kpd = this.selectPeakKpdInRangeForUidStmt.get(params) as { day: string; value: number } | undefined
    const sess = this.selectLongestSessionInRangeForUidStmt.get(params) as { durationMs: number; startedAtMs: number } | undefined
    return {
      peakWpm: wpm ? { value: wpm.value, atMs: wpm.atMs } : null,
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
  ): PeakRecords {
    const params = { uid, machineHash, sinceMs, untilMs }
    const wpm = this.selectPeakWpmInRangeForUidAndHashStmt.get(params) as { value: number; atMs: number } | undefined
    const kpm = this.selectPeakKpmInRangeForUidAndHashStmt.get(params) as { value: number; atMs: number } | undefined
    const kpd = this.selectPeakKpdInRangeForUidAndHashStmt.get(params) as { day: string; value: number } | undefined
    const sess = this.selectLongestSessionInRangeForUidAndHashStmt.get(params) as { durationMs: number; startedAtMs: number } | undefined
    return {
      peakWpm: wpm ? { value: wpm.value, atMs: wpm.atMs } : null,
      peakKeystrokesPerMin: kpm ? { value: kpm.value, atMs: kpm.atMs } : null,
      peakKeystrokesPerDay: kpd ? { value: kpd.value, day: kpd.day } : null,
      longestSession: sess ? { durationMs: sess.durationMs, startedAtMs: sess.startedAtMs } : null,
    }
  }

  /** machine_hash values for remote devices (non-@ownHash) that hold
   * at least one live minute-stats row for this keyboard. Used by the
   * Sync > Typing tree to decide how many device subnodes to render. */
  listRemoteHashesForUid(uid: string, ownHash: string): string[] {
    const rows = this.selectRemoteHashesForUidStmt.all({ uid, ownHash }) as Array<{ machineHash: string }>
    return rows.map((r) => r.machineHash)
  }

  /** Tombstone every live row for a uid whose timestamp falls inside
   * [startMs, endMs). Bumps updated_at on the touched rows so LWW
   * merge on other devices picks up the deletion. Returns per-table
   * change counts for UX / logging. */
  /** Same as {@link tombstoneRowsForUidInRange} but restricted to a
   * single machine_hash. Used by the Sync-delete UX to retract a
   * specific remote device's contribution without touching rows
   * another device recorded on the same date. */
  tombstoneRowsForUidHashInRange(
    uid: string,
    machineHash: string,
    startMs: number,
    endMs: number,
    updatedAt: number,
  ): TypingTombstoneResult {
    const result: TypingTombstoneResult = { charMinutes: 0, matrixMinutes: 0, minuteStats: 0, sessions: 0 }
    const tx = this.db.transaction(() => {
      result.charMinutes = this.tombstoneCharMinutesForHashInRangeStmt.run({ uid, machineHash, startMs, endMs, updatedAt }).changes
      result.matrixMinutes = this.tombstoneMatrixMinutesForHashInRangeStmt.run({ uid, machineHash, startMs, endMs, updatedAt }).changes
      result.minuteStats = this.tombstoneMinuteStatsForHashInRangeStmt.run({ uid, machineHash, startMs, endMs, updatedAt }).changes
      result.sessions = this.tombstoneSessionsForHashInRangeStmt.run({ uid, machineHash, startMs, endMs, updatedAt }).changes
    })
    tx()
    return result
  }

  tombstoneRowsForUidInRange(
    uid: string,
    startMs: number,
    endMs: number,
    updatedAt: number,
  ): TypingTombstoneResult {
    const result: TypingTombstoneResult = { charMinutes: 0, matrixMinutes: 0, minuteStats: 0, sessions: 0 }
    const tx = this.db.transaction(() => {
      result.charMinutes = this.tombstoneCharMinutesInRangeStmt.run({ uid, startMs, endMs, updatedAt }).changes
      result.matrixMinutes = this.tombstoneMatrixMinutesInRangeStmt.run({ uid, startMs, endMs, updatedAt }).changes
      result.minuteStats = this.tombstoneMinuteStatsInRangeStmt.run({ uid, startMs, endMs, updatedAt }).changes
      result.sessions = this.tombstoneSessionsInRangeStmt.run({ uid, startMs, endMs, updatedAt }).changes
    })
    tx()
    return result
  }

  /** Tombstone every live row for a uid across all time. Scope rows
   * themselves are left intact so the next recording session reuses
   * them without a fresh fingerprint build. */
  tombstoneAllRowsForUid(uid: string, updatedAt: number): TypingTombstoneResult {
    const result: TypingTombstoneResult = { charMinutes: 0, matrixMinutes: 0, minuteStats: 0, sessions: 0 }
    const tx = this.db.transaction(() => {
      result.charMinutes = this.tombstoneAllCharMinutesStmt.run({ uid, updatedAt }).changes
      result.matrixMinutes = this.tombstoneAllMatrixMinutesStmt.run({ uid, updatedAt }).changes
      result.minuteStats = this.tombstoneAllMinuteStatsStmt.run({ uid, updatedAt }).changes
      result.sessions = this.tombstoneAllSessionsStmt.run({ uid, updatedAt }).changes
    })
    tx()
    return result
  }

  // --- Sync export ----------------------------------------------------

  exportScopesForUid(uid: string, tombstoneSinceMs: number): TypingScopeRow[] {
    const rows = this.selectScopesForUidStmt.all({ uid, tombstoneSinceMs }) as Array<
      TypingScopeRow & { isDeleted: number }
    >
    return rows.map((r) => ({ ...r, isDeleted: r.isDeleted === 1 }))
  }

  exportCharMinutesForUid(
    uid: string,
    liveSinceMinuteMs: number,
    tombstoneSinceMs: number,
  ): CharMinuteExportRow[] {
    const rows = this.selectCharMinutesForUidStmt.all({ uid, liveSinceMinuteMs, tombstoneSinceMs }) as Array<
      CharMinuteExportRow & { isDeleted: number }
    >
    return rows.map((r) => ({ ...r, isDeleted: r.isDeleted === 1 }))
  }

  exportMatrixMinutesForUid(
    uid: string,
    liveSinceMinuteMs: number,
    tombstoneSinceMs: number,
  ): MatrixMinuteExportRow[] {
    const rows = this.selectMatrixMinutesForUidStmt.all({ uid, liveSinceMinuteMs, tombstoneSinceMs }) as Array<
      MatrixMinuteExportRow & { isDeleted: number }
    >
    return rows.map((r) => ({ ...r, isDeleted: r.isDeleted === 1 }))
  }

  exportMinuteStatsForUid(
    uid: string,
    liveSinceMinuteMs: number,
    tombstoneSinceMs: number,
  ): MinuteStatsExportRow[] {
    const rows = this.selectMinuteStatsForUidStmt.all({ uid, liveSinceMinuteMs, tombstoneSinceMs }) as Array<
      MinuteStatsExportRow & { isDeleted: number }
    >
    return rows.map((r) => ({ ...r, isDeleted: r.isDeleted === 1 }))
  }

  exportSessionsForUid(
    uid: string,
    liveSinceStartMs: number,
    tombstoneSinceMs: number,
  ): SessionExportRow[] {
    const rows = this.selectSessionsForUidStmt.all({ uid, liveSinceStartMs, tombstoneSinceMs }) as Array<
      SessionExportRow & { isDeleted: number }
    >
    return rows.map((r) => ({ ...r, isDeleted: r.isDeleted === 1 }))
  }

  // --- Sync merge (authoritative LWW) ---------------------------------

  mergeScope(row: TypingScopeRow): void {
    this.mergeScopeStmt.run({
      id: row.id,
      machineHash: row.machineHash,
      osPlatform: row.osPlatform,
      osRelease: row.osRelease,
      osArch: row.osArch,
      keyboardUid: row.keyboardUid,
      keyboardVendorId: row.keyboardVendorId,
      keyboardProductId: row.keyboardProductId,
      keyboardProductName: row.keyboardProductName,
      updatedAt: row.updatedAt,
      isDeleted: row.isDeleted ? 1 : 0,
    })
  }

  mergeCharMinute(row: CharMinuteExportRow): void {
    this.mergeCharMinuteStmt.run({
      scopeId: row.scopeId,
      minuteTs: row.minuteTs,
      char: row.char,
      count: row.count,
      updatedAt: row.updatedAt,
      isDeleted: row.isDeleted ? 1 : 0,
    })
  }

  mergeMatrixMinute(row: MatrixMinuteExportRow): void {
    this.mergeMatrixMinuteStmt.run({
      scopeId: row.scopeId,
      minuteTs: row.minuteTs,
      row: row.row,
      col: row.col,
      layer: row.layer,
      keycode: row.keycode,
      count: row.count,
      tapCount: row.tapCount ?? 0,
      holdCount: row.holdCount ?? 0,
      updatedAt: row.updatedAt,
      isDeleted: row.isDeleted ? 1 : 0,
    })
  }

  mergeMinuteStats(row: MinuteStatsExportRow): void {
    this.mergeMinuteStatsStmt.run({
      scopeId: row.scopeId,
      minuteTs: row.minuteTs,
      keystrokes: row.keystrokes,
      activeMs: row.activeMs,
      intervalAvgMs: row.intervalAvgMs,
      intervalMinMs: row.intervalMinMs,
      intervalP25Ms: row.intervalP25Ms,
      intervalP50Ms: row.intervalP50Ms,
      intervalP75Ms: row.intervalP75Ms,
      intervalMaxMs: row.intervalMaxMs,
      updatedAt: row.updatedAt,
      isDeleted: row.isDeleted ? 1 : 0,
    })
  }

  mergeSession(row: SessionExportRow): void {
    this.mergeSessionStmt.run({
      id: row.id,
      scopeId: row.scopeId,
      startMs: row.startMs,
      endMs: row.endMs,
      updatedAt: row.updatedAt,
      isDeleted: row.isDeleted ? 1 : 0,
    })
  }

  /** Apply additive migrations for older databases. Only forward
   * migrations are supported; downgrading keeps today's "mismatch is
   * fatal" posture because the reverse direction can't be made safe. */
  private migrateSchema(fromVersion: number): void {
    if (fromVersion > SCHEMA_VERSION) {
      throw new Error(
        `typing-analytics DB schema version ${fromVersion} is newer than this build's ${SCHEMA_VERSION}`,
      )
    }
    // v1 -> v2: Add tap_count / hold_count columns to the matrix
    // rollups so LT/MT release-edge classification has somewhere to
    // accumulate. Existing rows default to 0, meaning "unclassified" —
    // the heatmap falls back to the total `count` when both are zero.
    if (fromVersion < 2) {
      this.db.exec(`
        ALTER TABLE typing_matrix_minute
          ADD COLUMN tap_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE typing_matrix_minute
          ADD COLUMN hold_count INTEGER NOT NULL DEFAULT 0;
      `)
    }
  }

  getMeta(key: string): string | null {
    const row = this.getMetaStmt.get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.setMetaStmt.run({ key, value })
  }

  /** Low-level escape hatch for queries the service hasn't wrapped yet. */
  getConnection(): DatabaseType {
    return this.db
  }

  close(): void {
    this.db.close()
  }
}

let instance: TypingAnalyticsDB | null = null

export function defaultDbPath(): string {
  return join(app.getPath('userData'), 'local', 'typing-analytics.db')
}

export function getTypingAnalyticsDB(): TypingAnalyticsDB {
  if (!instance) instance = new TypingAnalyticsDB(defaultDbPath())
  return instance
}

export function resetTypingAnalyticsDBForTests(): void {
  if (instance) {
    instance.close()
    instance = null
  }
}

export function setTypingAnalyticsDBForTests(db: TypingAnalyticsDB): void {
  instance = db
}
