// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  bigramMinuteRowId,
  charMinuteRowId,
  matrixMinuteRowId,
  minuteStatsRowId,
  parseRow,
  scopeRowId,
  serializeRow,
  sessionRowId,
  type JsonlRow,
} from '../jsonl-row'

describe('composite id builders', () => {
  it('urlencodes scope ids so pipe-containing tokens do not collide', () => {
    expect(scopeRowId('hash|linux|uid')).toBe('scope|hash%7Clinux%7Cuid')
  })

  it('distinguishes char rows that differ only by character', () => {
    expect(charMinuteRowId('s', 60_000, 'a')).toBe('char|s|60000|a')
    expect(charMinuteRowId('s', 60_000, '|')).toBe('char|s|60000|%7C')
    expect(charMinuteRowId('s', 60_000, 'a')).not.toBe(charMinuteRowId('s', 60_000, 'b'))
  })

  it('includes row/col/layer in matrix row ids', () => {
    expect(matrixMinuteRowId('s', 60_000, 2, 3, 1)).toBe('matrix|s|60000|2|3|1')
  })

  it('builds stats and session row ids', () => {
    expect(minuteStatsRowId('s', 60_000)).toBe('stats|s|60000')
    expect(sessionRowId('uuid-123')).toBe('session|uuid-123')
  })

  it('builds bigram-minute row ids without per-pair suffix (one row per minute)', () => {
    expect(bigramMinuteRowId('s', 60_000)).toBe('bigram|s|60000')
  })
})

describe('serializeRow / parseRow round-trip', () => {
  const scope: JsonlRow = {
    id: scopeRowId('scope-1'),
    kind: 'scope',
    updated_at: 1_000,
    payload: {
      id: 'scope-1',
      machineHash: 'hash-a',
      osPlatform: 'linux',
      osRelease: '6.8.0',
      osArch: 'x64',
      keyboardUid: '0xAABB',
      keyboardVendorId: 0xFEED,
      keyboardProductId: 0x0001,
      keyboardProductName: 'Pipette',
    },
  }

  it('emits a single newline-terminated JSON line', () => {
    const line = serializeRow(scope)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.split('\n').filter(Boolean).length).toBe(1)
  })

  it('round-trips every row kind', () => {
    const rows: JsonlRow[] = [
      scope,
      {
        id: charMinuteRowId('scope-1', 60_000, 'a'),
        kind: 'char-minute',
        updated_at: 2_000,
        payload: { scopeId: 'scope-1', minuteTs: 60_000, char: 'a', count: 3 },
      },
      {
        id: matrixMinuteRowId('scope-1', 60_000, 1, 2, 0),
        kind: 'matrix-minute',
        updated_at: 2_000,
        payload: {
          scopeId: 'scope-1',
          minuteTs: 60_000,
          row: 1,
          col: 2,
          layer: 0,
          keycode: 0x04,
          count: 5,
          tapCount: 3,
          holdCount: 2,
        },
      },
      {
        id: minuteStatsRowId('scope-1', 60_000),
        kind: 'minute-stats',
        updated_at: 2_000,
        payload: {
          scopeId: 'scope-1',
          minuteTs: 60_000,
          keystrokes: 10,
          activeMs: 5_000,
          intervalAvgMs: 500,
          intervalMinMs: 300,
          intervalP25Ms: 400,
          intervalP50Ms: 500,
          intervalP75Ms: 600,
          intervalMaxMs: 700,
        },
      },
      {
        id: sessionRowId('uuid-1'),
        kind: 'session',
        updated_at: 2_000,
        payload: { id: 'uuid-1', scopeId: 'scope-1', startMs: 1_000, endMs: 2_000 },
      },
      {
        id: bigramMinuteRowId('scope-1', 60_000),
        kind: 'bigram-minute',
        updated_at: 2_000,
        payload: {
          scopeId: 'scope-1',
          minuteTs: 60_000,
          bigrams: {
            '4_11': { c: 10, h: [1, 0, 0, 2, 3, 1, 2, 1] },
            '22_22': { c: 20, h: [2, 3, 5, 4, 3, 2, 1, 0] },
          },
        },
      },
    ]
    for (const row of rows) {
      const line = serializeRow(row).trimEnd()
      expect(parseRow(line)).toEqual(row)
    }
  })

  it('round-trips a bigram-minute row with an empty pair set', () => {
    // Empty bigrams shouldn't actually be emitted (the service skips
    // size === 0), but the parser must accept it cleanly so a manual
    // edit / migration tooling doesn't trip the validator.
    const empty: JsonlRow = {
      id: bigramMinuteRowId('scope-1', 60_000),
      kind: 'bigram-minute',
      updated_at: 1,
      payload: { scopeId: 'scope-1', minuteTs: 60_000, bigrams: {} },
    }
    expect(parseRow(serializeRow(empty).trimEnd())).toEqual(empty)
  })

  it('preserves is_deleted when set', () => {
    const tombstoned: JsonlRow = {
      id: charMinuteRowId('scope-1', 60_000, 'a'),
      kind: 'char-minute',
      updated_at: 9_000,
      is_deleted: true,
      payload: { scopeId: 'scope-1', minuteTs: 60_000, char: 'a', count: 0 },
    }
    expect(parseRow(serializeRow(tombstoned).trimEnd())).toEqual(tombstoned)
  })
})

