// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest'
import type { TypingMinuteStatsRow } from '../../../../shared/types/typing-analytics'
import { bucketMinuteStats, pickBucketMs } from '../analyze-bucket'

const MINUTE = 60_000
const HOUR = MINUTE * 60
const DAY = HOUR * 24

function row(
  minuteMs: number,
  overrides: Partial<TypingMinuteStatsRow> = {},
): TypingMinuteStatsRow {
  return {
    minuteMs,
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

describe('pickBucketMs', () => {
  it('returns at least one minute even for trivially small ranges', () => {
    expect(pickBucketMs({ fromMs: 0, toMs: 60_000 })).toBeGreaterThanOrEqual(MINUTE)
  })

  it('snaps to the nearest entry in the granularity table', () => {
    // 6 h window with the 40-point default → raw = 540_000 ms (9 min),
    // which is closer to the 10-min granularity than to 5 min.
    const out = pickBucketMs({ fromMs: 0, toMs: HOUR * 6 })
    expect(out).toBe(MINUTE * 10)
  })

  it('scales up for longer ranges', () => {
    const hourly = pickBucketMs({ fromMs: 0, toMs: HOUR })
    const daily = pickBucketMs({ fromMs: 0, toMs: DAY })
    const weekly = pickBucketMs({ fromMs: 0, toMs: DAY * 7 })
    expect(daily).toBeGreaterThan(hourly)
    expect(weekly).toBeGreaterThan(daily)
  })
})

describe('bucketMinuteStats', () => {
  const range = { fromMs: 0, toMs: HOUR }

  it('sums keystrokes / activeMs and takes MIN / MAX for interval envelope', () => {
    const rows = [
      row(0, { keystrokes: 5, activeMs: 500, intervalMinMs: 30, intervalMaxMs: 500 }),
      row(MINUTE, { keystrokes: 7, activeMs: 600, intervalMinMs: 80, intervalMaxMs: 300 }),
    ]
    const [b] = bucketMinuteStats(rows, range, 10 * MINUTE)
    expect(b).toMatchObject({
      bucketStartMs: 0,
      keystrokes: 12,
      activeMs: 1_100,
      intervalMinMs: 30,
      intervalMaxMs: 500,
    })
  })

  it('averages interval quartiles unweighted across contributing rows', () => {
    const rows = [
      row(0, { intervalP50Ms: 100 }),
      row(MINUTE, { intervalP50Ms: 200 }),
      row(MINUTE * 2, { intervalP50Ms: null }),
    ]
    const [b] = bucketMinuteStats(rows, range, 10 * MINUTE)
    expect(b.intervalP50Ms).toBe(150)
  })

  it('drops rows outside the range', () => {
    const rows = [row(-MINUTE), row(0), row(range.toMs)]
    const out = bucketMinuteStats(rows, range, 10 * MINUTE)
    expect(out).toHaveLength(1)
    expect(out[0].bucketStartMs).toBe(0)
  })

  it('produces one bucket per bucketMs slot anchored at fromMs', () => {
    const rows = [row(0), row(MINUTE * 15), row(MINUTE * 30)]
    const out = bucketMinuteStats(rows, range, 10 * MINUTE)
    expect(out.map((b) => b.bucketStartMs)).toEqual([0, 10 * MINUTE, 30 * MINUTE])
  })
})
