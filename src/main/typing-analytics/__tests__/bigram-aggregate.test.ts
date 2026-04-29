// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  aggregatePairTotals,
  avgIkiFromHist,
  percentileFromHist,
  rankBigramsByCount,
  rankBigramsBySlow,
  type BigramPairTotal,
} from '../bigram-aggregate'
import type { BigramMinuteCellRow } from '../db/typing-analytics-db'

function row(bigramId: string, count: number, hist: number[], minuteTs = 60_000): BigramMinuteCellRow {
  return { bigramId, minuteTs, count, hist }
}

function totals(entries: { bigramId: string; count: number; hist: number[] }[]): Map<string, BigramPairTotal> {
  const map = new Map<string, BigramPairTotal>()
  for (const e of entries) map.set(e.bigramId, { ...e })
  return map
}

describe('aggregatePairTotals', () => {
  it('returns an empty map for an empty input', () => {
    expect(aggregatePairTotals([]).size).toBe(0)
  })

  it('sums count and hist element-wise across rows for the same pair', () => {
    const map = aggregatePairTotals([
      row('4_11', 2, [1, 1, 0, 0, 0, 0, 0, 0]),
      row('4_11', 3, [0, 2, 1, 0, 0, 0, 0, 0]),
    ])
    const e = map.get('4_11')!
    expect(e.count).toBe(5)
    expect(e.hist).toEqual([1, 3, 1, 0, 0, 0, 0, 0])
  })

  it('keeps separate entries for different pairs in mixed order', () => {
    const map = aggregatePairTotals([
      row('A', 1, [1, 0, 0, 0, 0, 0, 0, 0]),
      row('B', 2, [0, 2, 0, 0, 0, 0, 0, 0]),
      row('A', 4, [3, 1, 0, 0, 0, 0, 0, 0]),
    ])
    expect(map.get('A')).toEqual({ bigramId: 'A', count: 5, hist: [4, 1, 0, 0, 0, 0, 0, 0] })
    expect(map.get('B')).toEqual({ bigramId: 'B', count: 2, hist: [0, 2, 0, 0, 0, 0, 0, 0] })
  })
})

describe('avgIkiFromHist', () => {
  it('returns null for an empty histogram', () => {
    expect(avgIkiFromHist([0, 0, 0, 0, 0, 0, 0, 0])).toBeNull()
  })

  it('uses the bucket center for a single-bucket histogram', () => {
    // Bucket 1 (60-100) center is 80.
    expect(avgIkiFromHist([0, 5, 0, 0, 0, 0, 0, 0])).toBe(80)
  })

  it('weights centers by count for multi-bucket histograms', () => {
    // Bucket 0 (center 30) × 2, bucket 4 (center 250) × 2 → avg = (60 + 500) / 4 = 140.
    expect(avgIkiFromHist([2, 0, 0, 0, 2, 0, 0, 0])).toBe(140)
  })
})

describe('percentileFromHist', () => {
  it('returns null for an empty histogram', () => {
    expect(percentileFromHist([0, 0, 0, 0, 0, 0, 0, 0], 0.5)).toBeNull()
  })

  it('returns a value in the bucket containing the cumulative target', () => {
    // 4 samples in bucket 1 (60-100). p50 → 60 + 0.5 * (100-60) = 80.
    expect(percentileFromHist([0, 4, 0, 0, 0, 0, 0, 0], 0.5)).toBe(80)
  })

  it('synthesizes a span for the open-ended last bucket', () => {
    // 1 sample in bucket 7 (≥1000). Synthetic upper = 2 * center - lower = 2 * 1500 - 1000 = 2000.
    // p50 → 1000 + 0.5 * (2000 - 1000) = 1500.
    expect(percentileFromHist([0, 0, 0, 0, 0, 0, 0, 1], 0.5)).toBe(1500)
  })

  it('crosses bucket boundaries when the cumulative count grows', () => {
    // [2 in b0, 2 in b1]. Total=4. p75 target=3 lands inside b1.
    // After b0 (acc=2), b1 has c=2, acc+c=4 >= 3. fraction=(3-2)/2=0.5.
    // Range b1 = [60, 100). Result = 60 + 0.5 * 40 = 80.
    expect(percentileFromHist([2, 2, 0, 0, 0, 0, 0, 0], 0.75)).toBe(80)
  })
})

