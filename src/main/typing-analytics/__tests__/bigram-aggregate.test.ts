// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  aggregateMatrixDurationTotals,
  aggregatePairTotals,
  avgDurationMsFromTotal,
  avgIkiFromHist,
  durationSdFromTotal,
  observedRolloverRatio,
  percentileFromHist,
  rankBigramsByCount,
  rankBigramsBySlow,
  sdFromSums,
  type BigramPairTotal,
} from '../bigram-aggregate'
import type { MatrixDurationCellRow, NgramMinuteCellRow } from '../db/typing-analytics-db'

function durationRow(
  row: number,
  col: number,
  layer: number,
  hist: number[],
  sum: number,
  sumSq: number,
  minuteTs = 60_000,
): MatrixDurationCellRow {
  return { row, col, layer, minuteTs, hist, sum, sumSq }
}

function row(
  ngramId: string,
  count: number,
  hist: number[],
  minuteTs = 60_000,
  sumIki: number | null = null,
  sumSqIki: number | null = null,
  overlap?: { overlapCount: number | null; overlapN: number | null },
): NgramMinuteCellRow {
  return { ngramId, minuteTs, count, hist, sumIki, sumSqIki, ...overlap }
}

function trigramRow(
  ngramId: string,
  count: number,
  hist: number[],
  minuteTs = 60_000,
  sumIki: number | null = null,
  sumSqIki: number | null = null,
): NgramMinuteCellRow {
  return { ngramId, minuteTs, count, hist, sumIki, sumSqIki }
}

