// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest'
import type { TypingMinuteStatsRow } from '../../../../shared/types/typing-analytics'
import {
  buildHourOfDayWpm,
  buildWpmTimeSeriesSummary,
  computeWpm,
  formatWpm,
} from '../analyze-wpm'

const MINUTE = 60_000
const HOUR = MINUTE * 60

function row(minuteMs: number, overrides: Partial<TypingMinuteStatsRow> = {}): TypingMinuteStatsRow {
  return {
    minuteMs,
    keystrokes: 50,
    activeMs: 30_000,
    intervalMinMs: null,
    intervalP25Ms: null,
    intervalP50Ms: null,
    intervalP75Ms: null,
    intervalMaxMs: null,
    ...overrides,
  }
}

describe('computeWpm', () => {
  it('matches the classic keystrokes/5/minute formula', () => {
    // 50 keys in 30s = 100 keys/min = 20 WPM
    expect(computeWpm(50, 30_000)).toBeCloseTo(20)
  })
  it('returns 0 for zero or negative activeMs / keystrokes', () => {
    expect(computeWpm(0, 60_000)).toBe(0)
    expect(computeWpm(100, 0)).toBe(0)
    expect(computeWpm(100, -1)).toBe(0)
  })
})

describe('formatWpm', () => {
  it('shows one decimal place', () => {
    expect(formatWpm(42.345)).toBe('42.3')
    expect(formatWpm(0)).toBe('0.0')
  })
  it('returns em-dash for non-finite input', () => {
    expect(formatWpm(Number.NaN)).toBe('—')
    expect(formatWpm(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('buildWpmTimeSeriesSummary', () => {
  const range = { fromMs: 0, toMs: HOUR }
  const bucketMs = MINUTE

  it('returns zero totals and null extrema when no rows contribute', () => {
    const out = buildWpmTimeSeriesSummary({ rows: [], range, bucketMs, minActiveMs: 60_000 })
    expect(out.totalKeystrokes).toBe(0)
    expect(out.activeMs).toBe(0)
    expect(out.overallWpm).toBe(0)
    expect(out.peakWpm).toBeNull()
    expect(out.lowestWpm).toBeNull()
    expect(out.weightedMedianWpm).toBeNull()
  })

  it('sums keystrokes / activeMs and derives the overall WPM from the totals', () => {
    // 300 keys in 90s = 200 keys/min = 40 WPM
    const rows: TypingMinuteStatsRow[] = [
      row(0, { keystrokes: 100, activeMs: 30_000 }),
      row(MINUTE, { keystrokes: 200, activeMs: 60_000 }),
    ]
    const out = buildWpmTimeSeriesSummary({ rows, range, bucketMs, minActiveMs: 1 })
    expect(out.totalKeystrokes).toBe(300)
    expect(out.activeMs).toBe(90_000)
    expect(out.overallWpm).toBeCloseTo(40)
  })

  it('excludes buckets under minActiveMs from peak / lowest / median', () => {
    // 2 buckets qualify (activeMs >= 60_000), 1 trivial bucket below threshold
    // must not drag the figures down.
    const rows: TypingMinuteStatsRow[] = [
      row(0, { keystrokes: 400, activeMs: 60_000 }),       // 80 WPM
      row(MINUTE * 2, { keystrokes: 200, activeMs: 60_000 }), // 40 WPM
      row(MINUTE * 4, { keystrokes: 5, activeMs: 5_000 }),    // 12 WPM, below threshold
    ]
    const out = buildWpmTimeSeriesSummary({ rows, range, bucketMs, minActiveMs: 60_000 })
    expect(out.peakWpm).toBeCloseTo(80)
    expect(out.lowestWpm).toBeCloseTo(40)
  })

  it('weights the median WPM by the bucket keystroke count', () => {
    // 3 big buckets at 40 WPM, 1 small bucket at 100 WPM → median 40.
    const rows: TypingMinuteStatsRow[] = [
      row(0, { keystrokes: 200, activeMs: 60_000 }),        // 40 WPM
      row(MINUTE * 2, { keystrokes: 200, activeMs: 60_000 }), // 40 WPM
      row(MINUTE * 4, { keystrokes: 200, activeMs: 60_000 }), // 40 WPM
      row(MINUTE * 6, { keystrokes: 50, activeMs: 6_000 }),   // 100 WPM but tiny
    ]
    const out = buildWpmTimeSeriesSummary({ rows, range, bucketMs, minActiveMs: 1 })
    expect(out.weightedMedianWpm).toBeCloseTo(40)
  })
})

describe('buildHourOfDayWpm', () => {
  const range = { fromMs: 0, toMs: 86_400_000 }

  it('always returns 24 bins, even when most are empty', () => {
    const out = buildHourOfDayWpm({ rows: [], range, minActiveMs: 60_000 })
    expect(out.bins).toHaveLength(24)
    expect(out.bins.every((b) => b.keystrokes === 0 && b.activeMs === 0 && !b.qualified)).toBe(true)
    expect(out.summary.peakHour).toBeNull()
    expect(out.summary.lowestHour).toBeNull()
    expect(out.summary.activeHours).toBe(0)
  })

  it('aggregates by local hour-of-day and picks peak / lowest respecting the threshold', () => {
    // Two qualifying hours at different WPM, plus one trivial hour below threshold.
    const base = new Date(2026, 3, 21, 0, 0, 0, 0).getTime()
    const hourAt = (hour: number, ks: number, ms: number): TypingMinuteStatsRow =>
      row(base + hour * HOUR, { keystrokes: ks, activeMs: ms })
    const rows: TypingMinuteStatsRow[] = [
      hourAt(9, 400, 60_000),   // 80 WPM
      hourAt(13, 200, 60_000),  // 40 WPM
      hourAt(22, 5, 5_000),     // 12 WPM, below threshold
    ]
    const rangeLocal = { fromMs: base, toMs: base + HOUR * 24 }
    const out = buildHourOfDayWpm({ rows, range: rangeLocal, minActiveMs: 60_000 })
    expect(out.bins[9].wpm).toBeCloseTo(80)
    expect(out.bins[13].wpm).toBeCloseTo(40)
    expect(out.bins[22].qualified).toBe(false)
    expect(out.summary.peakHour?.hour).toBe(9)
    expect(out.summary.lowestHour?.hour).toBe(13)
    expect(out.summary.activeHours).toBe(3)
  })

  it('counts activeHours from any activity, regardless of the threshold', () => {
    const base = new Date(2026, 3, 21, 0, 0, 0, 0).getTime()
    const rangeLocal = { fromMs: base, toMs: base + HOUR * 24 }
    const rows: TypingMinuteStatsRow[] = [
      row(base + 8 * HOUR, { keystrokes: 1, activeMs: 1_000 }),
      row(base + 14 * HOUR, { keystrokes: 100, activeMs: 120_000 }),
    ]
    const out = buildHourOfDayWpm({ rows, range: rangeLocal, minActiveMs: 60_000 })
    expect(out.summary.activeHours).toBe(2)
    expect(out.summary.peakHour?.hour).toBe(14) // only the threshold-meeting hour
  })

  it('ignores rows outside the range', () => {
    const base = new Date(2026, 3, 21, 0, 0, 0, 0).getTime()
    const rangeLocal = { fromMs: base, toMs: base + HOUR * 24 }
    const rows: TypingMinuteStatsRow[] = [
      row(base - HOUR, { keystrokes: 999, activeMs: 120_000 }),           // before
      row(base + HOUR * 25, { keystrokes: 999, activeMs: 120_000 }),      // after
      row(base + 10 * HOUR, { keystrokes: 100, activeMs: 60_000 }),       // inside
    ]
    const out = buildHourOfDayWpm({ rows, range: rangeLocal, minActiveMs: 60_000 })
    expect(out.summary.totalKeystrokes).toBe(100)
    expect(out.summary.activeHours).toBe(1)
  })
})