describe('parseRow rejections', () => {
  it('returns null for malformed JSON', () => {
    expect(parseRow('{ not json')).toBeNull()
    expect(parseRow('')).toBeNull()
  })

  it('returns null for unknown kinds', () => {
    const line = JSON.stringify({
      id: 'x|1',
      kind: 'mystery',
      updated_at: 1,
      payload: {},
    })
    expect(parseRow(line)).toBeNull()
  })

  it('returns null when required payload fields are missing', () => {
    const line = JSON.stringify({
      id: 'char|s|60000|a',
      kind: 'char-minute',
      updated_at: 1,
      payload: { scopeId: 's', minuteTs: 60_000 },
    })
    expect(parseRow(line)).toBeNull()
  })

  it('returns null when updated_at is not numeric', () => {
    const line = JSON.stringify({
      id: 'stats|s|60000',
      kind: 'minute-stats',
      updated_at: 'soon',
      payload: {
        scopeId: 's',
        minuteTs: 60_000,
        keystrokes: 1,
        activeMs: 1,
        intervalAvgMs: null,
        intervalMinMs: null,
        intervalP25Ms: null,
        intervalP50Ms: null,
        intervalP75Ms: null,
        intervalMaxMs: null,
      },
    })
    expect(parseRow(line)).toBeNull()
  })

  it('returns null for a bigram-minute row with a histogram of the wrong length', () => {
    const line = JSON.stringify({
      id: 'bigram|s|60000',
      kind: 'bigram-minute',
      updated_at: 1,
      payload: {
        scopeId: 's',
        minuteTs: 60_000,
        bigrams: { '4_11': { c: 1, h: [1, 0, 0] } }, // expected 8 buckets
      },
    })
    expect(parseRow(line)).toBeNull()
  })

  it('returns null for a bigram-minute row with non-finite histogram values', () => {
    const line = JSON.stringify({
      id: 'bigram|s|60000',
      kind: 'bigram-minute',
      updated_at: 1,
      payload: {
        scopeId: 's',
        minuteTs: 60_000,
        bigrams: { '4_11': { c: 1, h: [1, 0, 0, 0, 0, 0, 0, null] } },
      },
    })
    expect(parseRow(line)).toBeNull()
  })

  it('returns null for a bigram-minute row missing scopeId', () => {
    const line = JSON.stringify({
      id: 'bigram|s|60000',
      kind: 'bigram-minute',
      updated_at: 1,
      payload: {
        minuteTs: 60_000,
        bigrams: { '4_11': { c: 1, h: [1, 0, 0, 0, 0, 0, 0, 0] } },
      },
    })
    expect(parseRow(line)).toBeNull()
  })

  it('accepts minute-stats with null interval fields', () => {
    const line = JSON.stringify({
      id: 'stats|s|60000',
      kind: 'minute-stats',
      updated_at: 1,
      payload: {
        scopeId: 's',
        minuteTs: 60_000,
        keystrokes: 1,
        activeMs: 1,
        intervalAvgMs: null,
        intervalMinMs: null,
        intervalP25Ms: null,
        intervalP50Ms: null,
        intervalP75Ms: null,
        intervalMaxMs: null,
      },
    })
    expect(parseRow(line)).not.toBeNull()
  })
})