function totals(entries: {
  ngramId: string
  count: number
  hist: number[]
  sumIki?: number | null
  sumSqIki?: number | null
  overlapCount?: number
  overlapN?: number
}[]): Map<string, BigramPairTotal> {
  const map = new Map<string, BigramPairTotal>()
  for (const e of entries) {
    map.set(e.ngramId, {
      ngramId: e.ngramId,
      count: e.count,
      hist: e.hist,
      sumIki: e.sumIki ?? null,
      sumSqIki: e.sumSqIki ?? null,
      overlapCount: e.overlapCount ?? 0,
      overlapN: e.overlapN ?? 0,
    })
  }
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
    expect(map.get('A')).toEqual({
      ngramId: 'A', count: 5, hist: [4, 1, 0, 0, 0, 0, 0, 0], sumIki: null, sumSqIki: null, overlapCount: 0, overlapN: 0,
    })
    expect(map.get('B')).toEqual({
      ngramId: 'B', count: 2, hist: [0, 2, 0, 0, 0, 0, 0, 0], sumIki: null, sumSqIki: null, overlapCount: 0, overlapN: 0,
    })
  })

  it('groups trigram rows by ngramId, reusing the same pipeline as bigrams', () => {
    const map = aggregatePairTotals([
      trigramRow('4_11_7', 1, [1, 0, 0, 0, 0, 0, 0, 0]),
      trigramRow('4_11_7', 1, [0, 1, 0, 0, 0, 0, 0, 0]),
      trigramRow('11_7_5', 1, [0, 0, 1, 0, 0, 0, 0, 0]),
    ])
    expect(map.size).toBe(2)
    expect(map.get('4_11_7')!.count).toBe(2)
    expect(map.get('11_7_5')!.count).toBe(1)
  })

  it('accumulates sum/sumSq when every contributing row has them', () => {
    const map = aggregatePairTotals([
      row('A', 2, [2, 0, 0, 0, 0, 0, 0, 0], 60_000, 100, 5_000),
      row('A', 3, [3, 0, 0, 0, 0, 0, 0, 0], 120_000, 150, 7_500),
    ])
    const e = map.get('A')!
    expect(e.sumIki).toBe(250)
    expect(e.sumSqIki).toBe(12_500)
  })

  it('nulls sum/sumSq for the whole pair once any contributing row lacks them', () => {
    const map = aggregatePairTotals([
      row('A', 2, [2, 0, 0, 0, 0, 0, 0, 0], 60_000, 100, 5_000),
      // Older row predating the sum columns.
      row('A', 1, [1, 0, 0, 0, 0, 0, 0, 0], 120_000, null, null),
    ])
    const e = map.get('A')!
    expect(e.sumIki).toBeNull()
    expect(e.sumSqIki).toBeNull()
  })

  it('does not resurrect sum/sumSq once nulled, even if a later row has them', () => {
    const map = aggregatePairTotals([
      // Older row predating the sum columns arrives first.
      row('A', 1, [1, 0, 0, 0, 0, 0, 0, 0], 60_000, null, null),
      row('A', 2, [2, 0, 0, 0, 0, 0, 0, 0], 120_000, 100, 5_000),
    ])
    const e = map.get('A')!
    expect(e.sumIki).toBeNull()
    expect(e.sumSqIki).toBeNull()
  })

  it('accumulates overlapCount/overlapN when every contributing row has them', () => {
    const map = aggregatePairTotals([
      row('A', 2, [2, 0, 0, 0, 0, 0, 0, 0], 60_000, null, null, { overlapCount: 1, overlapN: 2 }),
      row('A', 3, [3, 0, 0, 0, 0, 0, 0, 0], 120_000, null, null, { overlapCount: 2, overlapN: 3 }),
    ])
    const e = map.get('A')!
    expect(e.overlapCount).toBe(3)
    expect(e.overlapN).toBe(5)
  })

  // Deliberate deviation from the sumIki/sumSqIki null-poisoning rule
  // (codex P1 — overrides the original task doc's "same rule as SD"):
  // a row with no overlap data contributes 0, it does not poison
  // whatever the OTHER rows for the same pair DID observe. See the
  // deviation comment at the aggregation site in bigram-aggregate.ts.
  it('skips a row with no overlap data instead of poisoning the whole pair', () => {
    const map = aggregatePairTotals([
      row('A', 2, [2, 0, 0, 0, 0, 0, 0, 0], 60_000, null, null, { overlapCount: 1, overlapN: 2 }),
      // A row whose events never had a determined overlap — contributes
      // nothing, but does not erase the other row's contribution.
      row('A', 1, [1, 0, 0, 0, 0, 0, 0, 0], 120_000, null, null),
    ])
    const e = map.get('A')!
    expect(e.overlapCount).toBe(1)
    expect(e.overlapN).toBe(2)
  })

  it('treats a trigram row (overlap columns structurally absent) as contributing 0, not poisoned', () => {
    const map = aggregatePairTotals([
      trigramRow('4_11_7', 1, [1, 0, 0, 0, 0, 0, 0, 0]),
    ])
    const e = map.get('4_11_7')!
    expect(e.overlapCount).toBe(0)
    expect(e.overlapN).toBe(0)
  })
})

describe('observedRolloverRatio', () => {
  it('returns null for an empty selection', () => {
    expect(observedRolloverRatio(new Map())).toBeNull()
  })

  it('computes Σoc/Σon across every pair', () => {
    const map = totals([
      { ngramId: 'A', count: 5, hist: [], overlapCount: 3, overlapN: 5 },
      { ngramId: 'B', count: 2, hist: [], overlapCount: 1, overlapN: 5 },
    ])
    expect(observedRolloverRatio(map)).toBe(4 / 10)
  })

  it('a pair with no overlap data contributes 0/0 rather than nulling the whole ratio', () => {
    const map = totals([
      { ngramId: 'A', count: 5, hist: [], overlapCount: 3, overlapN: 5 },
      { ngramId: 'B', count: 2, hist: [] },
    ])
    expect(observedRolloverRatio(map)).toBe(3 / 5)
  })

  it('returns null when no pair in the selection has any overlap data (e.g. a trigram-only selection)', () => {
    const map = totals([
      { ngramId: 'A', count: 5, hist: [] },
    ])
    expect(observedRolloverRatio(map)).toBeNull()
  })
})

