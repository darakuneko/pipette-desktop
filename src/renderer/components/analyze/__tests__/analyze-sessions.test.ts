// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest'
import type { TypingSessionRow } from '../../../../shared/types/typing-analytics'
import {
  SESSION_HISTOGRAM_BIN_IDS,
  buildSessionHistogram,
  findSessionBinIndex,
} from '../analyze-sessions'

const MINUTE = 60_000
const HOUR = MINUTE * 60

function session(id: string, durationMs: number, startMs = 0): TypingSessionRow {
  return { id, startMs, endMs: startMs + durationMs }
}

describe('findSessionBinIndex', () => {
  it('maps durations to the expected bin id', () => {
    expect(SESSION_HISTOGRAM_BIN_IDS[findSessionBinIndex(0)]).toBe('lt5Min')
    expect(SESSION_HISTOGRAM_BIN_IDS[findSessionBinIndex(5 * MINUTE)]).toBe('5to15Min')
    expect(SESSION_HISTOGRAM_BIN_IDS[findSessionBinIndex(20 * MINUTE)]).toBe('15to30Min')
    expect(SESSION_HISTOGRAM_BIN_IDS[findSessionBinIndex(45 * MINUTE)]).toBe('30to60Min')
    expect(SESSION_HISTOGRAM_BIN_IDS[findSessionBinIndex(90 * MINUTE)]).toBe('1to2Hours')
    expect(SESSION_HISTOGRAM_BIN_IDS[findSessionBinIndex(3 * HOUR)]).toBe('2to4Hours')
    expect(SESSION_HISTOGRAM_BIN_IDS[findSessionBinIndex(5 * HOUR)]).toBe('gtFourHours')
    expect(SESSION_HISTOGRAM_BIN_IDS[findSessionBinIndex(24 * HOUR)]).toBe('gtFourHours')
  })

  it('clamps negative / NaN durations into the shortest bin', () => {
    expect(SESSION_HISTOGRAM_BIN_IDS[findSessionBinIndex(-1)]).toBe('lt5Min')
    expect(SESSION_HISTOGRAM_BIN_IDS[findSessionBinIndex(Number.NaN)]).toBe('lt5Min')
  })
})

describe('buildSessionHistogram', () => {
  it('returns empty histogram and null summary extrema for no rows', () => {
    const out = buildSessionHistogram([])
    expect(out.summary.sessionCount).toBe(0)
    expect(out.summary.totalDurationMs).toBe(0)
    expect(out.summary.meanDurationMs).toBeNull()
    expect(out.summary.medianDurationMs).toBeNull()
    expect(out.summary.longestDurationMs).toBeNull()
    expect(out.summary.shortestDurationMs).toBeNull()
    expect(out.bins.every((b) => b.count === 0 && b.share === 0)).toBe(true)
  })

  it('bins sessions by duration and computes share', () => {
    const rows: TypingSessionRow[] = [
      session('a', 2 * MINUTE),
      session('b', 3 * MINUTE),
      session('c', 10 * MINUTE),
      session('d', 90 * MINUTE),
    ]
    const out = buildSessionHistogram(rows)
    expect(out.bins.find((b) => b.id === 'lt5Min')?.count).toBe(2)
    expect(out.bins.find((b) => b.id === '5to15Min')?.count).toBe(1)
    expect(out.bins.find((b) => b.id === '1to2Hours')?.count).toBe(1)
    expect(out.bins.find((b) => b.id === 'lt5Min')?.share).toBeCloseTo(0.5)
    expect(out.summary.sessionCount).toBe(4)
  })

  it('computes mean / median / longest / shortest on the real durations', () => {
    const rows: TypingSessionRow[] = [
      session('a', 5 * MINUTE),
      session('b', 10 * MINUTE),
      session('c', 20 * MINUTE),
    ]
    const out = buildSessionHistogram(rows)
    // mean = (5 + 10 + 20) / 3 = 11.66... min
    expect(out.summary.meanDurationMs).toBeCloseTo(((5 + 10 + 20) / 3) * MINUTE)
    expect(out.summary.medianDurationMs).toBe(10 * MINUTE)
    expect(out.summary.longestDurationMs).toBe(20 * MINUTE)
    expect(out.summary.shortestDurationMs).toBe(5 * MINUTE)
    expect(out.summary.totalDurationMs).toBe(35 * MINUTE)
  })

  it('returns the average of the middle two for even-sized samples', () => {
    const rows: TypingSessionRow[] = [
      session('a', 4 * MINUTE),
      session('b', 6 * MINUTE),
      session('c', 10 * MINUTE),
      session('d', 20 * MINUTE),
    ]
    const out = buildSessionHistogram(rows)
    expect(out.summary.medianDurationMs).toBe((6 * MINUTE + 10 * MINUTE) / 2)
  })

  it('drops sessions with non-positive or non-finite duration', () => {
    const rows: TypingSessionRow[] = [
      session('ok', 5 * MINUTE),
      { id: 'zero', startMs: 100, endMs: 100 },
      { id: 'neg', startMs: 200, endMs: 100 },
      { id: 'nan', startMs: Number.NaN, endMs: 100 },
    ]
    const out = buildSessionHistogram(rows)
    expect(out.summary.sessionCount).toBe(1)
    expect(out.summary.shortestDurationMs).toBe(5 * MINUTE)
  })
})
