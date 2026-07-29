// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TypingAnalyticsDB } from '../../db/typing-analytics-db'
import {
  bigramMinuteRowId,
  charMinuteRowId,
  matrixMinuteRowId,
  minuteStatsRowId,
  scopeRowId,
  sessionRowId,
  trigramMinuteRowId,
  type JsonlRow,
} from '../jsonl-row'
import { applyRowsToCache } from '../apply-to-cache'

const SCOPE_ID = 'scope-1'

function scopeRow(updatedAt: number, productName = 'Pipette'): JsonlRow {
  return {
    id: scopeRowId(SCOPE_ID),
    kind: 'scope',
    updated_at: updatedAt,
    payload: {
      id: SCOPE_ID,
      machineHash: 'hash-a',
      osPlatform: 'linux',
      osRelease: '6.8.0',
      osArch: 'x64',
      keyboardUid: '0xAABB',
      keyboardVendorId: 0xFEED,
      keyboardProductId: 0x0001,
      keyboardProductName: productName,
    },
  }
}

function charRow(updatedAt: number, count: number, char = 'a'): JsonlRow {
  return {
    id: charMinuteRowId(SCOPE_ID, 60_000, '', char),
    kind: 'char-minute',
    updated_at: updatedAt,
    payload: { scopeId: SCOPE_ID, minuteTs: 60_000, char, count },
  }
}

function matrixRow(updatedAt: number, count: number, tap = 0, hold = 0): JsonlRow {
  return {
    id: matrixMinuteRowId(SCOPE_ID, 60_000, '', 1, 2, 0),
    kind: 'matrix-minute',
    updated_at: updatedAt,
    payload: {
      scopeId: SCOPE_ID,
      minuteTs: 60_000,
      row: 1,
      col: 2,
      layer: 0,
      keycode: 0x04,
      count,
      tapCount: tap,
      holdCount: hold,
    },
  }
}

function statsRow(updatedAt: number, keystrokes: number): JsonlRow {
  return {
    id: minuteStatsRowId(SCOPE_ID, 60_000, ''),
    kind: 'minute-stats',
    updated_at: updatedAt,
    payload: {
      scopeId: SCOPE_ID,
      minuteTs: 60_000,
      keystrokes,
      activeMs: 1_000,
      intervalAvgMs: 100,
      intervalMinMs: 50,
      intervalP25Ms: 75,
      intervalP50Ms: 100,
      intervalP75Ms: 150,
      intervalMaxMs: 200,
    },
  }
}

function sessionRow(updatedAt: number, sessionId = 'uuid-1'): JsonlRow {
  return {
    id: sessionRowId(sessionId),
    kind: 'session',
    updated_at: updatedAt,
    payload: { id: sessionId, scopeId: SCOPE_ID, startMs: 1_000, endMs: 2_000 },
  }
}

function bigramRow(
  updatedAt: number,
  bigrams: Record<string, { c: number; h: number[] }>,
): JsonlRow {
  return {
    id: bigramMinuteRowId(SCOPE_ID, 60_000, ''),
    kind: 'bigram-minute',
    updated_at: updatedAt,
    payload: { scopeId: SCOPE_ID, minuteTs: 60_000, bigrams },
  }
}

function trigramRow(
  updatedAt: number,
  trigrams: Record<string, { c: number; h: number[] }>,
): JsonlRow {
  return {
    id: trigramMinuteRowId(SCOPE_ID, 60_000, ''),
    kind: 'trigram-minute',
    updated_at: updatedAt,
    payload: { scopeId: SCOPE_ID, minuteTs: 60_000, trigrams },
  }
}