describe('sdFromSums', () => {
  it('computes the population SD from sum and sum-of-squares', () => {
    // IKI values [80, 100, 120]: mean=100, variance=((80-100)^2+(100-100)^2+(120-100)^2)/3=266.67
    const sum = 80 + 100 + 120
    const sumSq = 80 ** 2 + 100 ** 2 + 120 ** 2
    const sd = sdFromSums(sum, sumSq, 3)
    expect(sd).not.toBeNull()
    expect(sd!).toBeCloseTo(Math.sqrt(266.666_667), 3)
  })

  it('clips floating-point rounding on equally-spaced keystrokes to 0, not NaN', () => {
    // Simulate 3 equal-IKI pairs accumulated one row at a time (matching
    // how aggregatePairTotals sums them). True variance is 0, but
    // repeated float addition of a non-terminating fraction leaves a
    // tiny negative residue in sumSq/n - (sum/n)^2 without the
    // max(0, ...) clip — this would otherwise surface as NaN.
    const value = 100 / 3
    const count = 3
    let sum = 0
    let sumSq = 0
    for (let i = 0; i < count; i += 1) {
      sum += value
      sumSq += value * value
    }
    const sd = sdFromSums(sum, sumSq, count)
    expect(sd).toBe(0)
    expect(Number.isNaN(sd)).toBe(false)
  })

  it('computes 0 for exactly equal integer IKI values too', () => {
    const sd = sdFromSums(400, 40_000, 4)
    expect(sd).toBe(0)
  })

  it('returns null for fewer than 2 samples', () => {
    expect(sdFromSums(100, 10_000, 1)).toBeNull()
    expect(sdFromSums(0, 0, 0)).toBeNull()
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
      { ngramId: 'A', count: 5, hist: [5, 0, 0, 0, 0, 0, 0, 0] },
      { ngramId: 'B', count: 10, hist: [0, 10, 0, 0, 0, 0, 0, 0] },
      { ngramId: 'C', count: 1, hist: [0, 0, 1, 0, 0, 0, 0, 0] },
    ])
    expect(rankBigramsByCount(map, 2).map((e) => e.ngramId)).toEqual(['B', 'A'])
  })

  it('breaks ties by ngramId ascending so output is deterministic', () => {
    const map = totals([
      { ngramId: 'B', count: 3, hist: [3, 0, 0, 0, 0, 0, 0, 0] },
      { ngramId: 'A', count: 3, hist: [0, 0, 3, 0, 0, 0, 0, 0] },
    ])
    expect(rankBigramsByCount(map, 5).map((e) => e.ngramId)).toEqual(['A', 'B'])
  })

  it('attaches avgIki computed from each pair hist', () => {
    const map = totals([
      { ngramId: 'A', count: 1, hist: [1, 0, 0, 0, 0, 0, 0, 0] },
    ])
    const [entry] = rankBigramsByCount(map, 5)
    expect(entry.avgIki).toBe(30) // bucket 0 center
  })

  it('attaches sd computed from sum/sumSq when the pair has complete sums', () => {
    const map = totals([
      { ngramId: 'A', count: 2, hist: [2, 0, 0, 0, 0, 0, 0, 0], sumIki: 200, sumSqIki: 20_400 },
    ])
    const [entry] = rankBigramsByCount(map, 5)
    expect(entry.sd).not.toBeNull()
    expect(entry.sd!).toBeCloseTo(sdFromSums(200, 20_400, 2)!, 10)
  })

  it('reports sd as null when the pair has incomplete sums', () => {
    const map = totals([
      { ngramId: 'A', count: 2, hist: [2, 0, 0, 0, 0, 0, 0, 0], sumIki: null, sumSqIki: null },
    ])
    const [entry] = rankBigramsByCount(map, 5)
    expect(entry.sd).toBeNull()
  })

  it('projects overlapCount/overlapN as null/null when the pair has no determined-overlap sample', () => {
    const map = totals([
      { ngramId: 'A', count: 2, hist: [2, 0, 0, 0, 0, 0, 0, 0] },
    ])
    const [entry] = rankBigramsByCount(map, 5)
    expect(entry.overlapCount).toBeNull()
    expect(entry.overlapN).toBeNull()
  })

  it('projects the raw overlapCount/overlapN when overlapN > 0, even a real observed 0', () => {
    const map = totals([
      { ngramId: 'A', count: 5, hist: [5, 0, 0, 0, 0, 0, 0, 0], overlapCount: 0, overlapN: 5 },
    ])
    const [entry] = rankBigramsByCount(map, 5)
    expect(entry.overlapCount).toBe(0)
    expect(entry.overlapN).toBe(5)
  })

  it('projects a non-zero overlapCount/overlapN pair unchanged', () => {
    const map = totals([
      { ngramId: 'A', count: 5, hist: [5, 0, 0, 0, 0, 0, 0, 0], overlapCount: 2, overlapN: 5 },
    ])
    const [entry] = rankBigramsByCount(map, 5)
    expect(entry.overlapCount).toBe(2)
    expect(entry.overlapN).toBe(5)
  })
})