describe('rankBigramsByCount', () => {
  it('sorts pairs by count descending and applies the limit', () => {
    const map = totals([
      { bigramId: 'A', count: 5, hist: [5, 0, 0, 0, 0, 0, 0, 0] },
      { bigramId: 'B', count: 10, hist: [0, 10, 0, 0, 0, 0, 0, 0] },
      { bigramId: 'C', count: 1, hist: [0, 0, 1, 0, 0, 0, 0, 0] },
    ])
    expect(rankBigramsByCount(map, 2).map((e) => e.bigramId)).toEqual(['B', 'A'])
  })

  it('breaks ties by bigramId ascending so output is deterministic', () => {
    const map = totals([
      { bigramId: 'B', count: 3, hist: [3, 0, 0, 0, 0, 0, 0, 0] },
      { bigramId: 'A', count: 3, hist: [0, 0, 3, 0, 0, 0, 0, 0] },
    ])
    expect(rankBigramsByCount(map, 5).map((e) => e.bigramId)).toEqual(['A', 'B'])
  })

  it('attaches avgIki computed from each pair hist', () => {
    const map = totals([
      { bigramId: 'A', count: 1, hist: [1, 0, 0, 0, 0, 0, 0, 0] },
    ])
    const [entry] = rankBigramsByCount(map, 5)
    expect(entry.avgIki).toBe(30) // bucket 0 center
  })
})

describe('rankBigramsBySlow', () => {
  it('drops pairs below minSampleCount', () => {
    const map = totals([
      // Slow pair but only 1 sample → should be dropped at minSample=5.
      { bigramId: 'low', count: 1, hist: [0, 0, 0, 0, 0, 0, 0, 1] },
      // Fast pair with enough samples → kept.
      { bigramId: 'kept', count: 5, hist: [5, 0, 0, 0, 0, 0, 0, 0] },
    ])
    const ranked = rankBigramsBySlow(map, 5, 5)
    expect(ranked.map((e) => e.bigramId)).toEqual(['kept'])
  })

  it('orders by avg IKI descending', () => {
    const map = totals([
      // Fast (avg ~30)
      { bigramId: 'A', count: 5, hist: [5, 0, 0, 0, 0, 0, 0, 0] },
      // Slow (avg ~1500)
      { bigramId: 'B', count: 5, hist: [0, 0, 0, 0, 0, 0, 0, 5] },
      // Medium (avg ~250)
      { bigramId: 'C', count: 5, hist: [0, 0, 0, 0, 5, 0, 0, 0] },
    ])
    expect(rankBigramsBySlow(map, 5, 5).map((e) => e.bigramId)).toEqual(['B', 'C', 'A'])
  })

  it('attaches p95 computed from each pair hist', () => {
    const map = totals([
      // 4 samples in bucket 0, 1 in bucket 7. p95 of 5 samples = target 4.75 — lands in b7.
      { bigramId: 'A', count: 5, hist: [4, 0, 0, 0, 0, 0, 0, 1] },
    ])
    const [entry] = rankBigramsBySlow(map, 5, 5)
    expect(entry.p95).not.toBeNull()
    expect(entry.p95).toBeGreaterThan(1000)
  })

  it('returns an empty array when no pair meets minSample', () => {
    const map = totals([{ bigramId: 'x', count: 1, hist: [1, 0, 0, 0, 0, 0, 0, 0] }])
    expect(rankBigramsBySlow(map, 5, 5)).toEqual([])
  })
})
