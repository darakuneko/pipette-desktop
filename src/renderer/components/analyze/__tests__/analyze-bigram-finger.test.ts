// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  aggregateFingerPairs,
} from '../analyze-bigram-finger'
import type { FingerType } from '../../../../shared/kle/kle-ergonomics'
import type { TypingBigramTopEntry } from '../../../../shared/types/typing-analytics'

function entry(
  bigramId: string,
  count: number,
  hist: number[] = [0, 0, 0, 0, 0, 0, 0, 0],
): TypingBigramTopEntry {
  return { bigramId, count, hist, avgIki: null }
}

describe('aggregateFingerPairs', () => {
  const fingerMap = new Map<number, FingerType>([
    [1, 'left-index'],
    [2, 'right-middle'],
    [3, 'right-index'],
  ])

  it('returns empty totals for empty entries', () => {
    expect(aggregateFingerPairs([], fingerMap).size).toBe(0)
  })

  it('groups by (prevFinger, currFinger) and sums count + hist', () => {
    const totals = aggregateFingerPairs(
      [
        entry('1_2', 3, [3, 0, 0, 0, 0, 0, 0, 0]),
        entry('1_2', 2, [0, 2, 0, 0, 0, 0, 0, 0]),
        entry('2_3', 1, [0, 0, 1, 0, 0, 0, 0, 0]),
      ],
      fingerMap,
    )
    expect(totals.get('left-index_right-middle')).toEqual({
      count: 5,
      hist: [3, 2, 0, 0, 0, 0, 0, 0],
    })
    expect(totals.get('right-middle_right-index')).toEqual({
      count: 1,
      hist: [0, 0, 1, 0, 0, 0, 0, 0],
    })
  })

  it('drops pairs whose keycodes are unmapped', () => {
    const totals = aggregateFingerPairs(
      [entry('99_2', 5)], // 99 not in fingerMap
      fingerMap,
    )
    expect(totals.size).toBe(0)
  })

  it('drops pairs with malformed bigramId', () => {
    const totals = aggregateFingerPairs(
      [entry('bad', 1), entry('1_2', 1)],
      fingerMap,
    )
    expect(totals.size).toBe(1)
    expect(totals.get('left-index_right-middle')?.count).toBe(1)
  })
})