describe('rankBigramsBySlow', () => {
  it('drops pairs below minSampleCount', () => {
    const map = totals([
      // Slow pair but only 1 sample → should be dropped at minSample=5.
      { ngramId: 'low', count: 1, hist: [0, 0, 0, 0, 0, 0, 0, 1] },
      // Fast pair with enough samples → kept.
      { ngramId: 'kept', count: 5, hist: [5, 0, 0, 0, 0, 0, 0, 0] },
    ])
    const ranked = rankBigramsBySlow(map, 5, 5)
    expect(ranked.map((e) => e.ngramId)).toEqual(['kept'])
  })

  it('orders by avg IKI descending', () => {
    const map = totals([
      // Fast (avg ~30)
      { ngramId: 'A', count: 5, hist: [5, 0, 0, 0, 0, 0, 0, 0] },
      // Slow (avg ~1500)
      { ngramId: 'B', count: 5, hist: [0, 0, 0, 0, 0, 0, 0, 5] },
      // Medium (avg ~250)
      { ngramId: 'C', count: 5, hist: [0, 0, 0, 0, 5, 0, 0, 0] },
    ])
    expect(rankBigramsBySlow(map, 5, 5).map((e) => e.ngramId)).toEqual(['B', 'C', 'A'])
  })

  it('attaches p95 computed from each pair hist', () => {
    const map = totals([
      // 4 samples in bucket 0, 1 in bucket 7. p95 of 5 samples = target 4.75 — lands in b7.
      { ngramId: 'A', count: 5, hist: [4, 0, 0, 0, 0, 0, 0, 1] },
    ])
    const [entry] = rankBigramsBySlow(map, 5, 5)
    expect(entry.p95).not.toBeNull()
    expect(entry.p95).toBeGreaterThan(1000)
  })

  it('returns an empty array when no pair meets minSample', () => {
    const map = totals([{ ngramId: 'x', count: 1, hist: [1, 0, 0, 0, 0, 0, 0, 0] }])
    expect(rankBigramsBySlow(map, 5, 5)).toEqual([])
  })

  it('attaches sd computed from sum/sumSq when the pair has complete sums', () => {
    const map = totals([
      { ngramId: 'A', count: 5, hist: [4, 0, 0, 0, 0, 0, 0, 1], sumIki: 900, sumSqIki: 500_000 },
    ])
    const [entry] = rankBigramsBySlow(map, 5, 5)
    expect(entry.sd).not.toBeNull()
    expect(entry.sd!).toBeCloseTo(sdFromSums(900, 500_000, 5)!, 10)
  })

  it('reports sd as null when the pair has incomplete sums (mixed old/new data)', () => {
    const map = totals([
      { ngramId: 'A', count: 5, hist: [4, 0, 0, 0, 0, 0, 0, 1], sumIki: null, sumSqIki: null },
    ])
    const [entry] = rankBigramsBySlow(map, 5, 5)
    expect(entry.sd).toBeNull()
  })

  it('projects overlapCount/overlapN as null/null when the pair has no determined-overlap sample', () => {
    const map = totals([
      { ngramId: 'A', count: 5, hist: [4, 0, 0, 0, 0, 0, 0, 1] },
    ])
    const [entry] = rankBigramsBySlow(map, 5, 5)
    expect(entry.overlapCount).toBeNull()
    expect(entry.overlapN).toBeNull()
  })

  it('projects the raw overlapCount/overlapN when overlapN > 0, even a real observed 0', () => {
    const map = totals([
      { ngramId: 'A', count: 5, hist: [4, 0, 0, 0, 0, 0, 0, 1], overlapCount: 0, overlapN: 4 },
    ])
    const [entry] = rankBigramsBySlow(map, 5, 5)
    expect(entry.overlapCount).toBe(0)
    expect(entry.overlapN).toBe(4)
  })
})

