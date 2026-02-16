// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { generateWordsSync, injectPunctuation, injectNumbers } from '../word-generator'

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

  it('adds periods at sentence boundaries', () => {
    const words = Array(30).fill('word') as string[]
    const result = injectPunctuation(words)
    // At least one period besides the final one
    const periodsBeforeLast = result.slice(0, -1).filter((w) => w.endsWith('.')).length
    expect(periodsBeforeLast).toBeGreaterThanOrEqual(1)
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
