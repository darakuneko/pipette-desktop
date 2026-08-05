// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { aggregateWpmByDay } from '../wpm-daily-trend'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'

/** Builds an ISO timestamp string from LOCAL date/time components (as
 *  opposed to a hand-written `...Z` UTC literal), so a test asserting
 *  "these three times are the same/different local calendar day" holds
 *  regardless of which timezone the test runner's machine is in — a
 *  literal like `T23:00:00.000Z` reads as a different local day in any
 *  timezone ahead of UTC by more than 1 hour (e.g. JST, UTC+9). */
function localISO(y: number, m: number, d: number, h: number, mi = 0): string {
  return new Date(y, m - 1, d, h, mi, 0).toISOString()
}

function makeResult(overrides: Partial<TypingTestResult> = {}): TypingTestResult {
  return {
    date: '2026-06-20T00:00:00.000Z',
    wpm: 60,
    accuracy: 95,
    wordCount: 30,
    correctChars: 300,
    incorrectChars: 5,
    durationSeconds: 30,
    ...overrides,
  }
}

describe('aggregateWpmByDay', () => {
  it('returns an empty array for no results', () => {
    expect(aggregateWpmByDay([])).toEqual([])
  })

  it('groups multiple results on the same local day into one point with best/worst/avg', () => {
    const results = [
      makeResult({ date: localISO(2026, 6, 20, 1), wpm: 50 }),
      makeResult({ date: localISO(2026, 6, 20, 12), wpm: 90 }),
      makeResult({ date: localISO(2026, 6, 20, 23), wpm: 70 }),
    ]
    const points = aggregateWpmByDay(results)
    expect(points).toHaveLength(1)
    expect(points[0].best).toBe(90)
    expect(points[0].worst).toBe(50)
    expect(points[0].avg).toBeCloseTo(70, 5)
    expect(points[0].count).toBe(3)
  })

  it('a single-result day has best === worst === avg', () => {
    const points = aggregateWpmByDay([makeResult({ date: '2026-06-20T10:00:00.000Z', wpm: 42 })])
    expect(points).toHaveLength(1)
    expect(points[0].best).toBe(42)
    expect(points[0].worst).toBe(42)
    expect(points[0].avg).toBe(42)
    expect(points[0].count).toBe(1)
  })

  it('sorts distinct days ascending by day, regardless of input order', () => {
    const results = [
      makeResult({ date: '2026-06-22T00:00:00.000Z', wpm: 65 }),
      makeResult({ date: '2026-06-20T00:00:00.000Z', wpm: 60 }),
      makeResult({ date: '2026-06-21T00:00:00.000Z', wpm: 70 }),
    ]
    const points = aggregateWpmByDay(results)
    expect(points.map((p) => p.best)).toEqual([60, 70, 65])
    // Each dayStartMs must be strictly increasing in the output.
    expect(points[0].dayStartMs).toBeLessThan(points[1].dayStartMs)
    expect(points[1].dayStartMs).toBeLessThan(points[2].dayStartMs)
  })

  it('keeps days with no results absent — output length equals the number of distinct days with data', () => {
    const results = [
      makeResult({ date: '2026-06-20T00:00:00.000Z', wpm: 60 }),
      // Gap: no results on 06-21.
      makeResult({ date: '2026-06-22T00:00:00.000Z', wpm: 65 }),
    ]
    const points = aggregateWpmByDay(results)
    expect(points).toHaveLength(2)
  })

  it('rounds the daily average to one decimal place', () => {
    const results = [
      makeResult({ date: '2026-06-20T01:00:00.000Z', wpm: 60 }),
      makeResult({ date: '2026-06-20T02:00:00.000Z', wpm: 61 }),
      makeResult({ date: '2026-06-20T03:00:00.000Z', wpm: 61 }),
    ]
    const points = aggregateWpmByDay(results)
    // (60 + 61 + 61) / 3 = 60.666... -> 60.7
    expect(points[0].avg).toBe(60.7)
  })

  it('drops results with an unparseable date rather than crashing', () => {
    const results = [
      makeResult({ date: 'not-a-date', wpm: 999 }),
      makeResult({ date: '2026-06-20T00:00:00.000Z', wpm: 60 }),
    ]
    const points = aggregateWpmByDay(results)
    expect(points).toHaveLength(1)
    expect(points[0].best).toBe(60)
  })
})
