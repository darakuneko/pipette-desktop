// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest'
import type { TypingMinuteStatsRow, TypingRolloverMinuteRow } from '../../../../shared/types/typing-analytics'
import {
  bucketRolloverMinutes,
  effectiveSamplingPeriod,
  formatRolloverTooltipValue,
  overallRolloverRatio,
  rolloverRatio,
} from '../analyze-rollover'

const MINUTE = 60_000
const HOUR = MINUTE * 60

function rolloverRow(minuteTs: number, oc: number, on: number): TypingRolloverMinuteRow {
  return { minuteTs, oc, on }
}

function statsRow(overrides: Partial<TypingMinuteStatsRow> = {}): TypingMinuteStatsRow {
  return {
    minuteMs: 0,
    keystrokes: 10,
    activeMs: 1_000,
    intervalMinMs: 50,
    intervalP25Ms: 100,
    intervalP50Ms: 150,
    intervalP75Ms: 200,
    intervalMaxMs: 400,
    ...overrides,
  }
}

describe('rolloverRatio (the canonical observed-rollover contract)', () => {
  it('returns null when on is 0, null, or undefined — never poisons on oc', () => {
    expect(rolloverRatio(3, 0)).toBeNull()
    expect(rolloverRatio(0, 0)).toBeNull()
    expect(rolloverRatio(3, null)).toBeNull()
    expect(rolloverRatio(0, undefined)).toBeNull()
  })

  it('returns a real 0 when oc is 0 but on is positive', () => {
    expect(rolloverRatio(0, 5)).toBe(0)
  })

  it('computes oc/on when on is positive', () => {
    expect(rolloverRatio(3, 4)).toBe(0.75)
  })
})

describe('overallRolloverRatio', () => {
  it('returns null for an empty selection', () => {
    expect(overallRolloverRatio([])).toBeNull()
  })

  it('computes Σoc/Σon across every minute', () => {
    const rows = [rolloverRow(0, 3, 5), rolloverRow(MINUTE, 1, 5)]
    expect(overallRolloverRatio(rows)).toBe(4 / 10)
  })

  it('a minute with no overlap data is simply absent, never poisons the ratio', () => {
    // Only one minute row present — the "unobserved" minute would never
    // appear in `rows` in the first place (see the channel's own doc
    // comment), so a mix of contributing/non-contributing minutes still
    // sums correctly.
    const rows = [rolloverRow(0, 3, 5)]
    expect(overallRolloverRatio(rows)).toBe(3 / 5)
  })
})

describe('bucketRolloverMinutes', () => {
  const range = { fromMs: 0, toMs: HOUR }
  // 1h range at 10-min buckets -> 6 bucket-start positions, always
  // present regardless of which ones have contributing rows.
  const allBucketStarts = [0, 10, 20, 30, 40, 50].map((m) => m * MINUTE)

  it('sums oc/on for minutes landing in the same bucket', () => {
    const rows = [rolloverRow(0, 1, 2), rolloverRow(MINUTE, 2, 3)]
    const buckets = bucketRolloverMinutes(rows, range, 10 * MINUTE)
    expect(buckets.map((b) => b.bucketStartMs)).toEqual(allBucketStarts)
    expect(buckets[0]).toEqual({ bucketStartMs: 0, ratio: 3 / 5 })
    // Every other bucket has no contributing row -> null, not 0.
    expect(buckets.slice(1).every((b) => b.ratio === null)).toBe(true)
  })

  it('excludes rows outside the range', () => {
    const rows = [rolloverRow(-MINUTE, 1, 1), rolloverRow(0, 1, 2), rolloverRow(HOUR, 1, 1)]
    const buckets = bucketRolloverMinutes(rows, range, 10 * MINUTE)
    expect(buckets[0]).toEqual({ bucketStartMs: 0, ratio: 1 / 2 })
    expect(buckets.slice(1).every((b) => b.ratio === null)).toBe(true)
  })

  it('fills every bucket position in the display range, sorted ascending, even ones with no data', () => {
    const rows = [rolloverRow(30 * MINUTE, 1, 4), rolloverRow(0, 1, 2)]
    const buckets = bucketRolloverMinutes(rows, range, 10 * MINUTE)
    expect(buckets.map((b) => b.bucketStartMs)).toEqual(allBucketStarts)
  })

  it('produces a null point for an unobserved interior bucket (a gap in the trend line)', () => {
    // Data at bucket 0 and bucket 30min, nothing in between — buckets
    // at 10min/20min must come back as null so recharts (connectNulls
    // false) actually breaks the line there instead of drawing a
    // straight line from bucket 0 all the way to bucket 30min.
    const rows = [rolloverRow(0, 1, 2), rolloverRow(30 * MINUTE, 3, 4)]
    const buckets = bucketRolloverMinutes(rows, range, 10 * MINUTE)
    const byStart = new Map(buckets.map((b) => [b.bucketStartMs, b.ratio]))
    expect(byStart.get(0)).toBe(1 / 2)
    expect(byStart.get(10 * MINUTE)).toBeNull()
    expect(byStart.get(20 * MINUTE)).toBeNull()
    expect(byStart.get(30 * MINUTE)).toBe(3 / 4)
  })

  it('returns an empty array for a non-positive bucket width', () => {
    expect(bucketRolloverMinutes([rolloverRow(0, 1, 1)], range, 0)).toEqual([])
  })
})

describe('formatRolloverTooltipValue', () => {
  it('renders "—" for null, not a fabricated 0.0% — Number(null) coerces to 0 without this guard', () => {
    expect(formatRolloverTooltipValue(null)).toBe('—')
  })

  it('renders "—" for undefined and non-finite input', () => {
    expect(formatRolloverTooltipValue(undefined)).toBe('—')
    expect(formatRolloverTooltipValue(Number.NaN)).toBe('—')
  })

  it('renders a real 0 as "0.0%", distinct from the null case', () => {
    expect(formatRolloverTooltipValue(0)).toBe('0.0%')
  })

  it('renders a finite percent with one decimal', () => {
    expect(formatRolloverTooltipValue(37.55)).toBe('37.5%')
  })
})

describe('effectiveSamplingPeriod', () => {
  it('returns null/null for an empty input', () => {
    expect(effectiveSamplingPeriod([])).toEqual({ medianP50Ms: null, worstP95Ms: null })
  })

  it('takes the median of per-minute p50 and the max (worst) of per-minute p95', () => {
    const rows = [
      statsRow({ pollP50Ms: 10, pollP95Ms: 30 }),
      statsRow({ pollP50Ms: 20, pollP95Ms: 90 }),
      statsRow({ pollP50Ms: 30, pollP95Ms: 40 }),
    ]
    const result = effectiveSamplingPeriod(rows)
    expect(result.medianP50Ms).toBe(20)
    expect(result.worstP95Ms).toBe(90)
  })

  it('skips rows with no poll-gap sample instead of treating them as 0', () => {
    const rows = [
      statsRow({ pollP50Ms: undefined, pollP95Ms: undefined }),
      statsRow({ pollP50Ms: 10, pollP95Ms: 25 }),
    ]
    const result = effectiveSamplingPeriod(rows)
    expect(result.medianP50Ms).toBe(10)
    expect(result.worstP95Ms).toBe(25)
  })

  it('reports null when every row lacks a poll-gap sample', () => {
    const rows = [statsRow({ pollP50Ms: null, pollP95Ms: null })]
    const result = effectiveSamplingPeriod(rows)
    expect(result.medianP50Ms).toBeNull()
    expect(result.worstP95Ms).toBeNull()
  })
})
