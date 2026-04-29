// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest'
import type { TypingMinuteStatsRow } from '../../../../shared/types/typing-analytics'
import { formatActiveDuration } from '../analyze-format'
import {
  HISTOGRAM_BIN_IDS,
  buildIntervalHistogram,
  buildIntervalTimeSeriesSummary,
  findBinIndex,
} from '../analyze-histogram'

const MINUTE = 60_000

function row(
  minuteMs: number,
  overrides: Partial<TypingMinuteStatsRow> = {},
): TypingMinuteStatsRow {
  return {
    minuteMs,
    keystrokes: 40,
    activeMs: 1_000,
    intervalMinMs: 40,
    intervalP25Ms: 80,
    intervalP50Ms: 150,
    intervalP75Ms: 300,
    intervalMaxMs: 1_200,
    ...overrides,
  }
}

describe('findBinIndex', () => {
  it('routes intervals to the expected bin ids', () => {
    expect(HISTOGRAM_BIN_IDS[findBinIndex(30)]).toBe('lt50')
    expect(HISTOGRAM_BIN_IDS[findBinIndex(50)]).toBe('50to100')
    expect(HISTOGRAM_BIN_IDS[findBinIndex(250)]).toBe('200to500')
    expect(HISTOGRAM_BIN_IDS[findBinIndex(9_999)]).toBe('5000to10000')
    expect(HISTOGRAM_BIN_IDS[findBinIndex(10_000)]).toBe('gt10000')
    expect(HISTOGRAM_BIN_IDS[findBinIndex(60_000)]).toBe('gt10000')
  })

  it('clamps negative / NaN inputs into the fastest bin', () => {
    expect(HISTOGRAM_BIN_IDS[findBinIndex(-1)]).toBe('lt50')
    expect(HISTOGRAM_BIN_IDS[findBinIndex(Number.NaN)]).toBe('lt50')
  })
})

describe('buildIntervalHistogram', () => {
  const range = { fromMs: 0, toMs: MINUTE * 10 }

  it('returns an all-zero histogram when no rows contribute', () => {
    const out = buildIntervalHistogram([], range)
    expect(out.totalWeight).toBe(0)
    expect(out.bins.every((b) => b.weight === 0)).toBe(true)
    expect(out.summary.totalKeystrokes).toBe(0)
    expect(out.summary.weightedMedianP50Ms).toBeNull()
    expect(out.summary.longestPauseMs).toBeNull()
  })

  it('drops one row sample per quartile (min/p25/p50/p75) at weight keystrokes/4', () => {
    const out = buildIntervalHistogram([row(0)], range)
    // 4 quartiles -> 4 bins each get keystrokes/4 = 10
    const expectBin = (id: string, weight: number) => {
      const bin = out.bins.find((b) => b.id === id)
      expect(bin, `bin ${id}`).toBeDefined()
      expect(bin!.weight, `bin ${id}`).toBeCloseTo(weight)
    }
    expectBin('lt50', 10)    // min=40
    expectBin('50to100', 10) // p25=80
    expectBin('100to200', 10) // p50=150
    expectBin('200to500', 10) // p75=300
    expect(out.totalWeight).toBeCloseTo(40)
    // max is excluded from the histogram.
    expect(out.bins.find((b) => b.id === 'gt10000')?.weight).toBe(0)
  })

  it('skips minutes with keystrokes <= 1 (no real interval) and all-null quartiles', () => {
    const out = buildIntervalHistogram([
      row(0, { keystrokes: 1 }),
      row(MINUTE, {
        intervalMinMs: null, intervalP25Ms: null,
        intervalP50Ms: null, intervalP75Ms: null,
      }),
      row(MINUTE * 2), // only this one counts
    ], range)
    expect(out.summary.totalKeystrokes).toBe(40)
    expect(out.totalWeight).toBeCloseTo(40)
  })

  it('ignores rows outside range', () => {
    const out = buildIntervalHistogram([
      row(-MINUTE),          // before
      row(range.toMs + 1),    // after
      row(MINUTE),            // inside
    ], range)
    expect(out.summary.totalKeystrokes).toBe(40)
  })

  it('uses the max of every in-range minute as the longest pause (not histogram)', () => {
    const out = buildIntervalHistogram([
      row(MINUTE, { intervalMaxMs: 500 }),
      row(MINUTE * 2, { intervalMaxMs: 120_000 }),
      row(MINUTE * 3, { intervalMaxMs: null }),
    ], range)
    expect(out.summary.longestPauseMs).toBe(120_000)
    // The 2-minute pause should not show up in the histogram — max is excluded.
    expect(out.bins.find((b) => b.id === 'gt10000')?.weight).toBe(0)
  })

  it('aggregates share bands using bin boundaries that align to band edges', () => {
    // 4 minutes, all quartiles at 150 ms → every sample lands in 100-200ms,
    // so 100% fast share (< 200 ms).
    const flat: TypingMinuteStatsRow[] = [0, MINUTE, MINUTE * 2, MINUTE * 3].map((m) =>
      row(m, { intervalMinMs: 150, intervalP25Ms: 150, intervalP50Ms: 150, intervalP75Ms: 150 }),
    )
    const out = buildIntervalHistogram(flat, range)
    expect(out.summary.fastShare).toBeCloseTo(1)
    expect(out.summary.normalShare).toBeCloseTo(0)
    expect(out.summary.slowShare).toBeCloseTo(0)
    expect(out.summary.pauseShare).toBeCloseTo(0)
  })

  it('weights the median p50 by each minute keystroke count', () => {
    // A rare but very slow minute should not out-vote many fast minutes.
    const rows: TypingMinuteStatsRow[] = [
      ...Array.from({ length: 9 }, (_, i) => row(i * MINUTE, {
        keystrokes: 50, intervalP50Ms: 120,
      })),
      row(MINUTE * 9, { keystrokes: 5, intervalP50Ms: 4_000 }),
    ]
    const out = buildIntervalHistogram(rows, range)
    expect(out.summary.weightedMedianP50Ms).toBe(120)
  })
})

