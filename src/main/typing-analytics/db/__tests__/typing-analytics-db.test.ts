// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { TypingAnalyticsDB, type TypingScopeRow } from '../typing-analytics-db'

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
    expect(db.getMeta('schema_version')).toBe('1')
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
})
