// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest'
import type {
  TypingBksMinuteRow,
  TypingMinuteStatsRow,
} from '../../../../shared/types/typing-analytics'
import { buildBksRateBuckets } from '../analyze-error-proxy'

const MINUTE = 60_000
const HOUR = MINUTE * 60

function bks(minuteMs: number, backspaceCount: number): TypingBksMinuteRow {
  return { minuteMs, backspaceCount }
}
function stats(minuteMs: number, keystrokes: number): TypingMinuteStatsRow {
  return {
    minuteMs,
    keystrokes,
    activeMs: keystrokes * 500,
    intervalMinMs: null,
    intervalP25Ms: null,
    intervalP50Ms: null,
    intervalP75Ms: null,
    intervalMaxMs: null,
  }
}

describe('buildBksRateBuckets', () => {
  const range = { fromMs: 0, toMs: HOUR }

  it('returns empty buckets and null summary when no rows contribute', () => {
    const out = buildBksRateBuckets({ bksRows: [], minuteRows: [], range, bucketMs: MINUTE })
    expect(out.buckets).toEqual([])
    expect(out.summary.totalBackspaces).toBe(0)
    expect(out.summary.totalChars).toBe(0)
    expect(out.summary.overallBksPercent).toBeNull()
  })

  it('computes per-bucket Bksp% using local-time snapping', () => {
    const bksRows: TypingBksMinuteRow[] = [
      bks(0, 10),
      bks(MINUTE * 5, 20),
    ]
    const minuteRows: TypingMinuteStatsRow[] = [
      stats(0, 100),
      stats(MINUTE * 5, 100),
    ]
    const out = buildBksRateBuckets({ bksRows, minuteRows, range, bucketMs: MINUTE * 5 })
    expect(out.buckets).toHaveLength(2)
    expect(out.buckets[0].bksPercent).toBeCloseTo(10)
    expect(out.buckets[1].bksPercent).toBeCloseTo(20)
    expect(out.summary.totalBackspaces).toBe(30)
    expect(out.summary.totalChars).toBe(200)
    expect(out.summary.overallBksPercent).toBeCloseTo(15)
  })

  it('ignores rows outside the range and non-positive counts', () => {
    const bksRows: TypingBksMinuteRow[] = [
      bks(-MINUTE, 100),
      bks(range.toMs + 1, 200),
      bks(MINUTE, 5),
      bks(MINUTE, 0),
    ]
    const minuteRows: TypingMinuteStatsRow[] = [
      stats(MINUTE, 55),
      stats(-MINUTE, 999),
    ]
    const out = buildBksRateBuckets({ bksRows, minuteRows, range, bucketMs: MINUTE })
    expect(out.summary.totalChars).toBe(55)
    expect(out.summary.totalBackspaces).toBe(5)
    expect(out.summary.overallBksPercent).toBeCloseTo((5 / 55) * 100)
  })

  it('buckets each minute independently when bucketMs === MINUTE', () => {
    const bksRows: TypingBksMinuteRow[] = [bks(MINUTE, 50)]
    const minuteRows: TypingMinuteStatsRow[] = [stats(0, 100), stats(MINUTE, 250)]
    const out = buildBksRateBuckets({ bksRows, minuteRows, range, bucketMs: MINUTE })
    expect(out.buckets.map((b) => b.bucketStartMs)).toEqual([0, MINUTE])
    expect(out.buckets[0].bksPercent).toBe(0)
    expect(out.buckets[1].bksPercent).toBeCloseTo((50 / 250) * 100)
  })

  it('handles minutes with Backspace but zero recorded keystrokes gracefully', () => {
    // edge case: bks row without a matching minute-stats row (rare
    // but possible if ingestion races). The bucket still shows up
    // from the bks side but totalChars stays 0 → null percent.
    const out = buildBksRateBuckets({
      bksRows: [bks(MINUTE, 3)],
      minuteRows: [],
      range,
      bucketMs: MINUTE,
    })
    expect(out.buckets).toHaveLength(1)
    expect(out.buckets[0].totalChars).toBe(0)
    expect(out.buckets[0].bksPercent).toBeNull()
  })

  it('returns empty when bucketMs is 0', () => {
    const out = buildBksRateBuckets({
      bksRows: [bks(MINUTE, 1)],
      minuteRows: [stats(MINUTE, 10)],
      range,
      bucketMs: 0,
    })
    expect(out.buckets).toEqual([])
    expect(out.summary.overallBksPercent).toBeNull()
  })
})