describe('aggregateMatrixDurationTotals', () => {
  it('returns an empty map for an empty input', () => {
    expect(aggregateMatrixDurationTotals([]).size).toBe(0)
  })

  it('sums count/hist/sum/sumSq across rows for the same cell', () => {
    const map = aggregateMatrixDurationTotals([
      durationRow(0, 0, 0, [0, 1, 0, 0, 0, 0, 0, 0], 65, 4_225, 60_000),
      durationRow(0, 0, 0, [0, 0, 1, 0, 0, 0, 0, 0], 95, 9_025, 120_000),
    ])
    const e = map.get('0,0,0')!
    expect(e.count).toBe(2)
    expect(e.hist).toEqual([0, 1, 1, 0, 0, 0, 0, 0])
    expect(e.sum).toBe(160)
    expect(e.sumSq).toBe(13_250)
  })

  it('keeps separate entries for different cells', () => {
    const map = aggregateMatrixDurationTotals([
      durationRow(0, 0, 0, [1, 0, 0, 0, 0, 0, 0, 0], 40, 1_600),
      durationRow(0, 1, 0, [0, 1, 0, 0, 0, 0, 0, 0], 65, 4_225),
    ])
    expect(map.size).toBe(2)
    expect(map.get('0,0,0')!.count).toBe(1)
    expect(map.get('0,1,0')!.count).toBe(1)
  })

  it('keeps the same physical cell on different layers distinct', () => {
    const map = aggregateMatrixDurationTotals([
      durationRow(0, 0, 0, [1, 0, 0, 0, 0, 0, 0, 0], 40, 1_600),
      durationRow(0, 0, 1, [0, 1, 0, 0, 0, 0, 0, 0], 65, 4_225),
    ])
    expect(map.size).toBe(2)
  })
})

describe('avgDurationMsFromTotal / durationSdFromTotal', () => {
  it('computes the true mean from sum/count, not a histogram estimate', () => {
    const map = aggregateMatrixDurationTotals([
      durationRow(0, 0, 0, [1, 1, 0, 0, 0, 0, 0, 0], 130, 8_500, 60_000),
    ])
    const e = map.get('0,0,0')!
    expect(avgDurationMsFromTotal(e)).toBe(65)
  })

  it('returns null avg for a cell with no duration samples', () => {
    const map = aggregateMatrixDurationTotals([])
    map.set('0,0,0', { row: 0, col: 0, layer: 0, count: 0, hist: new Array(8).fill(0), sum: 0, sumSq: 0 })
    expect(avgDurationMsFromTotal(map.get('0,0,0')!)).toBeNull()
  })

  it('returns null SD for fewer than 2 samples', () => {
    const map = aggregateMatrixDurationTotals([
      durationRow(0, 0, 0, [1, 0, 0, 0, 0, 0, 0, 0], 65, 4_225),
    ])
    expect(durationSdFromTotal(map.get('0,0,0')!)).toBeNull()
  })

  it('computes a real SD from sum/sumSq once there are 2+ samples', () => {
    // Durations [60, 70, 80]: mean=70, variance=((60-70)^2+(70-70)^2+(80-70)^2)/3=66.67
    const sum = 60 + 70 + 80
    const sumSq = 60 ** 2 + 70 ** 2 + 80 ** 2
    const map = aggregateMatrixDurationTotals([
      durationRow(0, 0, 0, [1, 1, 1, 0, 0, 0, 0, 0], sum, sumSq),
    ])
    const sd = durationSdFromTotal(map.get('0,0,0')!)
    expect(sd).not.toBeNull()
    expect(sd!).toBeCloseTo(Math.sqrt(200 / 3), 5)
  })
})
