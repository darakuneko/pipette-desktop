// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { aggregateBigramClasses, classifyBigram } from '../analyze-bigram-classes'
import type { FingerType } from '../../../../shared/kle/kle-ergonomics'
import type { TypingBigramTopEntry } from '../../../../shared/types/typing-analytics'

function entry(
  ngramId: string,
  count: number,
  hist: number[] = [0, 0, 0, 0, 0, 0, 0, 0],
): TypingBigramTopEntry {
  return { ngramId, count, hist, avgIki: null, sd: null }
}

describe('classifyBigram', () => {
  it('classifies the same keycode struck twice as repetition (letter repeat)', () => {
    expect(classifyBigram('left-index', 'left-index', true)).toBe('repetition')
  })

  it('classifies two different keys sharing one finger as left/right, not repetition', () => {
    // e.g. two thumb-cluster keys both mapped to left-thumb — a
    // same-finger bigram (SFB), which is still a same-hand pair per
    // the CHI 2018 definition, not a letter repeat.
    expect(classifyBigram('left-thumb', 'left-thumb', false)).toBe('left')
  })

  it('classifies same-hand, different-finger pairs as left / right', () => {
    expect(classifyBigram('left-index', 'left-middle', false)).toBe('left')
    expect(classifyBigram('right-ring', 'right-pinky', false)).toBe('right')
  })

  it('classifies cross-hand pairs as alternation', () => {
    expect(classifyBigram('left-index', 'right-index', false)).toBe('alternation')
    expect(classifyBigram('right-pinky', 'left-thumb', false)).toBe('alternation')
  })

  it('classifies as unknown when either finger is unresolved, even for the same keycode', () => {
    expect(classifyBigram(undefined, 'left-index', false)).toBe('unknown')
    expect(classifyBigram('left-index', undefined, false)).toBe('unknown')
    expect(classifyBigram(undefined, undefined, false)).toBe('unknown')
    // Unresolved fingers take priority over the same-keycode check.
    expect(classifyBigram(undefined, undefined, true)).toBe('unknown')
  })
})

describe('aggregateBigramClasses', () => {
  const fingerMap = new Map<number, FingerType>([
    [1, 'left-index'],
    [2, 'left-index'], // shares a finger with keycode 1 but is a different key
    [3, 'right-middle'],
    [4, 'left-middle'],
  ])

  it('returns zeroed totals for empty entries', () => {
    const result = aggregateBigramClasses([], fingerMap)
    expect(result.totals.left).toEqual({ count: 0, hist: [0, 0, 0, 0, 0, 0, 0, 0] })
    expect(result.totals.right).toEqual({ count: 0, hist: [0, 0, 0, 0, 0, 0, 0, 0] })
    expect(result.totals.alternation).toEqual({ count: 0, hist: [0, 0, 0, 0, 0, 0, 0, 0] })
    expect(result.totals.repetition).toEqual({ count: 0, hist: [0, 0, 0, 0, 0, 0, 0, 0] })
    expect(result.unknownCount).toBe(0)
    expect(result.totalCount).toBe(0)
  })

  it('folds a same-key repeat into repetition', () => {
    const result = aggregateBigramClasses(
      [entry('1_1', 4, [4, 0, 0, 0, 0, 0, 0, 0])],
      fingerMap,
    )
    expect(result.totals.repetition).toEqual({ count: 4, hist: [4, 0, 0, 0, 0, 0, 0, 0] })
    expect(result.totals.left.count).toBe(0)
  })

  it('is exclusive: a same-finger, different-key pair folds into left, never repetition', () => {
    // keycodes 1 and 2 both resolve to left-index -> same hand AND same
    // finger, but they're different keys. A pre-fix implementation
    // that classified by finger equality would have counted this as
    // repetition; the correct (keycode-equality) definition puts it in
    // `left` instead.
    const result = aggregateBigramClasses(
      [entry('1_2', 4, [4, 0, 0, 0, 0, 0, 0, 0])],
      fingerMap,
    )
    expect(result.totals.left).toEqual({ count: 4, hist: [4, 0, 0, 0, 0, 0, 0, 0] })
    expect(result.totals.repetition.count).toBe(0)
    expect(result.totals.right.count).toBe(0)
    expect(result.totals.alternation.count).toBe(0)
  })

  it('folds same-hand different-finger pairs into left', () => {
    const result = aggregateBigramClasses(
      [entry('1_4', 3, [0, 3, 0, 0, 0, 0, 0, 0])],
      fingerMap,
    )
    expect(result.totals.left).toEqual({ count: 3, hist: [0, 3, 0, 0, 0, 0, 0, 0] })
  })

  it('folds cross-hand pairs into alternation and sums hist across entries', () => {
    const result = aggregateBigramClasses(
      [
        entry('1_3', 2, [2, 0, 0, 0, 0, 0, 0, 0]),
        entry('4_3', 1, [0, 1, 0, 0, 0, 0, 0, 0]),
      ],
      fingerMap,
    )
    expect(result.totals.alternation).toEqual({ count: 3, hist: [2, 1, 0, 0, 0, 0, 0, 0] })
  })

  it('counts unmapped keycodes and malformed ids as unknown without dropping them from totalCount', () => {
    const result = aggregateBigramClasses(
      [
        entry('99_3', 5), // 99 unmapped
        entry('bad', 2), // malformed ngramId
        entry('1_3', 1, [1, 0, 0, 0, 0, 0, 0, 0]),
      ],
      fingerMap,
    )
    expect(result.unknownCount).toBe(7)
    expect(result.totalCount).toBe(8)
    expect(result.totals.alternation.count).toBe(1)
  })

  it('counts a same-keycode pair with an unmapped finger as unknown, not repetition', () => {
    const result = aggregateBigramClasses(
      [entry('99_99', 3)], // same keycode, but 99 has no mapped finger
      fingerMap,
    )
    expect(result.unknownCount).toBe(3)
    expect(result.totals.repetition.count).toBe(0)
  })

  it('with a pairFilter, a rejected parsed pair contributes to neither a class total nor totalCount', () => {
    const result = aggregateBigramClasses(
      [
        entry('1_3', 2, [2, 0, 0, 0, 0, 0, 0, 0]), // alternation, kept
        entry('1_2', 4, [4, 0, 0, 0, 0, 0, 0, 0]), // left, rejected by filter
      ],
      fingerMap,
      (pair) => pair.prev === 1 && pair.curr === 3,
    )
    expect(result.totals.alternation.count).toBe(2)
    expect(result.totals.left.count).toBe(0)
    expect(result.unknownCount).toBe(0)
    expect(result.totalCount).toBe(2)
  })

  it('a malformed id always lands in unknownCount, even with a pairFilter that would reject everything — the filter is never consulted since there is no parsed pair to hand it', () => {
    const result = aggregateBigramClasses(
      [entry('bad', 9)],
      fingerMap,
      () => false,
    )
    expect(result.unknownCount).toBe(9)
    expect(result.totalCount).toBe(9)
  })
})
