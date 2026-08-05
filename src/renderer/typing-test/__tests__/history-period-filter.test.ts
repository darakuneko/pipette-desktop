// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { cutoffForPeriod, filterResultsByPeriod, PERIOD_FILTERS, DEFAULT_PERIOD_FILTER } from '../history-period-filter'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'

function makeResult(date: string): TypingTestResult {
  return {
    date,
    wpm: 60,
    accuracy: 95,
    wordCount: 30,
    correctChars: 100,
    incorrectChars: 5,
    durationSeconds: 30,
  }
}

const NOW = new Date('2026-08-04T12:00:00.000Z').getTime()

describe('cutoffForPeriod', () => {
  it('returns null for "all" (no lower bound)', () => {
    expect(cutoffForPeriod('all', NOW)).toBeNull()
  })

  it('computes a 7-day cutoff for "1w"', () => {
    expect(cutoffForPeriod('1w', NOW)).toBe(new Date('2026-07-28T12:00:00.000Z').getTime())
  })

  it('computes a calendar-month cutoff for "1m"', () => {
    expect(cutoffForPeriod('1m', NOW)).toBe(new Date('2026-07-04T12:00:00.000Z').getTime())
  })

  it('computes a 3-calendar-month cutoff for "3m"', () => {
    expect(cutoffForPeriod('3m', NOW)).toBe(new Date('2026-05-04T12:00:00.000Z').getTime())
  })

  it('computes a calendar-year cutoff for "1y"', () => {
    expect(cutoffForPeriod('1y', NOW)).toBe(new Date('2025-08-04T12:00:00.000Z').getTime())
  })
})

describe('filterResultsByPeriod', () => {
  it('excludes results dated before the cutoff', () => {
    const results = [
      makeResult('2026-08-01T00:00:00.000Z'), // within 1w
      makeResult('2026-06-01T00:00:00.000Z'), // outside 1w
    ]
    const filtered = filterResultsByPeriod(results, '1w', NOW)
    expect(filtered.map((r) => r.date)).toEqual(['2026-08-01T00:00:00.000Z'])
  })

  it('includes every result for "all", regardless of age', () => {
    const results = [makeResult('2020-01-01T00:00:00.000Z'), makeResult('2026-08-04T00:00:00.000Z')]
    expect(filterResultsByPeriod(results, 'all', NOW)).toEqual(results)
  })

  // Boundary behavior: a result timestamped exactly at the cutoff counts as
  // "within" the window (inclusive), matching the everyday reading of e.g.
  // "the last 7 days" as including the day exactly 7 days ago.
  it('includes a result dated exactly at the cutoff (inclusive boundary)', () => {
    const cutoff = cutoffForPeriod('1w', NOW)!
    const results = [makeResult(new Date(cutoff).toISOString())]
    expect(filterResultsByPeriod(results, '1w', NOW)).toEqual(results)
  })

  it('excludes a result one millisecond before the cutoff', () => {
    const cutoff = cutoffForPeriod('1w', NOW)!
    const results = [makeResult(new Date(cutoff - 1).toISOString())]
    expect(filterResultsByPeriod(results, '1w', NOW)).toEqual([])
  })

  it('drops a result with an unparseable date rather than keeping it', () => {
    const results = [makeResult('not-a-date')]
    expect(filterResultsByPeriod(results, '1w', NOW)).toEqual([])
  })

  it('exposes "1m" as the default period', () => {
    expect(DEFAULT_PERIOD_FILTER).toBe('1m')
  })

  it('orders options oldest-window-first, ending with "all"', () => {
    expect(PERIOD_FILTERS).toEqual(['1w', '1m', '3m', '1y', 'all'])
  })
})
