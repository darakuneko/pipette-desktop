// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { DURATION_BUCKET_BIN_IDS, sumDurationTotals } from '../analyze-duration'
import { DURATION_BUCKET_UPPER_BOUNDS_MS } from '../../../../shared/duration-buckets'
import type { TypingDurationCell } from '../../../../shared/types/typing-analytics'

function cell(overrides: Partial<TypingDurationCell> = {}): TypingDurationCell {
  return {
    row: 0,
    col: 0,
    layer: 0,
    durationSamples: 0,
    hist: [0, 0, 0, 0, 0, 0, 0, 0],
    sum: 0,
    sumSq: 0,
    ...overrides,
  }
}

describe('sumDurationTotals', () => {
  it('returns an all-zero total for an empty input', () => {
    const totals = sumDurationTotals([])
    expect(totals.samples).toBe(0)
    expect(totals.sum).toBe(0)
    expect(totals.sumSq).toBe(0)
    expect(totals.hist).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('sums histograms element-wise and accumulates samples/sum/sumSq across cells', () => {
    const totals = sumDurationTotals([
      cell({ row: 0, col: 0, hist: [1, 0, 0, 0, 0, 0, 0, 0], durationSamples: 1, sum: 40, sumSq: 1_600 }),
      cell({ row: 0, col: 1, hist: [0, 2, 0, 0, 0, 0, 0, 0], durationSamples: 2, sum: 130, sumSq: 8_500 }),
    ])
    expect(totals.hist).toEqual([1, 2, 0, 0, 0, 0, 0, 0])
    expect(totals.samples).toBe(3)
    expect(totals.sum).toBe(170)
    expect(totals.sumSq).toBe(10_100)
  })

  it('folds two cells sharing the same (row, col, layer) — caller may pass raw per-minute rows', () => {
    const totals = sumDurationTotals([
      cell({ hist: [1, 0, 0, 0, 0, 0, 0, 0], durationSamples: 1, sum: 40, sumSq: 1_600 }),
      cell({ hist: [1, 0, 0, 0, 0, 0, 0, 0], durationSamples: 1, sum: 50, sumSq: 2_500 }),
    ])
    expect(totals.hist).toEqual([2, 0, 0, 0, 0, 0, 0, 0])
    expect(totals.samples).toBe(2)
    expect(totals.sum).toBe(90)
  })
})

// SD coverage now lives in shared/__tests__/stat-sums.test.ts —
// DurationSection imports `sdFromSums` from shared/stat-sums directly
// (see item 1 of the consolidation pass).

describe('DURATION_BUCKET_BIN_IDS', () => {
  it('stays index-aligned with the shared duration grid (one id per bucket)', () => {
    expect(DURATION_BUCKET_BIN_IDS).toHaveLength(DURATION_BUCKET_UPPER_BOUNDS_MS.length)
  })
})
