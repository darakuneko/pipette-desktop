// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, afterEach } from 'vitest'
import { wordWeakSpotScore, pickWeightedIndex, WEAK_SPOT_BIAS_RATIO, type WeakSpotBiasProfile } from '../weak-spot-weighting'

describe('wordWeakSpotScore — direct', () => {
  it('is 0 for a word with no matched tokens', () => {
    const profile: WeakSpotBiasProfile = { inputMethod: 'direct', weights: { z: 5 } }
    expect(wordWeakSpotScore('cat', profile)).toBe(0)
  })

  it('is positive when the word contains a weighted character', () => {
    const profile: WeakSpotBiasProfile = { inputMethod: 'direct', weights: { a: 3 } }
    expect(wordWeakSpotScore('cat', profile)).toBeGreaterThan(0)
  })

  it('scores higher for a word matching more/heavier tokens (before length-normalization ties break it)', () => {
    const profile: WeakSpotBiasProfile = { inputMethod: 'direct', weights: { a: 3, t: 3 } }
    // 'at' (2 matched of 2 tokens) should score higher than 'a' alone is impossible to
    // compare directly since different lengths; instead compare two same-length words.
    expect(wordWeakSpotScore('at', profile)).toBeGreaterThan(wordWeakSpotScore('to', profile))
  })

  it('never counts an unmatched character (no substring bleed)', () => {
    // Weight keyed by "a" only; a word entirely of other chars scores 0.
    const profile: WeakSpotBiasProfile = { inputMethod: 'direct', weights: { a: 100 } }
    expect(wordWeakSpotScore('xyz', profile)).toBe(0)
  })

  it('caps the contribution of an extreme-frequency single token (log-scaled, not linear)', () => {
    const low: WeakSpotBiasProfile = { inputMethod: 'direct', weights: { a: 1 } }
    const high: WeakSpotBiasProfile = { inputMethod: 'direct', weights: { a: 100000 } }
    const scoreLow = wordWeakSpotScore('a', low)
    const scoreHigh = wordWeakSpotScore('a', high)
    expect(scoreHigh).toBeGreaterThan(scoreLow)
    // Without a cap, a 100000x weight ratio would produce a wildly larger
    // score; capped+log-scaled keeps it within a modest multiple.
    expect(scoreHigh / scoreLow).toBeLessThan(10)
  })
})

describe('wordWeakSpotScore — kana', () => {
  it('matches hiragana-normalized characters, including a katakana candidate word', () => {
    const profile: WeakSpotBiasProfile = { inputMethod: 'kana', weights: { か: 5 } }
    expect(wordWeakSpotScore('かめ', profile)).toBeGreaterThan(0)
    expect(wordWeakSpotScore('カメ', profile)).toBeGreaterThan(0)
  })

  it('is 0 for a word with no matched kana', () => {
    const profile: WeakSpotBiasProfile = { inputMethod: 'kana', weights: { か: 5 } }
    expect(wordWeakSpotScore('たぬき', profile)).toBe(0)
  })
})

describe('wordWeakSpotScore — romaji', () => {
  it('matches exact segment tokens, never a flat substring', () => {
    // Weight keyed by the standalone segment "a" (あ). "か" tokenizes to
    // "ka" as ONE segment — "a" must never match inside it.
    const profile: WeakSpotBiasProfile = { inputMethod: 'romaji', weights: { a: 5 } }
    expect(wordWeakSpotScore('か', profile)).toBe(0)
    expect(wordWeakSpotScore('あ', profile)).toBeGreaterThan(0)
  })

  it('matches a 拗音 digraph token exactly', () => {
    const profile: WeakSpotBiasProfile = { inputMethod: 'romaji', weights: { kya: 5 } }
    expect(wordWeakSpotScore('きゃ', profile)).toBeGreaterThan(0)
    // "き" alone (ki) must not match a "kya" weight.
    expect(wordWeakSpotScore('き', profile)).toBe(0)
  })
})

describe('pickWeightedIndex', () => {
  afterEach(() => vi.restoreAllMocks())

  it('always returns the sole positive-weight index', () => {
    const weights = [0, 5, 0]
    for (let i = 0; i < 20; i++) {
      expect(pickWeightedIndex(weights, 5)).toBe(1)
    }
  })

  it('is deterministic under a mocked Math.random and honors proportional boundaries', () => {
    const weights = [1, 3] // total 4: index 0 covers [0,1), index 1 covers [1,4)
    vi.spyOn(Math, 'random').mockReturnValue(0) // r = 0*4 = 0 -> index 0
    expect(pickWeightedIndex(weights, 4)).toBe(0)
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // r = 2 -> falls into index 1
    expect(pickWeightedIndex(weights, 4)).toBe(1)
  })
})

// WEAK_SPOT_BIAS_RATIO itself is just a constant consumed by
// word-generator.ts's sampleWords mixture — pinned here so a future edit
// notices if it silently drifts away from the documented 60/40 split.
describe('WEAK_SPOT_BIAS_RATIO', () => {
  it('is 0.6 (60% biased / 40% normal)', () => {
    expect(WEAK_SPOT_BIAS_RATIO).toBe(0.6)
  })
})
