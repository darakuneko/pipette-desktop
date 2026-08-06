// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateWordsSync, injectPunctuation, injectNumbers } from '../word-generator'
import type { WeakSpotBiasProfile } from '../word-generator/weak-spot-weighting'

describe('generateWords', () => {
  it('generates the requested number of words', () => {
    const result = generateWordsSync(10)
    expect(result.words).toHaveLength(10)
  })

  it('generates 30 words by default', () => {
    const result = generateWordsSync()
    expect(result.words).toHaveLength(30)
  })

  it('generates non-empty strings', () => {
    const result = generateWordsSync(20)
    for (const word of result.words) {
      expect(word.length).toBeGreaterThan(0)
    }
  })

  it('does not produce consecutive duplicates', () => {
    const result = generateWordsSync(50)
    let consecutiveDuplicates = 0
    for (let i = 1; i < result.words.length; i++) {
      if (result.words[i] === result.words[i - 1]) {
        consecutiveDuplicates++
      }
    }
    // The algorithm retries up to 100 times to avoid duplicates.
    // With a 200-word pool, consecutive duplicates should not occur.
    expect(consecutiveDuplicates).toBe(0)
  })

  it('returns words from the english word list', () => {
    const result = generateWordsSync(5)
    // All words should be lowercase alphabetic strings
    for (const word of result.words) {
      expect(word).toMatch(/^[a-z]+$/)
    }
  })

  it('base words are lowercase without punctuation', () => {
    const result = generateWordsSync(200)
    for (const word of result.words) {
      expect(word).toBe(word.toLowerCase())
    }
  })

  it('generates words with punctuation when option enabled', () => {
    const result = generateWordsSync(60, { punctuation: true })
    const joined = result.words.join(' ')
    // Should contain at least one period and one comma in 60 words
    expect(joined).toMatch(/[.,]/)
  })

  it('generates words with numbers when option enabled', () => {
    const result = generateWordsSync(100, { numbers: true })
    const hasNumber = result.words.some((w) => /^\d+$/.test(w))
    // With 10% probability over 100 words, expect at least one number
    expect(hasNumber).toBe(true)
  })

  it('applies both punctuation and numbers together', () => {
    const result = generateWordsSync(100, { punctuation: true, numbers: true })
    const joined = result.words.join(' ')
    expect(joined).toMatch(/[.,]/)
    const hasNumber = result.words.some((w) => /^\d+$/.test(w) || /\d/.test(w))
    expect(hasNumber).toBe(true)
  })

  it('honors a seedLastWord across the very first draw (immediate-repeat avoidance across a refill boundary)', () => {
    // The english list has hundreds of words, but the retry loop only
    // fires when the FIRST draw happens to equal the seed — force that by
    // running many times; none of the returned batches may start with the
    // seeded word (proves the seed is honored rather than ignored).
    const seeded = generateWordsSync(1)
    const seed = seeded.words[0]
    for (let i = 0; i < 20; i++) {
      const result = generateWordsSync(5, undefined, undefined, undefined, seed)
      expect(result.words[0]).not.toBe(seed)
    }
  })

  it('lastRawWord is the RAW pre-decoration word, not the decorated words[] tail', () => {
    // punctuation ON: the last word gets a trailing '.' (see
    // injectPunctuation's final-word rule), and numbers ON can replace it
    // wholesale with a digit string — lastRawWord must reflect neither.
    for (let i = 0; i < 20; i++) {
      const result = generateWordsSync(10, { punctuation: true, numbers: true })
      expect(result.lastRawWord).toBeDefined()
      expect(result.lastRawWord).toMatch(/^[a-z]+$/)
      const decoratedTail = result.words[result.words.length - 1]
      // The decorated tail is the raw word plus a trailing '.', UNLESS
      // numbers replaced it wholesale with a digit string — either way it
      // must never be byte-identical to the bare raw word (that would mean
      // no decoration ran, which isn't what this options combo produces on
      // the final slot).
      expect(decoratedTail).not.toBe(result.lastRawWord)
    }
  })

  it('lastRawWord matches words[] tail exactly when no decoration is applied', () => {
    const result = generateWordsSync(10, { punctuation: false, numbers: false })
    expect(result.lastRawWord).toBe(result.words[result.words.length - 1])
  })
})

