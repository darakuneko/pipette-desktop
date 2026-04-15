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
      throw new Error(
        `typing-analytics DB schema mismatch: stored=${stored}, expected=${SCHEMA_VERSION}`,
      )
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
        scope_id, minute_ts, row, col, layer, keycode, count, updated_at, is_deleted
      )
      VALUES (
        @scopeId, @minuteTs, @row, @col, @layer, @keycode, @count, @updatedAt, 0
      )
      ON CONFLICT(scope_id, minute_ts, row, col, layer) DO UPDATE SET
        count = typing_matrix_minute.count + excluded.count,
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
        scope_id, minute_ts, row, col, layer, keycode, count, updated_at, is_deleted
      )
      VALUES (
        @scopeId, @minuteTs, @row, @col, @layer, @keycode, @count, @updatedAt, @isDeleted
      )
      ON CONFLICT(scope_id, minute_ts, row, col, layer) DO UPDATE SET
        keycode = excluded.keycode,
        count = excluded.count,
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
