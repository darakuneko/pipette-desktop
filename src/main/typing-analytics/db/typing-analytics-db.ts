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

export class TypingAnalyticsDB {
  private readonly db: DatabaseType
  private readonly upsertScopeStmt: Statement
  private readonly upsertCharMinuteStmt: Statement
  private readonly upsertMatrixMinuteStmt: Statement
  private readonly upsertMinuteStatsStmt: Statement
  private readonly insertSessionStmt: Statement
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
