// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { TypingAnalyticsDB, type TypingScopeRow } from '../typing-analytics-db'
import { SCHEMA_VERSION } from '../schema'

const MACHINE_HASH = 'hash-abc'

function sampleScope(overrides: Partial<TypingScopeRow> = {}): TypingScopeRow {
  return {
    id: 'scope-1',
    machineHash: MACHINE_HASH,
    osPlatform: 'linux',
    osRelease: '6.8.0',
    osArch: 'x64',
    keyboardUid: '0xAABB',
    keyboardVendorId: 0xFEED,
    keyboardProductId: 0x0000,
    keyboardProductName: 'Pipette',
    updatedAt: 1_000,
    ...overrides,
  }
}

describe('TypingAnalyticsDB', () => {
  let tmpDir: string
  let db: TypingAnalyticsDB

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipette-typing-analytics-db-'))
    db = new TypingAnalyticsDB(join(tmpDir, 'typing-analytics.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('stores the schema version on first open', () => {
    expect(db.getMeta('schema_version')).toBe(String(SCHEMA_VERSION))
  })

  it('upgrades a v3 DB without app_name to the current schema', () => {
    // Reproducer for the runtime crash where re-opening an existing DB
    // hit `no such column: app_name` because CREATE INDEX in
    // CREATE_SCHEMA_SQL referenced a column that ALTER TABLE only
    // added later in the migrate step. Two-phase init now runs the
    // migration before any column-aware indices are created.
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = mkdtempSync(join(tmpdir(), 'pipette-typing-analytics-db-upgrade-'))
    const dbPath = join(tmpDir, 'typing-analytics.db')

    const v3 = new Database(dbPath)
    v3.exec(`
      CREATE TABLE typing_analytics_meta (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
      CREATE TABLE typing_scopes (
        id TEXT PRIMARY KEY,
        machine_hash TEXT NOT NULL, os_platform TEXT NOT NULL,
        os_release TEXT NOT NULL, os_arch TEXT NOT NULL,
        keyboard_uid TEXT NOT NULL,
        keyboard_vendor_id INTEGER NOT NULL,
        keyboard_product_id INTEGER NOT NULL,
        keyboard_product_name TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE typing_char_minute (
        scope_id TEXT NOT NULL, minute_ts INTEGER NOT NULL,
        char TEXT NOT NULL, count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope_id, minute_ts, char)
      );
      CREATE TABLE typing_matrix_minute (
        scope_id TEXT NOT NULL, minute_ts INTEGER NOT NULL,
        row INTEGER NOT NULL, col INTEGER NOT NULL,
        layer INTEGER NOT NULL, keycode INTEGER NOT NULL,
        count INTEGER NOT NULL,
        tap_count INTEGER NOT NULL DEFAULT 0,
        hold_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope_id, minute_ts, row, col, layer)
      );
      CREATE TABLE typing_minute_stats (
        scope_id TEXT NOT NULL, minute_ts INTEGER NOT NULL,
        keystrokes INTEGER NOT NULL, active_ms INTEGER NOT NULL,
        interval_avg_ms INTEGER, interval_min_ms INTEGER,
        interval_p25_ms INTEGER, interval_p50_ms INTEGER,
        interval_p75_ms INTEGER, interval_max_ms INTEGER,
        updated_at INTEGER NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope_id, minute_ts)
      );
      CREATE TABLE typing_bigram_minute (
        scope_id TEXT NOT NULL, minute_ts INTEGER NOT NULL,
        bigram_id TEXT NOT NULL, count INTEGER NOT NULL,
        hist BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope_id, minute_ts, bigram_id)
      );
      CREATE TABLE typing_sessions (
        id TEXT PRIMARY KEY, scope_id TEXT NOT NULL,
        start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO typing_analytics_meta (key, value) VALUES ('schema_version', '3');
    `)
    v3.close()

    // Re-open with the current TypingAnalyticsDB — must not throw and
    // must end up at SCHEMA_VERSION with the new app_name column on
    // every minute table.
    db = new TypingAnalyticsDB(dbPath)
    expect(db.getMeta('schema_version')).toBe(String(SCHEMA_VERSION))
    const conn = db.getConnection()
    for (const table of [
      'typing_char_minute',
      'typing_matrix_minute',
      'typing_minute_stats',
      'typing_bigram_minute',
    ]) {
      const cols = conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      expect(cols.some((c) => c.name === 'app_name')).toBe(true)
    }
  })

  it('upserts a scope row and keeps the newest updatedAt', () => {
    db.upsertScope(sampleScope({ updatedAt: 1_000 }))
    db.upsertScope(sampleScope({ updatedAt: 500, keyboardProductName: 'stale' }))

    const conn = db.getConnection()
    const row = conn.prepare('SELECT keyboard_product_name, updated_at FROM typing_scopes WHERE id = ?').get('scope-1') as { keyboard_product_name: string; updated_at: number }
    expect(row.updated_at).toBe(1_000)
    expect(row.keyboard_product_name).toBe('Pipette')
  })

  it('accumulates char counts additively on conflict', () => {
    db.upsertScope(sampleScope())
    db.writeMinute(
      {
        scopeId: 'scope-1',
        minuteTs: 60_000,
        keystrokes: 3,
        activeMs: 1_500,
        intervalAvgMs: 500,
        intervalMinMs: 500,
        intervalP25Ms: 500,
        intervalP50Ms: 500,
        intervalP75Ms: 500,
        intervalMaxMs: 500,
      },
      [
        { scopeId: 'scope-1', minuteTs: 60_000, char: 'a', count: 2 },
        { scopeId: 'scope-1', minuteTs: 60_000, char: 'b', count: 1 },
      ],
      [],
      2_000,
    )
    db.writeMinute(
      {
        scopeId: 'scope-1',
        minuteTs: 60_000,
        keystrokes: 1,
        activeMs: 500,
        intervalAvgMs: 500,
        intervalMinMs: 500,
        intervalP25Ms: 500,
        intervalP50Ms: 500,
        intervalP75Ms: 500,
        intervalMaxMs: 500,
      },
      [{ scopeId: 'scope-1', minuteTs: 60_000, char: 'a', count: 3 }],
      [],
      3_000,
    )

    const conn = db.getConnection()
    const rows = conn.prepare('SELECT char, count FROM typing_char_minute WHERE scope_id = ? AND minute_ts = ? ORDER BY char').all('scope-1', 60_000) as Array<{ char: string; count: number }>
    expect(rows).toEqual([
      { char: 'a', count: 5 },
      { char: 'b', count: 1 },
    ])

    const stats = conn.prepare('SELECT keystrokes, active_ms FROM typing_minute_stats WHERE scope_id = ? AND minute_ts = ?').get('scope-1', 60_000) as { keystrokes: number; active_ms: number }
    expect(stats.keystrokes).toBe(4)
    expect(stats.active_ms).toBe(2_000)
  })

  it('accumulates matrix counts additively on conflict', () => {
    db.upsertScope(sampleScope())
    db.writeMinute(
      { scopeId: 'scope-1', minuteTs: 60_000, keystrokes: 1, activeMs: 500, intervalAvgMs: 500, intervalMinMs: 500, intervalP25Ms: 500, intervalP50Ms: 500, intervalP75Ms: 500, intervalMaxMs: 500 },
      [],
      [{ scopeId: 'scope-1', minuteTs: 60_000, row: 0, col: 3, layer: 0, keycode: 0x04, count: 2 }],
      1_000,
    )
    db.writeMinute(
      { scopeId: 'scope-1', minuteTs: 60_000, keystrokes: 1, activeMs: 500, intervalAvgMs: 500, intervalMinMs: 500, intervalP25Ms: 500, intervalP50Ms: 500, intervalP75Ms: 500, intervalMaxMs: 500 },
      [],
      [{ scopeId: 'scope-1', minuteTs: 60_000, row: 0, col: 3, layer: 0, keycode: 0x04, count: 3 }],
      2_000,
    )

    const row = db.getConnection().prepare('SELECT count, keycode FROM typing_matrix_minute WHERE scope_id = ? AND minute_ts = ? AND row = 0 AND col = 3 AND layer = 0').get('scope-1', 60_000) as { count: number; keycode: number }
    expect(row.count).toBe(5)
    expect(row.keycode).toBe(0x04)
  })

  it('inserts a session row and leaves it unchanged on older updatedAt', () => {
    db.upsertScope(sampleScope())
    db.insertSession({ id: 'session-1', scopeId: 'scope-1', startMs: 10_000, endMs: 20_000 }, 3_000)
    db.insertSession({ id: 'session-1', scopeId: 'scope-1', startMs: 999, endMs: 999 }, 1_000)

    const row = db.getConnection().prepare('SELECT start_ms, end_ms FROM typing_sessions WHERE id = ?').get('session-1') as { start_ms: number; end_ms: number }
    expect(row.start_ms).toBe(10_000)
    expect(row.end_ms).toBe(20_000)
  })

  it('retainOwnData removes rows before the cutoff for the local machine only', () => {
    const localScope = sampleScope({ id: 'local', machineHash: MACHINE_HASH })
    const remoteScope = sampleScope({ id: 'remote', machineHash: 'other-machine' })
    db.upsertScope(localScope)
    db.upsertScope(remoteScope)

    const stats = { keystrokes: 1, activeMs: 1, intervalAvgMs: 1, intervalMinMs: 1, intervalP25Ms: 1, intervalP50Ms: 1, intervalP75Ms: 1, intervalMaxMs: 1 }
    for (const scopeId of ['local', 'remote'] as const) {
      db.writeMinute(
        { scopeId, minuteTs: 50_000, ...stats },
        [{ scopeId, minuteTs: 50_000, char: 'a', count: 1 }],
        [],
        1_000,
      )
      db.writeMinute(
        { scopeId, minuteTs: 200_000, ...stats },
        [{ scopeId, minuteTs: 200_000, char: 'b', count: 1 }],
        [],
        2_000,
      )
      db.insertSession({ id: `${scopeId}-old`, scopeId, startMs: 10_000, endMs: 20_000 }, 1_000)
      db.insertSession({ id: `${scopeId}-new`, scopeId, startMs: 150_000, endMs: 180_000 }, 2_000)
    }

    db.retainOwnData(MACHINE_HASH, 100_000)

    const conn = db.getConnection()
    const localChars = conn.prepare('SELECT minute_ts FROM typing_char_minute WHERE scope_id = ? ORDER BY minute_ts').all('local') as Array<{ minute_ts: number }>
    expect(localChars).toEqual([{ minute_ts: 200_000 }])

    const remoteChars = conn.prepare('SELECT minute_ts FROM typing_char_minute WHERE scope_id = ? ORDER BY minute_ts').all('remote') as Array<{ minute_ts: number }>
    expect(remoteChars).toEqual([{ minute_ts: 50_000 }, { minute_ts: 200_000 }])

    const localSessions = conn.prepare('SELECT id FROM typing_sessions WHERE scope_id = ? ORDER BY id').all('local') as Array<{ id: string }>
    expect(localSessions).toEqual([{ id: 'local-new' }])

    const remoteSessions = conn.prepare('SELECT id FROM typing_sessions WHERE scope_id = ? ORDER BY id').all('remote') as Array<{ id: string }>
    expect(remoteSessions).toEqual([{ id: 'remote-new' }, { id: 'remote-old' }])
  })

  it('reopens an existing database file without error', () => {
    db.upsertScope(sampleScope())
    const path = join(tmpDir, 'typing-analytics.db')
    db.close()

    const reopened = new TypingAnalyticsDB(path)
    const row = reopened.getConnection().prepare('SELECT id FROM typing_scopes').get() as { id: string }
    expect(row.id).toBe('scope-1')
    reopened.close()
  })

  describe('sync merge (authoritative LWW)', () => {
    beforeEach(() => {
      db.upsertScope(sampleScope())
      db.writeMinute(
        { scopeId: 'scope-1', minuteTs: 60_000, keystrokes: 2, activeMs: 1_000, intervalAvgMs: 500, intervalMinMs: 500, intervalP25Ms: 500, intervalP50Ms: 500, intervalP75Ms: 500, intervalMaxMs: 500 },
        [{ scopeId: 'scope-1', minuteTs: 60_000, char: 'a', count: 2 }],
        [{ scopeId: 'scope-1', minuteTs: 60_000, row: 0, col: 3, layer: 0, keycode: 0x04, count: 2 }],
        2_000,
      )
    })

    it('mergeCharMinute replaces the count when remote updated_at is newer', () => {
      db.mergeCharMinute({
        scopeId: 'scope-1', minuteTs: 60_000, char: 'a', count: 99,
        updatedAt: 3_000, isDeleted: false,
      })
      const row = db.getConnection().prepare('SELECT count, updated_at FROM typing_char_minute WHERE char = ?').get('a') as { count: number; updated_at: number }
      expect(row.count).toBe(99)
      expect(row.updated_at).toBe(3_000)
    })

    it('mergeCharMinute leaves the local row untouched when remote updated_at is older', () => {
      db.mergeCharMinute({
        scopeId: 'scope-1', minuteTs: 60_000, char: 'a', count: 99,
        updatedAt: 1_000, isDeleted: false,
      })
      const row = db.getConnection().prepare('SELECT count, updated_at FROM typing_char_minute WHERE char = ?').get('a') as { count: number; updated_at: number }
      expect(row.count).toBe(2)
      expect(row.updated_at).toBe(2_000)
    })

    it('mergeCharMinute with is_deleted=1 writes a tombstone when newer', () => {
      db.mergeCharMinute({
        scopeId: 'scope-1', minuteTs: 60_000, char: 'a', count: 0,
        updatedAt: 3_000, isDeleted: true,
      })
      const row = db.getConnection().prepare('SELECT is_deleted FROM typing_char_minute WHERE char = ?').get('a') as { is_deleted: number }
      expect(row.is_deleted).toBe(1)
    })

    it('mergeMatrixMinute follows LWW with replaced count (not additive)', () => {
      db.mergeMatrixMinute({
        scopeId: 'scope-1', minuteTs: 60_000, row: 0, col: 3, layer: 0, keycode: 0x04, count: 7,
        updatedAt: 3_000, isDeleted: false,
      })
      const row = db.getConnection().prepare('SELECT count FROM typing_matrix_minute WHERE scope_id = ? AND minute_ts = ? AND row = 0 AND col = 3 AND layer = 0').get('scope-1', 60_000) as { count: number }
      expect(row.count).toBe(7)
    })

    it('mergeMinuteStats replaces stats wholesale when newer', () => {
      db.mergeMinuteStats({
        scopeId: 'scope-1', minuteTs: 60_000, keystrokes: 50, activeMs: 4_000,
        intervalAvgMs: 100, intervalMinMs: 50, intervalP25Ms: 60, intervalP50Ms: 90, intervalP75Ms: 130, intervalMaxMs: 200,
        updatedAt: 3_000, isDeleted: false,
      })
      const row = db.getConnection().prepare('SELECT keystrokes, active_ms, interval_max_ms FROM typing_minute_stats WHERE scope_id = ? AND minute_ts = ?').get('scope-1', 60_000) as { keystrokes: number; active_ms: number; interval_max_ms: number }
      expect(row.keystrokes).toBe(50)
      expect(row.active_ms).toBe(4_000)
      expect(row.interval_max_ms).toBe(200)
    })

    it('mergeSession replaces start/end on LWW win', () => {
      db.insertSession({ id: 'session-1', scopeId: 'scope-1', startMs: 10_000, endMs: 20_000 }, 3_000)
      db.mergeSession({ id: 'session-1', scopeId: 'scope-1', startMs: 50_000, endMs: 80_000, updatedAt: 4_000, isDeleted: false })
      const row = db.getConnection().prepare('SELECT start_ms, end_ms FROM typing_sessions WHERE id = ?').get('session-1') as { start_ms: number; end_ms: number }
      expect(row.start_ms).toBe(50_000)
      expect(row.end_ms).toBe(80_000)
    })

    it('mergeScope preserves incoming is_deleted tombstone', () => {
      db.mergeScope({
        id: 'scope-1',
        machineHash: MACHINE_HASH,
        osPlatform: 'linux',
        osRelease: '6.8.0',
        osArch: 'x64',
        keyboardUid: '0xAABB',
        keyboardVendorId: 0xFEED,
        keyboardProductId: 0x0000,
        keyboardProductName: 'Pipette',
        updatedAt: 5_000,
        isDeleted: true,
      })
      const row = db.getConnection().prepare('SELECT is_deleted FROM typing_scopes WHERE id = ?').get('scope-1') as { is_deleted: number }
      expect(row.is_deleted).toBe(1)
    })

    it('mergeBigramMinute fans a payload into per-pair rows with packed hist BLOB', () => {
      db.mergeBigramMinute({
        scopeId: 'scope-1',
        minuteTs: 60_000,
        bigrams: {
          '4_11': { c: 3, h: [0, 1, 2, 0, 0, 0, 0, 0] },
          '22_22': { c: 7, h: [0, 0, 0, 0, 7, 0, 0, 0] },
        },
        updatedAt: 3_000,
        isDeleted: false,
      })
      const conn = db.getConnection()
      const rows = conn
        .prepare('SELECT bigram_id, count, hist FROM typing_bigram_minute ORDER BY bigram_id')
        .all() as { bigram_id: string; count: number; hist: Uint8Array }[]
      expect(rows.map((r) => r.bigram_id)).toEqual(['22_22', '4_11'])
      expect(rows[1].count).toBe(3)
      // Hist BLOB is 8 × u32 LE = 32 bytes; bucket 2 should equal 2.
      expect(rows[1].hist.byteLength).toBe(32)
      const histBuf = Buffer.from(rows[1].hist.buffer, rows[1].hist.byteOffset, rows[1].hist.byteLength)
      expect(histBuf.readUInt32LE(2 * 4)).toBe(2)
    })

    it('mergeBigramMinute follows LWW: stale updated_at does not overwrite', () => {
      db.mergeBigramMinute({
        scopeId: 'scope-1',
        minuteTs: 60_000,
        bigrams: { '4_11': { c: 5, h: [0, 5, 0, 0, 0, 0, 0, 0] } },
        updatedAt: 3_000,
        isDeleted: false,
      })
      // Older updated_at — must be ignored.
      db.mergeBigramMinute({
        scopeId: 'scope-1',
        minuteTs: 60_000,
        bigrams: { '4_11': { c: 999, h: [9, 0, 0, 0, 0, 0, 0, 0] } },
        updatedAt: 2_500,
        isDeleted: false,
      })
      const row = db.getConnection().prepare('SELECT count FROM typing_bigram_minute WHERE bigram_id = ?').get('4_11') as { count: number }
      expect(row.count).toBe(5)
    })

    it('mergeBigramMinute is a no-op for an empty bigrams payload', () => {
      // Empty bigrams should not insert any rows. The service skips
      // emit when size === 0, but a reader / migration tool could still
      // call merge with an empty set.
      db.mergeBigramMinute({
        scopeId: 'scope-1',
        minuteTs: 60_000,
        bigrams: {},
        updatedAt: 3_000,
        isDeleted: false,
      })
      const count = db.getConnection().prepare('SELECT COUNT(*) AS n FROM typing_bigram_minute').get() as { n: number }
      expect(count.n).toBe(0)
    })
  })

  describe('sync export', () => {
    beforeEach(() => {
      db.upsertScope(sampleScope({ id: 'scope-local-a', keyboardUid: '0xAABB', machineHash: MACHINE_HASH }))
      db.upsertScope(sampleScope({ id: 'scope-local-b', keyboardUid: '0xCCDD', machineHash: MACHINE_HASH }))
      db.upsertScope(sampleScope({ id: 'scope-remote', keyboardUid: '0xAABB', machineHash: 'other-machine' }))

      const baseStats = { keystrokes: 1, activeMs: 1, intervalAvgMs: 1, intervalMinMs: 1, intervalP25Ms: 1, intervalP50Ms: 1, intervalP75Ms: 1, intervalMaxMs: 1 }
      // Live row inside the window.
      db.writeMinute(
        { scopeId: 'scope-local-a', minuteTs: 200_000, ...baseStats },
        [{ scopeId: 'scope-local-a', minuteTs: 200_000, char: 'a', count: 1 }],
        [],
        10_000,
      )
      // Live row outside the live window (older than cutoff).
      db.writeMinute(
        { scopeId: 'scope-local-a', minuteTs: 50_000, ...baseStats },
        [{ scopeId: 'scope-local-a', minuteTs: 50_000, char: 'b', count: 1 }],
        [],
        10_000,
      )
      // Tombstone inside the tombstone window.
      db.getConnection().prepare(
        "INSERT INTO typing_char_minute (scope_id, minute_ts, char, count, updated_at, is_deleted) VALUES (?, ?, ?, ?, ?, 1)",
      ).run('scope-local-a', 10_000, 'x', 0, 9_000)
      // Remote-machine row sharing the uid; must not be included in the local export.
      db.writeMinute(
        { scopeId: 'scope-remote', minuteTs: 200_000, ...baseStats },
        [{ scopeId: 'scope-remote', minuteTs: 200_000, char: 'z', count: 1 }],
        [],
        10_000,
      )
      db.insertSession({ id: 'session-live', scopeId: 'scope-local-a', startMs: 200_000, endMs: 210_000 }, 10_000)
      db.insertSession({ id: 'session-old', scopeId: 'scope-local-a', startMs: 50_000, endMs: 60_000 }, 10_000)
    })

    it('exportCharMinutesForUid returns live rows within the window and recent tombstones', () => {
      const rows = db.exportCharMinutesForUid('0xAABB', 100_000, 5_000)
      const chars = rows.map((r) => r.char).sort()
      // live 'a' (200_000 > 100_000) + tombstone 'x' (updated_at 9_000 > 5_000) + remote 'z'.
      // 'b' (50_000 < 100_000) is excluded.
      expect(chars).toEqual(['a', 'x', 'z'])
      const tomb = rows.find((r) => r.char === 'x')!
      expect(tomb.isDeleted).toBe(true)
    })

    it('exportCharMinutesForUid excludes tombstones older than the tombstone window', () => {
      const rows = db.exportCharMinutesForUid('0xAABB', 100_000, 15_000)
      expect(rows.map((r) => r.char).sort()).toEqual(['a', 'z'])
    })

    it('exportScopesForUid returns every scope sharing the uid regardless of machine', () => {
      const rows = db.exportScopesForUid('0xAABB', 0)
      expect(rows.map((r) => r.id).sort()).toEqual(['scope-local-a', 'scope-remote'])
    })

    it('exportSessionsForUid respects the live start_ms window', () => {
      const rows = db.exportSessionsForUid('0xAABB', 100_000, 5_000)
      expect(rows.map((r) => r.id).sort()).toEqual(['session-live'])
    })

    it('listLocalKeyboardUids returns distinct uids for this machine only', () => {
      const uids = db.listLocalKeyboardUids(MACHINE_HASH).sort()
      expect(uids).toEqual(['0xAABB', '0xCCDD'])
      expect(db.listLocalKeyboardUids('other-machine')).toEqual(['0xAABB'])
    })
  })

  describe('data modal queries', () => {
    const baseStats = { keystrokes: 1, activeMs: 1, intervalAvgMs: 1, intervalMinMs: 1, intervalP25Ms: 1, intervalP50Ms: 1, intervalP75Ms: 1, intervalMaxMs: 1 }

    beforeEach(() => {
      // Two scopes sharing the same keyboard uid but different machines,
      // so aggregations must sum across them.
      db.upsertScope(sampleScope({ id: 'scope-aabb-local', keyboardUid: '0xAABB', machineHash: MACHINE_HASH, keyboardProductName: 'Pipette A' }))
      db.upsertScope(sampleScope({ id: 'scope-aabb-remote', keyboardUid: '0xAABB', machineHash: 'other-machine', keyboardProductName: 'Pipette A' }))
      // A second keyboard with data — must appear in listKeyboardsWithTypingData.
      db.upsertScope(sampleScope({ id: 'scope-ccdd-local', keyboardUid: '0xCCDD', machineHash: MACHINE_HASH, keyboardProductName: 'Pipette C' }))
      // Third keyboard: scope exists but NO data rows yet; must be filtered out.
      db.upsertScope(sampleScope({ id: 'scope-empty', keyboardUid: '0xEEFF', machineHash: MACHINE_HASH, keyboardProductName: 'Empty' }))

      db.writeMinute(
        { scopeId: 'scope-aabb-local', minuteTs: 60_000, ...baseStats, keystrokes: 3, activeMs: 1_000 },
        [{ scopeId: 'scope-aabb-local', minuteTs: 60_000, char: 'a', count: 3 }],
        [{ scopeId: 'scope-aabb-local', minuteTs: 60_000, row: 0, col: 0, layer: 0, keycode: 0x04, count: 3 }],
        1_000,
      )
      db.writeMinute(
        { scopeId: 'scope-aabb-remote', minuteTs: 60_000, ...baseStats, keystrokes: 2, activeMs: 500 },
        [{ scopeId: 'scope-aabb-remote', minuteTs: 60_000, char: 'a', count: 2 }],
        [],
        1_000,
      )
      db.writeMinute(
        { scopeId: 'scope-ccdd-local', minuteTs: 120_000, ...baseStats, keystrokes: 7, activeMs: 2_000 },
        [{ scopeId: 'scope-ccdd-local', minuteTs: 120_000, char: 'b', count: 7 }],
        [],
        1_000,
      )
      db.insertSession({ id: 'session-aabb-1', scopeId: 'scope-aabb-local', startMs: 60_000, endMs: 61_000 }, 1_000)
    })

    it('listKeyboardsWithTypingData returns only keyboards with live data and dedupes across machines', () => {
      const rows = db.listKeyboardsWithTypingData()
      const uids = rows.map((r) => r.uid).sort()
      expect(uids).toEqual(['0xAABB', '0xCCDD'])
      // The empty scope uid is filtered out because no stats rows exist.
      expect(uids).not.toContain('0xEEFF')
    })

    it('listDailySummariesForUid aggregates minute stats across machines', () => {
      const summaries = db.listDailySummariesForUid('0xAABB')
      expect(summaries).toHaveLength(1)
      // 3 + 2 keystrokes across local + remote scopes for the same minute.
      expect(summaries[0].keystrokes).toBe(5)
      expect(summaries[0].activeMs).toBe(1_500)
    })

    it('tombstoneRowsForUidInRange flips is_deleted on matching rows and bumps updated_at', () => {
      const result = db.tombstoneRowsForUidInRange('0xAABB', 0, 90_000, 5_000)
      expect(result.charMinutes).toBe(2) // aabb-local + aabb-remote at minute 60_000
      expect(result.minuteStats).toBe(2)
      expect(result.matrixMinutes).toBe(1) // only aabb-local had a matrix row
      expect(result.sessions).toBe(1)

      const conn = db.getConnection()
      const rows = conn.prepare('SELECT is_deleted, updated_at FROM typing_char_minute WHERE char = ?').all('a') as Array<{ is_deleted: number; updated_at: number }>
      expect(rows.every((r) => r.is_deleted === 1)).toBe(true)
      expect(rows.every((r) => r.updated_at === 5_000)).toBe(true)

      // ccdd data at minute 120_000 is untouched because it's outside the range.
      const ccdd = conn.prepare('SELECT is_deleted FROM typing_char_minute WHERE char = ?').get('b') as { is_deleted: number }
      expect(ccdd.is_deleted).toBe(0)
    })

    it('tombstoneRowsForUidHashInRange restricts the tombstone to a single machine_hash', () => {
      const result = db.tombstoneRowsForUidHashInRange('0xAABB', MACHINE_HASH, 0, 90_000, 5_000)
      expect(result.charMinutes).toBe(1) // only scope-aabb-local
      expect(result.matrixMinutes).toBe(1)
      expect(result.minuteStats).toBe(1)
      expect(result.sessions).toBe(1)
      const conn = db.getConnection()
      const localRow = conn.prepare('SELECT is_deleted FROM typing_char_minute WHERE scope_id = ?').get('scope-aabb-local') as { is_deleted: number }
      const remoteRow = conn.prepare('SELECT is_deleted FROM typing_char_minute WHERE scope_id = ?').get('scope-aabb-remote') as { is_deleted: number }
      expect(localRow.is_deleted).toBe(1)
      expect(remoteRow.is_deleted).toBe(0)
    })

    it('tombstoneRowsForUidInRange does not touch already-deleted rows', () => {
      db.tombstoneRowsForUidInRange('0xAABB', 0, 90_000, 5_000)
      // Second tombstone with a newer updated_at should not re-bump the already-deleted rows.
      const result = db.tombstoneRowsForUidInRange('0xAABB', 0, 90_000, 9_000)
      expect(result.charMinutes).toBe(0)
      const row = db.getConnection().prepare('SELECT updated_at FROM typing_char_minute WHERE char = ? AND scope_id = ?').get('a', 'scope-aabb-local') as { updated_at: number }
      expect(row.updated_at).toBe(5_000)
    })

    it('tombstoneAllRowsForUid covers every minute without a range filter', () => {
      const result = db.tombstoneAllRowsForUid('0xAABB', 6_000)
      // 2 char rows + 1 matrix row + 2 stats rows + 1 session = 6 updates.
      expect(result.charMinutes + result.matrixMinutes + result.minuteStats + result.sessions).toBe(6)

      // Re-run listKeyboardsWithTypingData — 0xAABB no longer has live rows so it drops out.
      const remaining = db.listKeyboardsWithTypingData().map((r) => r.uid)
      expect(remaining).toEqual(['0xCCDD'])
    })

    it('listDailySummariesForUid ignores tombstoned rows', () => {
      db.tombstoneAllRowsForUid('0xAABB', 6_000)
      expect(db.listDailySummariesForUid('0xAABB')).toEqual([])
    })

    it('tombstoneRowsForUidInRange catches sessions that span into the window', () => {
      // A session that started before the delete window and ends inside it
      // (e.g. crosses midnight) must still be tombstoned — day-level delete
      // should remove everything that contributed minutes to that day.
      db.insertSession(
        { id: 'session-midnight', scopeId: 'scope-aabb-local', startMs: 10_000, endMs: 70_000 },
        1_000,
      )
      const result = db.tombstoneRowsForUidInRange('0xAABB', 60_000, 120_000, 8_000)
      expect(result.sessions).toBeGreaterThanOrEqual(1)
      const row = db.getConnection().prepare('SELECT is_deleted FROM typing_sessions WHERE id = ?').get('session-midnight') as { is_deleted: number }
      expect(row.is_deleted).toBe(1)
    })
  })

  describe('aggregateMatrixCountsForUid (heatmap)', () => {
    // Small helper so each heatmap test can seed just the rows it cares
    // about without repeating the stats/char payload the schema demands.
    const stats = { keystrokes: 1, activeMs: 1, intervalAvgMs: 1, intervalMinMs: 1, intervalP25Ms: 1, intervalP50Ms: 1, intervalP75Ms: 1, intervalMaxMs: 1 }
    function writeMatrix(scopeId: string, minuteTs: number, row: number, col: number, layer: number, count: number, updatedAt = 1_000): void {
      db.writeMinute(
        { scopeId, minuteTs, ...stats },
        [],
        [{ scopeId, minuteTs, row, col, layer, keycode: 0x04, count }],
        updatedAt,
      )
    }

    beforeEach(() => {
      db.upsertScope(sampleScope({ id: 'scope-local', machineHash: MACHINE_HASH, keyboardUid: '0xAABB' }))
      db.upsertScope(sampleScope({ id: 'scope-other-machine', machineHash: 'other', keyboardUid: '0xAABB' }))
      db.upsertScope(sampleScope({ id: 'scope-other-uid', machineHash: MACHINE_HASH, keyboardUid: '0xCCDD' }))
    })

    it('sums counts by (row, col) within the time window and layer', () => {
      writeMatrix('scope-local', 60_000, 1, 2, 0, 3)
      writeMatrix('scope-local', 120_000, 1, 2, 0, 5) // same cell/layer, accumulates
      writeMatrix('scope-local', 180_000, 0, 0, 0, 1)
      const heat = db.aggregateMatrixCountsForUid('0xAABB', MACHINE_HASH, 0, 60_000)
      expect(heat.get('1,2')?.total).toBe(8)
      expect(heat.get('0,0')?.total).toBe(1)
      expect(heat.size).toBe(2)
    })

    it('excludes other machines so one machine\'s heatmap never leaks another\'s data', () => {
      writeMatrix('scope-local', 60_000, 1, 2, 0, 3)
      writeMatrix('scope-other-machine', 60_000, 1, 2, 0, 100)
      const heat = db.aggregateMatrixCountsForUid('0xAABB', MACHINE_HASH, 0, 60_000)
      expect(heat.get('1,2')?.total).toBe(3)
    })

    it('excludes other keyboards on the same machine', () => {
      writeMatrix('scope-local', 60_000, 1, 2, 0, 3)
      writeMatrix('scope-other-uid', 60_000, 1, 2, 0, 99)
      const heat = db.aggregateMatrixCountsForUid('0xAABB', MACHINE_HASH, 0, 60_000)
      expect(heat.get('1,2')?.total).toBe(3)
    })

    it('excludes other layers so the heatmap shows only the active layer', () => {
      writeMatrix('scope-local', 60_000, 1, 2, 0, 3)
      writeMatrix('scope-local', 60_000, 1, 2, 1, 100)
      const heat = db.aggregateMatrixCountsForUid('0xAABB', MACHINE_HASH, 0, 60_000)
      expect(heat.get('1,2')?.total).toBe(3)
      expect(heat.size).toBe(1)
    })

    it('drops rows older than sinceMinuteMs', () => {
      writeMatrix('scope-local', 30_000, 1, 2, 0, 100) // before cutoff
      writeMatrix('scope-local', 60_000, 1, 2, 0, 7) // at cutoff (inclusive)
      const heat = db.aggregateMatrixCountsForUid('0xAABB', MACHINE_HASH, 0, 60_000)
      expect(heat.get('1,2')?.total).toBe(7)
    })

    it('excludes tombstoned matrix rows', () => {
      writeMatrix('scope-local', 60_000, 1, 2, 0, 3)
      db.mergeMatrixMinute({
        scopeId: 'scope-local', minuteTs: 60_000, row: 1, col: 2, layer: 0, keycode: 0x04, count: 0,
        updatedAt: 5_000, isDeleted: true,
      })
      const heat = db.aggregateMatrixCountsForUid('0xAABB', MACHINE_HASH, 0, 60_000)
      expect(heat.size).toBe(0)
    })

    it('excludes rows whose scope is tombstoned', () => {
      writeMatrix('scope-local', 60_000, 1, 2, 0, 3)
      db.mergeScope({
        ...sampleScope({ id: 'scope-local', machineHash: MACHINE_HASH, keyboardUid: '0xAABB' }),
        updatedAt: 5_000,
        isDeleted: true,
      })
      const heat = db.aggregateMatrixCountsForUid('0xAABB', MACHINE_HASH, 0, 60_000)
      expect(heat.size).toBe(0)
    })

    it('carries tap / hold subcounts alongside the per-cell total', () => {
      db.writeMinute(
        { scopeId: 'scope-local', minuteTs: 60_000, ...stats },
        [],
        [
          // Four total presses on the same cell: two classified as tap,
          // one as hold, one unclassified (still-held or non-tap-hold key).
          { scopeId: 'scope-local', minuteTs: 60_000, row: 1, col: 2, layer: 0, keycode: 0x04, count: 1, tapCount: 1, holdCount: 0 },
          { scopeId: 'scope-local', minuteTs: 60_000, row: 1, col: 2, layer: 0, keycode: 0x04, count: 1, tapCount: 1, holdCount: 0 },
          { scopeId: 'scope-local', minuteTs: 60_000, row: 1, col: 2, layer: 0, keycode: 0x04, count: 1, tapCount: 0, holdCount: 1 },
          { scopeId: 'scope-local', minuteTs: 60_000, row: 1, col: 2, layer: 0, keycode: 0x04, count: 1 },
        ],
        1_000,
      )
      const cell = db.aggregateMatrixCountsForUid('0xAABB', MACHINE_HASH, 0, 60_000).get('1,2')
      expect(cell).toEqual({ total: 4, tap: 2, hold: 1 })
    })
  })

  describe('listLayerUsageForUid (Analyze > Layer)', () => {
    const stats = { keystrokes: 1, activeMs: 1, intervalAvgMs: 1, intervalMinMs: 1, intervalP25Ms: 1, intervalP50Ms: 1, intervalP75Ms: 1, intervalMaxMs: 1 }
    function writeMatrix(scopeId: string, minuteTs: number, row: number, col: number, layer: number, count: number, updatedAt = 1_000): void {
      db.writeMinute(
        { scopeId, minuteTs, ...stats },
        [],
        [{ scopeId, minuteTs, row, col, layer, keycode: 0x04, count }],
        updatedAt,
      )
    }

    beforeEach(() => {
      db.upsertScope(sampleScope({ id: 'scope-local', machineHash: MACHINE_HASH, keyboardUid: '0xAABB' }))
      db.upsertScope(sampleScope({ id: 'scope-other-machine', machineHash: 'other', keyboardUid: '0xAABB' }))
      db.upsertScope(sampleScope({ id: 'scope-other-uid', machineHash: MACHINE_HASH, keyboardUid: '0xCCDD' }))
    })

    it('groups keystrokes by layer within the [since, until) window', () => {
      writeMatrix('scope-local', 60_000, 0, 0, 0, 3)
      writeMatrix('scope-local', 60_000, 0, 1, 0, 2) // layer 0 accumulates
      writeMatrix('scope-local', 120_000, 0, 0, 1, 7) // layer 1
      writeMatrix('scope-local', 180_000, 0, 0, 2, 4) // layer 2
      const rows = db.listLayerUsageForUid('0xAABB', 60_000, 240_000)
      expect(rows).toEqual([
        { layer: 0, keystrokes: 5 },
        { layer: 1, keystrokes: 7 },
        { layer: 2, keystrokes: 4 },
      ])
    })

    it('drops rows outside the [since, until) window', () => {
      writeMatrix('scope-local', 30_000, 0, 0, 0, 100) // before window
      writeMatrix('scope-local', 60_000, 0, 0, 0, 7) // inclusive lower bound
      writeMatrix('scope-local', 240_000, 0, 0, 1, 999) // excluded upper bound
      const rows = db.listLayerUsageForUid('0xAABB', 60_000, 240_000)
      expect(rows).toEqual([{ layer: 0, keystrokes: 7 }])
    })

    it('aggregates across machines by default (all-devices scope)', () => {
      writeMatrix('scope-local', 60_000, 0, 0, 0, 3)
      writeMatrix('scope-other-machine', 60_000, 0, 0, 0, 4)
      const rows = db.listLayerUsageForUid('0xAABB', 60_000, 120_000)
      expect(rows).toEqual([{ layer: 0, keystrokes: 7 }])
    })

    it('excludes other keyboards on the same machine', () => {
      writeMatrix('scope-local', 60_000, 0, 0, 0, 3)
      writeMatrix('scope-other-uid', 60_000, 0, 0, 0, 99)
      const rows = db.listLayerUsageForUid('0xAABB', 60_000, 120_000)
      expect(rows).toEqual([{ layer: 0, keystrokes: 3 }])
    })

    it('excludes tombstoned matrix rows and tombstoned scopes', () => {
      writeMatrix('scope-local', 60_000, 0, 0, 0, 5)
      db.mergeMatrixMinute({
        scopeId: 'scope-local', minuteTs: 60_000, row: 0, col: 0, layer: 0, keycode: 0x04, count: 0,
        updatedAt: 5_000, isDeleted: true,
      })
      writeMatrix('scope-other-machine', 60_000, 0, 0, 0, 8)
      db.mergeScope({
        ...sampleScope({ id: 'scope-other-machine', machineHash: 'other', keyboardUid: '0xAABB' }),
        updatedAt: 5_000,
        isDeleted: true,
      })
      const rows = db.listLayerUsageForUid('0xAABB', 60_000, 120_000)
      expect(rows).toEqual([])
    })

    it('listLayerUsageForUidAndHash restricts to one machine', () => {
      writeMatrix('scope-local', 60_000, 0, 0, 0, 3)
      writeMatrix('scope-other-machine', 60_000, 0, 0, 0, 4)
      const rows = db.listLayerUsageForUidAndHash('0xAABB', MACHINE_HASH, 60_000, 120_000)
      expect(rows).toEqual([{ layer: 0, keystrokes: 3 }])
    })
  })

  describe('listMatrixCellsForUid (Analyze > Layer activations)', () => {
    const stats = { keystrokes: 1, activeMs: 1, intervalAvgMs: 1, intervalMinMs: 1, intervalP25Ms: 1, intervalP50Ms: 1, intervalP75Ms: 1, intervalMaxMs: 1 }
    function writeMatrix(
      scopeId: string,
      minuteTs: number,
      row: number,
      col: number,
      layer: number,
      count: number,
      tapCount = 0,
      holdCount = 0,
      updatedAt = 1_000,
    ): void {
      db.writeMinute(
        { scopeId, minuteTs, ...stats },
        [],
        [{ scopeId, minuteTs, row, col, layer, keycode: 0x04, count, tapCount, holdCount }],
        updatedAt,
      )
    }

    beforeEach(() => {
      db.upsertScope(sampleScope({ id: 'scope-local', machineHash: MACHINE_HASH, keyboardUid: '0xAABB' }))
      db.upsertScope(sampleScope({ id: 'scope-other-machine', machineHash: 'other', keyboardUid: '0xAABB' }))
      db.upsertScope(sampleScope({ id: 'scope-other-uid', machineHash: MACHINE_HASH, keyboardUid: '0xCCDD' }))
    })

    it('groups per-(layer,row,col) with tap / hold splits preserved', () => {
      writeMatrix('scope-local', 60_000, 0, 1, 0, 4, 3, 1)
      writeMatrix('scope-local', 120_000, 0, 1, 0, 2, 1, 1) // same cell → sums
      writeMatrix('scope-local', 60_000, 0, 2, 0, 5)
      const rows = db.listMatrixCellsForUid('0xAABB', 60_000, 240_000)
      // Order is not guaranteed; compare as sets.
      expect(rows).toHaveLength(2)
      const byKey = new Map(rows.map((r) => [`${r.layer},${r.row},${r.col}`, r]))
      expect(byKey.get('0,0,1')).toEqual({ layer: 0, row: 0, col: 1, count: 6, tap: 4, hold: 2 })
      expect(byKey.get('0,0,2')).toEqual({ layer: 0, row: 0, col: 2, count: 5, tap: 0, hold: 0 })
    })

    it('keeps per-layer rows distinct', () => {
      writeMatrix('scope-local', 60_000, 0, 0, 0, 3)
      writeMatrix('scope-local', 60_000, 0, 0, 1, 7)
      const rows = db.listMatrixCellsForUid('0xAABB', 60_000, 120_000)
      expect(rows).toHaveLength(2)
      expect(rows.find((r) => r.layer === 0)).toEqual({ layer: 0, row: 0, col: 0, count: 3, tap: 0, hold: 0 })
      expect(rows.find((r) => r.layer === 1)).toEqual({ layer: 1, row: 0, col: 0, count: 7, tap: 0, hold: 0 })
    })

    it('drops rows outside the window and respects tombstones', () => {
      writeMatrix('scope-local', 30_000, 0, 0, 0, 100) // before window
      writeMatrix('scope-local', 60_000, 0, 0, 0, 7) // inclusive lower
      db.mergeMatrixMinute({
        scopeId: 'scope-local', minuteTs: 60_000, row: 0, col: 0, layer: 0, keycode: 0x04, count: 0,
        updatedAt: 5_000, isDeleted: true,
      })
      writeMatrix('scope-local', 120_000, 0, 0, 0, 3) // survives
      const rows = db.listMatrixCellsForUid('0xAABB', 60_000, 240_000)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toEqual({ layer: 0, row: 0, col: 0, count: 3, tap: 0, hold: 0 })
    })

    it('excludes other keyboards on the same machine', () => {
      writeMatrix('scope-local', 60_000, 0, 0, 0, 3)
      writeMatrix('scope-other-uid', 60_000, 0, 0, 0, 99)
      const rows = db.listMatrixCellsForUid('0xAABB', 60_000, 120_000)
      expect(rows).toEqual([{ layer: 0, row: 0, col: 0, count: 3, tap: 0, hold: 0 }])
    })

    it('listMatrixCellsForUidAndHash restricts to one machine', () => {
      writeMatrix('scope-local', 60_000, 0, 0, 0, 3)
      writeMatrix('scope-other-machine', 60_000, 0, 0, 0, 4)
      const rows = db.listMatrixCellsForUidAndHash('0xAABB', MACHINE_HASH, 60_000, 120_000)
      expect(rows).toEqual([{ layer: 0, row: 0, col: 0, count: 3, tap: 0, hold: 0 }])
    })
  })

  describe('listBigramMinutesInRangeForUid (Analyze > Bigrams)', () => {
    function bigramRow(
      scopeId: string,
      minuteTs: number,
      bigramId: string,
      count: number,
      h: number[],
      updatedAt = 1_000,
    ): void {
      db.mergeBigramMinute({
        scopeId,
        minuteTs,
        bigrams: { [bigramId]: { c: count, h } },
        updatedAt,
        isDeleted: false,
      })
    }

    beforeEach(() => {
      db.upsertScope(sampleScope({ id: 'scope-local', machineHash: MACHINE_HASH, keyboardUid: '0xAABB' }))
      db.upsertScope(sampleScope({ id: 'scope-other-machine', machineHash: 'other', keyboardUid: '0xAABB' }))
      db.upsertScope(sampleScope({ id: 'scope-other-uid', machineHash: MACHINE_HASH, keyboardUid: '0xCCDD' }))
    })

    it('returns rows in range with hist decoded back to a number array', () => {
      bigramRow('scope-local', 60_000, '4_11', 3, [0, 2, 1, 0, 0, 0, 0, 0])
      const rows = db.listBigramMinutesInRangeForUid('0xAABB', 60_000, 120_000)
      expect(rows).toEqual([
        { bigramId: '4_11', minuteTs: 60_000, count: 3, hist: [0, 2, 1, 0, 0, 0, 0, 0] },
      ])
    })

    it('drops rows outside the window and respects tombstones', () => {
      bigramRow('scope-local', 30_000, 'A', 1, [1, 0, 0, 0, 0, 0, 0, 0]) // before window
      bigramRow('scope-local', 60_000, 'B', 2, [0, 2, 0, 0, 0, 0, 0, 0]) // in
      // Tombstone B with newer updated_at; the read path must skip it.
      db.mergeBigramMinute({
        scopeId: 'scope-local',
        minuteTs: 60_000,
        bigrams: { B: { c: 0, h: [0, 0, 0, 0, 0, 0, 0, 0] } },
        updatedAt: 5_000,
        isDeleted: true,
      })
      bigramRow('scope-local', 120_000, 'C', 4, [0, 0, 0, 4, 0, 0, 0, 0]) // in
      const rows = db.listBigramMinutesInRangeForUid('0xAABB', 60_000, 240_000)
      expect(rows.map((r) => r.bigramId).sort()).toEqual(['C'])
    })

    it('excludes other keyboards on the same machine', () => {
      bigramRow('scope-local', 60_000, 'kept', 1, [1, 0, 0, 0, 0, 0, 0, 0])
      bigramRow('scope-other-uid', 60_000, 'dropped', 99, [0, 0, 0, 99, 0, 0, 0, 0])
      const rows = db.listBigramMinutesInRangeForUid('0xAABB', 60_000, 120_000)
      expect(rows.map((r) => r.bigramId)).toEqual(['kept'])
    })

    it('listBigramMinutesInRangeForUidAndHash restricts to one machine_hash', () => {
      bigramRow('scope-local', 60_000, 'kept', 1, [1, 0, 0, 0, 0, 0, 0, 0])
      bigramRow('scope-other-machine', 60_000, 'remote', 1, [1, 0, 0, 0, 0, 0, 0, 0])
      const rows = db.listBigramMinutesInRangeForUidAndHash('0xAABB', MACHINE_HASH, 60_000, 120_000)
      expect(rows.map((r) => r.bigramId)).toEqual(['kept'])
    })
  })

  describe('listRemoteDeviceInfosForUid (Analyze > Device dropdown)', () => {
    const baseStats = { keystrokes: 1, activeMs: 1, intervalAvgMs: 1, intervalMinMs: 1, intervalP25Ms: 1, intervalP50Ms: 1, intervalP75Ms: 1, intervalMaxMs: 1 }

    it('collapses multiple os_release scopes for the same machine_hash to a single row with the newest release', () => {
      // Same physical remote machine seen across an OS upgrade — canonicalScopeKey
      // bakes os.release into the scope id so the DB ends up with two rows for
      // one device. The dropdown must still show one entry per machine_hash.
      db.upsertScope(sampleScope({ id: 'scope-remote-old', machineHash: 'remote-machine', osRelease: '6.8.0', updatedAt: 1_000 }))
      db.upsertScope(sampleScope({ id: 'scope-remote-new', machineHash: 'remote-machine', osRelease: '6.10.0', updatedAt: 2_000 }))
      db.writeMinute({ scopeId: 'scope-remote-old', minuteTs: 60_000, ...baseStats }, [], [], 1_000)
      db.writeMinute({ scopeId: 'scope-remote-new', minuteTs: 60_000, ...baseStats }, [], [], 2_000)

      const rows = db.listRemoteDeviceInfosForUid('0xAABB', MACHINE_HASH)
      expect(rows).toEqual([{ machineHash: 'remote-machine', osPlatform: 'linux', osRelease: '6.10.0' }])
    })

    it('excludes the local machine_hash', () => {
      db.upsertScope(sampleScope({ id: 'scope-local', machineHash: MACHINE_HASH }))
      db.writeMinute({ scopeId: 'scope-local', minuteTs: 60_000, ...baseStats }, [], [], 1_000)
      db.upsertScope(sampleScope({ id: 'scope-remote', machineHash: 'remote-machine' }))
      db.writeMinute({ scopeId: 'scope-remote', minuteTs: 60_000, ...baseStats }, [], [], 1_000)

      const rows = db.listRemoteDeviceInfosForUid('0xAABB', MACHINE_HASH)
      expect(rows.map((r) => r.machineHash)).toEqual(['remote-machine'])
    })

    it('omits remote machines that have no live minute_stats rows', () => {
      db.upsertScope(sampleScope({ id: 'scope-remote-empty', machineHash: 'remote-empty' }))
      db.upsertScope(sampleScope({ id: 'scope-remote-data', machineHash: 'remote-data' }))
      db.writeMinute({ scopeId: 'scope-remote-data', minuteTs: 60_000, ...baseStats }, [], [], 1_000)

      const rows = db.listRemoteDeviceInfosForUid('0xAABB', MACHINE_HASH)
      expect(rows.map((r) => r.machineHash)).toEqual(['remote-data'])
    })
  })
})
