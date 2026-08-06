// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  median, shrink, computeTokenTimingStats, evaluateTokenWeakness,
  MIN_TIMING_OBSERVATIONS, SLOWNESS_RATIO_THRESHOLD, STALL_RATE_THRESHOLD, MIN_MISS_COUNT,
} from '../weak-spot-scoring'

describe('median', () => {
  it('is 0 for an empty array', () => {
    expect(median([])).toBe(0)
  })

  it('is the middle value for an odd-length array', () => {
    expect(median([3, 1, 2])).toBe(2)
  })

  it('averages the two middle values for an even-length array', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })

  it('is right-skew-robust: a single extreme high outlier barely moves it, unlike a mean would', () => {
    const values = [100, 100, 100, 100, 100, 100, 100, 100, 100, 5000]
    expect(median(values)).toBe(100)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    expect(mean).toBeGreaterThan(500) // the mean is dragged far from the typical value
  })
})

describe('shrink', () => {
  it('shrinks a low-n estimate toward 0 more than a high-n one, for the same raw value', () => {
    const lowN = shrink(1.0, MIN_TIMING_OBSERVATIONS) // n=15 -> factor 15/30 = 0.5
    const highN = shrink(1.0, 150) // n=150 -> factor 150/165 ≈ 0.909
    expect(lowN).toBeCloseTo(0.5, 5)
    expect(highN).toBeGreaterThan(lowN)
    expect(highN).toBeLessThan(1.0)
  })

  it('approaches (never reaches) the raw value as n grows large', () => {
    const veryHighN = shrink(1.0, 100_000)
    expect(veryHighN).toBeGreaterThan(0.99)
    expect(veryHighN).toBeLessThan(1.0)
  })

  it('is 0 for a 0 raw value regardless of n', () => {
    expect(shrink(0, 1000)).toBe(0)
  })
})

describe('computeTokenTimingStats', () => {
  it('is undefined below the observation floor (n < 15)', () => {
    const intervals = Array(MIN_TIMING_OBSERVATIONS - 1).fill(200)
    expect(computeTokenTimingStats(intervals, 200)).toBeUndefined()
  })

  it('is defined exactly at the observation floor (n === 15)', () => {
    const intervals = Array(MIN_TIMING_OBSERVATIONS).fill(200)
    const stats = computeTokenTimingStats(intervals, 200)
    expect(stats).toBeDefined()
    expect(stats!.n).toBe(15)
  })

  it('computes the stall rate as the share of intervals exceeding 2x the scope median', () => {
    // 15 intervals: 3 at 500ms (2x of 250 scope median, not > threshold —
    // exactly at the boundary is NOT counted, matches STALL_MULTIPLE's
    // strict `>` comparison), 12 at 100ms.
    const intervals = [...Array(3).fill(500), ...Array(12).fill(100)]
    const stats = computeTokenTimingStats(intervals, 250)
    expect(stats!.stallRate).toBe(0) // 500 is not > 2*250=500
  })

  it('counts an interval strictly above 2x the scope median as a stall', () => {
    const intervals = [...Array(3).fill(501), ...Array(12).fill(100)]
    const stats = computeTokenTimingStats(intervals, 250)
    expect(stats!.stallRate).toBeCloseTo(3 / 15, 5)
  })
})

describe('evaluateTokenWeakness — miss signal', () => {
  it('is not weak below MIN_MISS_COUNT with no timing data', () => {
    const v = evaluateTokenWeakness(MIN_MISS_COUNT - 1, undefined, 200)
    expect(v.isWeak).toBe(false)
    expect(v.missWeak).toBe(false)
    expect(v.score).toBe(0)
  })

  it('is weak at exactly MIN_MISS_COUNT', () => {
    const v = evaluateTokenWeakness(MIN_MISS_COUNT, undefined, 200)
    expect(v.isWeak).toBe(true)
    expect(v.missWeak).toBe(true)
    expect(v.score).toBeGreaterThan(0)
  })

  it('a higher miss count produces a higher (but capped/log-scaled) score', () => {
    const low = evaluateTokenWeakness(2, undefined, 200)
    const high = evaluateTokenWeakness(50, undefined, 200)
    expect(high.score).toBeGreaterThan(low.score)
    // log-scaled: going from 2 to 50 misses must not scale the score
    // linearly (25x) — it should be far more modest.
    expect(high.score / low.score).toBeLessThan(5)
  })
})

describe('evaluateTokenWeakness — slowness signal, n-threshold boundary', () => {
  const scopeMedian = 200

  it('n=14 (below floor): never slow-weak regardless of how elevated the ratio would be', () => {
    const intervals = Array(14).fill(scopeMedian * 3) // would be a huge ratio if counted
    const timing = computeTokenTimingStats(intervals, scopeMedian)
    expect(timing).toBeUndefined()
    const v = evaluateTokenWeakness(0, timing, scopeMedian)
    expect(v.isWeak).toBe(false)
    expect(v.slowWeak).toBe(false)
  })

  it('n=15 (at floor) with ratio >= 1.5: slow-weak', () => {
    const intervals = Array(15).fill(scopeMedian * SLOWNESS_RATIO_THRESHOLD)
    const timing = computeTokenTimingStats(intervals, scopeMedian)
    const v = evaluateTokenWeakness(0, timing, scopeMedian)
    expect(v.isWeak).toBe(true)
    expect(v.slowWeak).toBe(true)
  })

  it('n=15 with ratio just under 1.5: not slow-weak', () => {
    const intervals = Array(15).fill(scopeMedian * (SLOWNESS_RATIO_THRESHOLD - 0.01))
    const timing = computeTokenTimingStats(intervals, scopeMedian)
    const v = evaluateTokenWeakness(0, timing, scopeMedian)
    expect(v.slowWeak).toBe(false)
    expect(v.isWeak).toBe(false)
  })
})