describe('buildIntervalTimeSeriesSummary', () => {
  const range = { fromMs: 0, toMs: MINUTE * 10 }

  it('returns zeros and nulls when no rows contribute', () => {
    const out = buildIntervalTimeSeriesSummary([], range)
    expect(out.totalKeystrokes).toBe(0)
    expect(out.activeMs).toBe(0)
    expect(out.shortestIntervalMs).toBeNull()
    expect(out.longestPauseMs).toBeNull()
    expect(out.weightedMedianP50Ms).toBeNull()
  })

  it('sums keystrokes and activeMs, and picks min / max envelopes across minutes', () => {
    const rows: TypingMinuteStatsRow[] = [
      row(0, { keystrokes: 20, activeMs: 500, intervalMinMs: 30, intervalMaxMs: 200 }),
      row(MINUTE, { keystrokes: 10, activeMs: 300, intervalMinMs: 40, intervalMaxMs: 800 }),
      row(MINUTE * 2, { keystrokes: 5, activeMs: 200, intervalMinMs: 25, intervalMaxMs: 150 }),
    ]
    const out = buildIntervalTimeSeriesSummary(rows, range)
    expect(out.totalKeystrokes).toBe(35)
    expect(out.activeMs).toBe(1_000)
    expect(out.shortestIntervalMs).toBe(25)
    expect(out.longestPauseMs).toBe(800)
  })

  it('clamps negative activeMs at zero and ignores out-of-range rows', () => {
    const rows: TypingMinuteStatsRow[] = [
      row(-MINUTE, { keystrokes: 99, activeMs: 9_999 }), // before
      row(range.toMs + 1, { keystrokes: 99, activeMs: 9_999 }), // after
      row(0, { keystrokes: 10, activeMs: -50 }), // negative clamps to 0
    ]
    const out = buildIntervalTimeSeriesSummary(rows, range)
    expect(out.totalKeystrokes).toBe(10)
    expect(out.activeMs).toBe(0)
  })

  it('skips rows with zero keystrokes', () => {
    const rows: TypingMinuteStatsRow[] = [
      row(0, { keystrokes: 0, activeMs: 1_000, intervalMinMs: 5 }),
      row(MINUTE, { keystrokes: 10, activeMs: 500, intervalMinMs: 40 }),
    ]
    const out = buildIntervalTimeSeriesSummary(rows, range)
    expect(out.totalKeystrokes).toBe(10)
    expect(out.activeMs).toBe(500)
    expect(out.shortestIntervalMs).toBe(40)
  })
})

describe('formatActiveDuration', () => {
  it('renders hours+minutes when at least an hour', () => {
    expect(formatActiveDuration(3_600_000 * 2 + 60_000 * 15)).toBe('2h 15m')
    expect(formatActiveDuration(3_600_000)).toBe('1h 0m')
  })

  it('renders minutes+seconds below one hour', () => {
    expect(formatActiveDuration(60_000 * 5 + 1_000 * 20)).toBe('5m 20s')
    expect(formatActiveDuration(60_000)).toBe('1m 0s')
  })

  it('renders seconds only below a minute', () => {
    expect(formatActiveDuration(45_000)).toBe('45s')
  })

  it('returns 0s for zero / negative / NaN input', () => {
    expect(formatActiveDuration(0)).toBe('0s')
    expect(formatActiveDuration(-100)).toBe('0s')
    expect(formatActiveDuration(Number.NaN)).toBe('0s')
  })
})
