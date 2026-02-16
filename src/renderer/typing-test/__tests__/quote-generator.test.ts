// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { selectQuote, quoteToWords } from '../word-generator/quote-generator'
import type { Quote } from '../types'

describe('selectQuote', () => {
  it('returns a quote object with required fields', () => {
    const quote = selectQuote('all')
    expect(quote).toHaveProperty('id')
    expect(quote).toHaveProperty('text')
    expect(quote).toHaveProperty('source')
    expect(quote).toHaveProperty('length')
  })

  it('returns a short quote within range', () => {
    const quote = selectQuote('short')
    expect(quote.length).toBeLessThanOrEqual(100)
  })

  it('returns a medium quote within range', () => {
    const quote = selectQuote('medium')
    expect(quote.length).toBeGreaterThanOrEqual(101)
    expect(quote.length).toBeLessThanOrEqual(300)
  })

  it('returns a long quote within range', () => {
    const quote = selectQuote('long')
    expect(quote.length).toBeGreaterThanOrEqual(301)
  })

  it('returns any quote for "all" length', () => {
    const quote = selectQuote('all')
    expect(quote.length).toBeGreaterThan(0)
  })
})

describe('quoteToWords', () => {
  it('splits quote text into words', () => {
    const quote: Quote = { id: 1, text: 'the quick brown fox', source: 'Test', length: 19 }
    const words = quoteToWords(quote)
    expect(words).toEqual(['the', 'quick', 'brown', 'fox'])
  })

  it('preserves original capitalization', () => {
    const quote: Quote = { id: 1, text: 'The Quick Brown Fox', source: 'Test', length: 19 }
    const words = quoteToWords(quote)
    expect(words).toEqual(['The', 'Quick', 'Brown', 'Fox'])
  })

  it('preserves allowed punctuation', () => {
    const quote: Quote = { id: 1, text: "hello, world. it's fine", source: 'Test', length: 23 }
    const words = quoteToWords(quote)
    expect(words).toEqual(['hello,', 'world.', "it's", 'fine'])
  })

  it('preserves typeable symbols and strips non-typeable ones', () => {
    const quote: Quote = { id: 1, text: 'hello! world? yes\u2014no', source: 'Test', length: 21 }
    const words = quoteToWords(quote)
    expect(words).toEqual(['hello!', 'world?', 'yesno'])
  })

  it('only contains allowed characters', () => {
    const quote: Quote = {
      id: 1,
      text: "Some QUOTE with special chars! @#$ and 123, too; it's fine.",
      source: 'Test',
      length: 55,
    }
    const words = quoteToWords(quote)
    for (const word of words) {
      expect(word).toMatch(/^[a-zA-Z0-9.,;!?:'"()\-/@#$%^&*_+=\[\]{}|\\`~<>]+$/)
    }
  })

  it('preserves exclamation and question marks', () => {
    const quote: Quote = { id: 1, text: 'Hello! How are you?', source: 'Test', length: 19 }
    const words = quoteToWords(quote)
    expect(words).toEqual(['Hello!', 'How', 'are', 'you?'])
  })

  it('filters empty words from multiple spaces', () => {
    const quote: Quote = { id: 1, text: 'hello   world', source: 'Test', length: 13 }
    const words = quoteToWords(quote)
    expect(words).toEqual(['hello', 'world'])
  })
})