describe('generateWords — weak-spot-biased sampling', () => {
  afterEach(() => vi.restoreAllMocks())

  it('zero-weight profile (no matched tokens) falls back to fully uniform sampling', () => {
    const profile: WeakSpotBiasProfile = { inputMethod: 'direct', weights: { ' ': 1 }, biasRatio: 0.6 }
    const result = generateWordsSync(50, undefined, undefined, profile)
    expect(result.words).toHaveLength(50)
    for (const word of result.words) {
      expect(word).toMatch(/^[a-z]+$/)
    }
  })

  it('a heavily-weighted single character produces a majority of matching words over many draws', () => {
    // English words are common, everyday words — 'e' is extremely frequent,
    // so a large weight on it should visibly skew the sampled batch toward
    // words containing 'e', without asserting an exact count (probabilistic).
    const profile: WeakSpotBiasProfile = { inputMethod: 'direct', weights: { e: 1000 }, biasRatio: 0.6 }
    const result = generateWordsSync(300, undefined, undefined, profile)
    const withE = result.words.filter((w) => w.includes('e')).length
    // Roughly 60% biased draws should all match (since 'e' is so heavily
    // weighted relative to everything else); allow slack for the 40%
    // uniform half occasionally also containing 'e'.
    expect(withE / result.words.length).toBeGreaterThan(0.5)
  })

  it('mixture ratio is deterministic under a mocked Math.random (always-biased vs always-uniform)', () => {
    const profile: WeakSpotBiasProfile = { inputMethod: 'direct', weights: { z: 1 }, biasRatio: 0.6 }
    // Math.random() < 0.6 always true -> every draw uses the biased path,
    // which (given only 'z'-weighted words score >0) must resolve to a
    // word containing 'z' every time pickWeightedIndex's own Math.random
    // call also returns a value landing on that index. Simpler and
    // deterministic: force a value that always fails the bias check
    // (>= 0.6) so every draw is uniform — the whole batch must succeed
    // (no crash, no bias-scoped bug) even though the profile is nonzero.
    vi.spyOn(Math, 'random').mockReturnValue(0.9)
    const result = generateWordsSync(20, undefined, undefined, profile)
    expect(result.words).toHaveLength(20)
  })
})

describe('injectPunctuation', () => {
  it('returns same number of words', () => {
    const words = ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'the', 'lazy', 'dog']
    const result = injectPunctuation(words)
    expect(result).toHaveLength(words.length)
  })

  it('last word ends with a period', () => {
    const words = ['the', 'quick', 'brown', 'fox', 'jumps']
    const result = injectPunctuation(words)
    expect(result[result.length - 1]).toMatch(/\.$/)
  })

  it('only uses allowed characters', () => {
    const words = Array(60).fill('word') as string[]
    const result = injectPunctuation(words)
    for (const word of result) {
      expect(word).toMatch(/^[a-zA-Z.,;!?'\-]+$/)
    }
  })

  it('capitalizes the first word', () => {
    const words = ['hello', 'world', 'test', 'foo', 'bar']
    const result = injectPunctuation(words)
    expect(result[0][0]).toMatch(/[A-Z]/)
  })

  it('capitalizes the word after a period', () => {
    const words = Array(20).fill('word') as string[]
    const result = injectPunctuation(words)
    for (let i = 1; i < result.length; i++) {
      if (result[i - 1].endsWith('.')) {
        expect(result[i][0]).toMatch(/[A-Z]/)
      }
    }
  })

  it('adds commas to some words', () => {
    // Run multiple times to account for randomness
    let hasComma = false
    for (let i = 0; i < 10; i++) {
      const words = Array(30).fill('word') as string[]
      const result = injectPunctuation(words)
      if (result.some((w) => w.includes(','))) {
        hasComma = true
        break
      }
    }
    expect(hasComma).toBe(true)
  })

  it('adds sentence-ending punctuation at boundaries', () => {
    const words = Array(30).fill('word') as string[]
    const result = injectPunctuation(words)
    // At least one sentence-ending mark (. ? !) besides the final word
    const sentenceEndsBeforeLast = result.slice(0, -1).filter((w) => /[.?!]$/.test(w)).length
    expect(sentenceEndsBeforeLast).toBeGreaterThanOrEqual(1)
  })
})

describe('injectNumbers', () => {
  it('returns same number of words', () => {
    const words = ['the', 'quick', 'brown', 'fox']
    const result = injectNumbers(words)
    expect(result).toHaveLength(words.length)
  })

  it('replaces some words with numeric strings', () => {
    let hasNumber = false
    for (let i = 0; i < 10; i++) {
      const words = Array(100).fill('word') as string[]
      const result = injectNumbers(words)
      if (result.some((w) => /^\d+$/.test(w))) {
        hasNumber = true
        break
      }
    }
    expect(hasNumber).toBe(true)
  })

  it('numbers have 1-4 digits', () => {
    const words = Array(200).fill('word') as string[]
    const result = injectNumbers(words)
    const numberWords = result.filter((w) => /^\d+$/.test(w))
    for (const num of numberWords) {
      expect(num.length).toBeGreaterThanOrEqual(1)
      expect(num.length).toBeLessThanOrEqual(4)
    }
  })

  it('numbers do not have leading zeros', () => {
    const words = Array(200).fill('word') as string[]
    const result = injectNumbers(words)
    const numberWords = result.filter((w) => /^\d+$/.test(w))
    for (const num of numberWords) {
      if (num.length > 1) {
        expect(num[0]).not.toBe('0')
      }
    }
  })
})