describe('evaluateTokenWeakness — stall signal, threshold boundary', () => {
  const scopeMedian = 200

  it('exactly at STALL_RATE_THRESHOLD: stall-weak', () => {
    // 3/15 = 20% exactly.
    const intervals = [...Array(3).fill(scopeMedian * 3), ...Array(12).fill(scopeMedian)]
    const timing = computeTokenTimingStats(intervals, scopeMedian)
    expect(timing!.stallRate).toBeCloseTo(STALL_RATE_THRESHOLD, 5)
    const v = evaluateTokenWeakness(0, timing, scopeMedian)
    expect(v.stallWeak).toBe(true)
    expect(v.isWeak).toBe(true)
  })

  it('just under STALL_RATE_THRESHOLD: not stall-weak', () => {
    // 2/15 ≈ 13.3%
    const intervals = [...Array(2).fill(scopeMedian * 3), ...Array(13).fill(scopeMedian)]
    const timing = computeTokenTimingStats(intervals, scopeMedian)
    expect(timing!.stallRate).toBeLessThan(STALL_RATE_THRESHOLD)
    const v = evaluateTokenWeakness(0, timing, scopeMedian)
    expect(v.stallWeak).toBe(false)
  })
})

describe('evaluateTokenWeakness — shrinkage: a single low-n outlier neither flags nor dominates', () => {
  const scopeMedian = 200

  it('14 normal intervals + 1 extreme outlier at n=15: the MEDIAN stays low, so slowness never flags', () => {
    const intervals = [...Array(14).fill(scopeMedian), scopeMedian * 20]
    const timing = computeTokenTimingStats(intervals, scopeMedian)
    expect(timing!.medianIntervalMs).toBe(scopeMedian) // unmoved by the single outlier
    const v = evaluateTokenWeakness(0, timing, scopeMedian)
    expect(v.slowWeak).toBe(false)
  })

  it('14 normal intervals + 1 extreme outlier at n=15: the stall RATE (1/15 ≈ 6.7%) stays under threshold', () => {
    const intervals = [...Array(14).fill(scopeMedian), scopeMedian * 20]
    const timing = computeTokenTimingStats(intervals, scopeMedian)
    expect(timing!.stallRate).toBeCloseTo(1 / 15, 5)
    const v = evaluateTokenWeakness(0, timing, scopeMedian)
    expect(v.stallWeak).toBe(false)
    expect(v.isWeak).toBe(false)
  })

  it('a genuinely elevated low-n (15) timing signal produces a SMALLER score than the identical signal at high n (150)', () => {
    // Both tokens have the exact same ratio/rate (slightly above 2x the
    // scope median, so both slow-weak and stall-weak fire) — the only
    // difference is sample size — so any score gap is purely shrinkage.
    const lowN = computeTokenTimingStats(Array(15).fill(scopeMedian * 2.01), scopeMedian)
    const highN = computeTokenTimingStats(Array(150).fill(scopeMedian * 2.01), scopeMedian)
    const lowV = evaluateTokenWeakness(0, lowN, scopeMedian)
    const highV = evaluateTokenWeakness(0, highN, scopeMedian)
    expect(lowV.isWeak).toBe(true)
    expect(highV.isWeak).toBe(true)
    expect(lowV.score).toBeGreaterThan(0)
    expect(lowV.score).toBeLessThan(highV.score)
  })
})

describe('evaluateTokenWeakness — combined signals', () => {
  it('miss alone (no timing data at all — e.g. consent off) still activates weakness', () => {
    const v = evaluateTokenWeakness(MIN_MISS_COUNT, undefined, 0)
    expect(v.isWeak).toBe(true)
    expect(v.missWeak).toBe(true)
    expect(v.slowWeak).toBe(false)
    expect(v.stallWeak).toBe(false)
  })

  it('neither miss nor timing crosses its threshold: not weak, score 0', () => {
    const timing = computeTokenTimingStats(Array(20).fill(200), 200) // ratio 1.0, no stalls
    const v = evaluateTokenWeakness(1, timing, 200)
    expect(v.isWeak).toBe(false)
    expect(v.score).toBe(0)
  })

  it('a token weak on BOTH miss and timing gets a higher score than either alone', () => {
    const timing = computeTokenTimingStats(Array(20).fill(200 * 2), 200)
    const missOnly = evaluateTokenWeakness(10, undefined, 200)
    const timingOnly = evaluateTokenWeakness(0, timing, 200)
    const both = evaluateTokenWeakness(10, timing, 200)
    expect(both.score).toBeGreaterThan(missOnly.score)
    expect(both.score).toBeGreaterThan(timingOnly.score)
  })
})