describe('applyRowsToCache', () => {
  let tmpDir: string
  let db: TypingAnalyticsDB

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipette-apply-cache-'))
    db = new TypingAnalyticsDB(join(tmpDir, 'cache.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes each kind into its respective table', () => {
    const rows: JsonlRow[] = [
      scopeRow(1_000),
      charRow(1_000, 2),
      matrixRow(1_000, 5, 3, 2),
      statsRow(1_000, 10),
      sessionRow(1_000),
    ]
    const result = applyRowsToCache(db, rows)
    expect(result).toEqual({
      scopes: 1,
      charMinutes: 1,
      matrixMinutes: 1,
      minuteStats: 1,
      sessions: 1,
      bigramMinutes: 0,
      trigramMinutes: 0,
    })
    const conn = db.getConnection()
    expect(conn.prepare('SELECT COUNT(*) AS n FROM typing_scopes').get()).toEqual({ n: 1 })
    expect(conn.prepare('SELECT COUNT(*) AS n FROM typing_char_minute').get()).toEqual({ n: 1 })
    expect(conn.prepare('SELECT COUNT(*) AS n FROM typing_matrix_minute').get()).toEqual({ n: 1 })
    expect(conn.prepare('SELECT COUNT(*) AS n FROM typing_minute_stats').get()).toEqual({ n: 1 })
    expect(conn.prepare('SELECT COUNT(*) AS n FROM typing_sessions').get()).toEqual({ n: 1 })
  })

  it('applies matrix-minute dh/ds/dq, bigram-minute oc/on, and minute-stats pollP50Ms/pollP95Ms through to their SQL columns', () => {
    const rows: JsonlRow[] = [
      scopeRow(1_000),
      {
        id: matrixMinuteRowId(SCOPE_ID, 60_000, '', 1, 2, 0),
        kind: 'matrix-minute',
        updated_at: 1_000,
        payload: {
          scopeId: SCOPE_ID, minuteTs: 60_000, row: 1, col: 2, layer: 0, keycode: 0x04,
          count: 1, tapCount: 0, holdCount: 0,
          dh: [0, 1, 0, 0, 0, 0, 0, 0], ds: 65, dq: 4_225,
        },
      },
      {
        id: bigramMinuteRowId(SCOPE_ID, 60_000, ''),
        kind: 'bigram-minute',
        updated_at: 1_000,
        payload: {
          scopeId: SCOPE_ID, minuteTs: 60_000,
          bigrams: { '4_11': { c: 2, h: [0, 2, 0, 0, 0, 0, 0, 0], oc: 1, on: 2 } },
        },
      },
      {
        id: minuteStatsRowId(SCOPE_ID, 60_000, ''),
        kind: 'minute-stats',
        updated_at: 1_000,
        payload: {
          scopeId: SCOPE_ID, minuteTs: 60_000, keystrokes: 2, activeMs: 100,
          intervalAvgMs: null, intervalMinMs: null, intervalP25Ms: null, intervalP50Ms: null, intervalP75Ms: null, intervalMaxMs: null,
          pollP50Ms: 20, pollP95Ms: 45,
        },
      },
    ]
    applyRowsToCache(db, rows)
    const conn = db.getConnection()

    const matrix = conn.prepare('SELECT dur_hist, dur_sum, dur_sumsq FROM typing_matrix_minute').get() as {
      dur_hist: Uint8Array
      dur_sum: number
      dur_sumsq: number
    }
    expect(matrix.dur_sum).toBe(65)
    expect(matrix.dur_sumsq).toBe(4_225)
    // Little-endian u32 histogram: bucket 1 (offset 4) should read 1.
    expect(Buffer.from(matrix.dur_hist).readUInt32LE(4)).toBe(1)

    const bigram = conn.prepare('SELECT overlap_count, overlap_n FROM typing_bigram_minute').get() as {
      overlap_count: number
      overlap_n: number
    }
    expect(bigram.overlap_count).toBe(1)
    expect(bigram.overlap_n).toBe(2)

    const stats = conn.prepare('SELECT poll_p50_ms, poll_p95_ms FROM typing_minute_stats').get() as {
      poll_p50_ms: number
      poll_p95_ms: number
    }
    expect(stats.poll_p50_ms).toBe(20)
    expect(stats.poll_p95_ms).toBe(45)
  })

  it('leaves dh/ds/dq, oc/on, and pollP50Ms/pollP95Ms columns NULL for pre-v8 rows that omit them', () => {
    applyRowsToCache(db, [scopeRow(1_000), matrixRow(1_000, 5, 3, 2), statsRow(1_000, 10), bigramRow(1_000, { '4_11': { c: 1, h: [1, 0, 0, 0, 0, 0, 0, 0] } })])
    const conn = db.getConnection()
    const matrix = conn.prepare('SELECT dur_hist, dur_sum, dur_sumsq FROM typing_matrix_minute').get() as {
      dur_hist: Buffer | null
      dur_sum: number | null
      dur_sumsq: number | null
    }
    expect(matrix.dur_hist).toBeNull()
    expect(matrix.dur_sum).toBeNull()
    expect(matrix.dur_sumsq).toBeNull()
    const bigram = conn.prepare('SELECT overlap_count, overlap_n FROM typing_bigram_minute').get() as {
      overlap_count: number | null
      overlap_n: number | null
    }
    expect(bigram.overlap_count).toBeNull()
    expect(bigram.overlap_n).toBeNull()
    const stats = conn.prepare('SELECT poll_p50_ms, poll_p95_ms FROM typing_minute_stats').get() as {
      poll_p50_ms: number | null
      poll_p95_ms: number | null
    }
    expect(stats.poll_p50_ms).toBeNull()
    expect(stats.poll_p95_ms).toBeNull()
  })

  it('applies scope rows before dependent rows so FKs resolve', () => {
    const rows: JsonlRow[] = [charRow(1_000, 2), scopeRow(1_000)]
    expect(() => applyRowsToCache(db, rows)).not.toThrow()
    const conn = db.getConnection()
    const charRows = conn.prepare('SELECT count FROM typing_char_minute').all() as Array<{ count: number }>
    expect(charRows).toEqual([{ count: 2 }])
  })

  it('is idempotent on equal updated_at (LWW strict inequality)', () => {
    applyRowsToCache(db, [scopeRow(1_000), charRow(1_000, 2)])
    applyRowsToCache(db, [charRow(1_000, 99)])
    const conn = db.getConnection()
    const row = conn.prepare('SELECT count FROM typing_char_minute').get() as { count: number }
    expect(row.count).toBe(2)
  })

  it('replaces payload when updated_at is strictly newer', () => {
    applyRowsToCache(db, [scopeRow(1_000), charRow(1_000, 2)])
    applyRowsToCache(db, [charRow(2_000, 7)])
    const conn = db.getConnection()
    const row = conn.prepare('SELECT count FROM typing_char_minute').get() as { count: number }
    expect(row.count).toBe(7)
  })

  it('propagates is_deleted via the merge path', () => {
    applyRowsToCache(db, [scopeRow(1_000), matrixRow(1_000, 5, 3, 2)])
    const tombstone: JsonlRow = {
      ...matrixRow(2_000, 0, 0, 0),
      is_deleted: true,
    }
    applyRowsToCache(db, [tombstone])
    const conn = db.getConnection()
    const row = conn.prepare('SELECT is_deleted FROM typing_matrix_minute').get() as { is_deleted: number }
    expect(row.is_deleted).toBe(1)
  })

  it('expands a bigram-minute row into per-pair rows in typing_bigram_minute', () => {
    const rows: JsonlRow[] = [
      scopeRow(1_000),
      bigramRow(1_000, {
        '4_11': { c: 3, h: [0, 1, 2, 0, 0, 0, 0, 0] },
        '22_22': { c: 7, h: [0, 0, 0, 0, 7, 0, 0, 0] },
      }),
    ]
    const result = applyRowsToCache(db, rows)
    // applyRowsToCache counts JSONL rows applied; per-pair fan-out is internal.
    expect(result.bigramMinutes).toBe(1)
    const conn = db.getConnection()
    const dbRows = conn
      .prepare('SELECT bigram_id, count, hist FROM typing_bigram_minute ORDER BY bigram_id')
      .all() as { bigram_id: string; count: number; hist: Uint8Array }[]
    expect(dbRows).toHaveLength(2)
    const readBucket = (hist: Uint8Array, idx: number): number =>
      Buffer.from(hist.buffer, hist.byteOffset, hist.byteLength).readUInt32LE(idx * 4)
    expect(dbRows[0].bigram_id).toBe('22_22')
    expect(dbRows[0].count).toBe(7)
    expect(dbRows[0].hist.byteLength).toBe(32) // 8 × u32 little-endian
    expect(readBucket(dbRows[0].hist, 4)).toBe(7)
    expect(dbRows[1].bigram_id).toBe('4_11')
    expect(dbRows[1].count).toBe(3)
    // bucket 1 = 1 occurrence, bucket 2 = 2 occurrences
    expect(readBucket(dbRows[1].hist, 1)).toBe(1)
    expect(readBucket(dbRows[1].hist, 2)).toBe(2)
  })

  it('LWW: a stale bigram-minute row does not override a newer aggregate', () => {
    applyRowsToCache(db, [
      scopeRow(1_000),
      bigramRow(2_000, { '4_11': { c: 5, h: [0, 5, 0, 0, 0, 0, 0, 0] } }),
    ])
    // Stale row (older updated_at) — must not override.
    applyRowsToCache(db, [
      bigramRow(1_500, { '4_11': { c: 999, h: [9, 0, 0, 0, 0, 0, 0, 0] } }),
    ])
    const conn = db.getConnection()
    const row = conn.prepare('SELECT count FROM typing_bigram_minute WHERE bigram_id = ?').get('4_11') as { count: number }
    expect(row.count).toBe(5)
  })

  it('expands a trigram-minute row into per-triple rows in typing_trigram_minute', () => {
    const rows: JsonlRow[] = [
      scopeRow(1_000),
      trigramRow(1_000, {
        '4_11_7': { c: 3, h: [0, 1, 2, 0, 0, 0, 0, 0] },
      }),
    ]
    const result = applyRowsToCache(db, rows)
    expect(result.trigramMinutes).toBe(1)
    const conn = db.getConnection()
    const dbRows = conn
      .prepare('SELECT trigram_id, count, hist FROM typing_trigram_minute')
      .all() as { trigram_id: string; count: number; hist: Uint8Array }[]
    expect(dbRows).toHaveLength(1)
    expect(dbRows[0].trigram_id).toBe('4_11_7')
    expect(dbRows[0].count).toBe(3)
  })

  it('LWW: a stale trigram-minute row does not override a newer aggregate', () => {
    applyRowsToCache(db, [
      scopeRow(1_000),
      trigramRow(2_000, { '4_11_7': { c: 5, h: [0, 5, 0, 0, 0, 0, 0, 0] } }),
    ])
    applyRowsToCache(db, [
      trigramRow(1_500, { '4_11_7': { c: 999, h: [9, 0, 0, 0, 0, 0, 0, 0] } }),
    ])
    const conn = db.getConnection()
    const row = conn.prepare('SELECT count FROM typing_trigram_minute WHERE trigram_id = ?').get('4_11_7') as { count: number }
    expect(row.count).toBe(5)
  })

  it('returns zero counters when given an empty batch', () => {
    expect(applyRowsToCache(db, [])).toEqual({
      scopes: 0,
      charMinutes: 0,
      matrixMinutes: 0,
      minuteStats: 0,
      sessions: 0,
      bigramMinutes: 0,
      trigramMinutes: 0,
    })
  })
})
