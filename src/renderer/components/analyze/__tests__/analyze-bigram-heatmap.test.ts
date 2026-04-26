// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  aggregateKeyHeatmap,
  avgIkiFromHist,
} from '../analyze-bigram-heatmap'
import type { TypingBigramTopEntry } from '../../../../shared/types/typing-analytics'

function entry(bigramId: string, count: number, hist: number[] = [0, 0, 0, 0, 0, 0, 0, 0]): TypingBigramTopEntry {
  return { bigramId, count, hist, avgIki: null }
}

describe('aggregateKeyHeatmap', () => {
  it('returns empty result for empty input', () => {
    expect(aggregateKeyHeatmap([], 5)).toEqual({ keys: [], cells: [] })
  })

  it('selects the top-N keycodes by total appearances', () => {
    const entries = [
      entry('1_2', 5),
      entry('2_1', 5), // 1 appears 10 times, 2 appears 10 times
      entry('3_3', 1), // 3 appears 2 times
    ]
    const { keys } = aggregateKeyHeatmap(entries, 2)
    // Top 2 by appearance count → 1 and 2 (10 each), 3 (2) is excluded.
    expect(keys.sort()).toEqual([1, 2])
  })

  it('builds a square matrix indexed by from / to', () => {
    const entries = [
      entry('1_2', 3, [0, 3, 0, 0, 0, 0, 0, 0]),
      entry('2_1', 1, [0, 0, 1, 0, 0, 0, 0, 0]),
    ]
    const { keys, cells } = aggregateKeyHeatmap(entries, 5)
    expect(cells).toHaveLength(keys.length)
    cells.forEach((row) => expect(row).toHaveLength(keys.length))
  })

  it('drops malformed pair ids without crashing', () => {
    const entries = [entry('not-a-pair', 1), entry('1_2', 5)]
    const { keys } = aggregateKeyHeatmap(entries, 5)
    expect(keys.sort()).toEqual([1, 2])
  })

  it('caps the result at topN even when more keys are seen', () => {
    const entries = [
      entry('1_1', 10),
      entry('2_2', 9),
      entry('3_3', 8),
      entry('4_4', 7),
      entry('5_5', 6),
    ]
    const { keys, cells } = aggregateKeyHeatmap(entries, 3)
    expect(keys).toHaveLength(3)
    expect(cells).toHaveLength(3)
  })
})

describe('avgIkiFromHist', () => {
  it('returns null for an all-zero histogram', () => {
    expect(avgIkiFromHist([0, 0, 0, 0, 0, 0, 0, 0])).toBeNull()
  })

  it('uses bucket centers for the weighted average', () => {
    // Bucket 1 center is 80; 5 occurrences → avg = 80.
    expect(avgIkiFromHist([0, 5, 0, 0, 0, 0, 0, 0])).toBe(80)
    // 2 in b0 (30) + 2 in b4 (250) → avg = (60 + 500) / 4 = 140.
    expect(avgIkiFromHist([2, 0, 0, 0, 2, 0, 0, 0])).toBe(140)
  })
})
