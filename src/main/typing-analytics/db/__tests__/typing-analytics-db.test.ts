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
})
