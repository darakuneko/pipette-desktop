// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getTatoebaPack,
  getTatoebaPackSync,
  tatoebaQuote,
  tatoebaQuoteToWords,
  TATOEBA_SENTENCE_COUNT,
} from '../tatoeba-pack'

const mockLangGet = vi.fn()
const originalVialAPI = window.vialAPI

beforeEach(() => {
  vi.clearAllMocks()
  window.vialAPI = {
    ...(window.vialAPI ?? {}),
    langGet: mockLangGet,
  } as unknown as typeof window.vialAPI
})

afterEach(() => {
  window.vialAPI = originalVialAPI
})

describe('getTatoebaPack', () => {
  it('fetches the tatoeba provider via IPC, validates, and caches', async () => {
    const pack = { name: 'english', words: ['Hello there.', 'How are you?'] }
    mockLangGet.mockResolvedValue(pack)

    // Unique language key per test avoids the module-level cache leaking.
    const first = await getTatoebaPack('english-a')
    expect(first).toEqual(pack)
    expect(mockLangGet).toHaveBeenCalledWith('english-a', 'tatoeba')

    // Second call served from cache — no extra IPC.
    const second = await getTatoebaPack('english-a')
    expect(second).toBe(first)
    expect(mockLangGet).toHaveBeenCalledTimes(1)
    expect(getTatoebaPackSync('english-a')).toBe(first)
  })

  it('returns undefined for a malformed pack and does not cache', async () => {
    mockLangGet.mockResolvedValue({ name: 'english' }) // missing words
    expect(await getTatoebaPack('english-b')).toBeUndefined()
    expect(getTatoebaPackSync('english-b')).toBeUndefined()

    mockLangGet.mockResolvedValue(null)
    expect(await getTatoebaPack('english-c')).toBeUndefined()
  })
})

describe('tatoebaQuote', () => {
  it('folds sampled sentences into one quote labelled by the pack name', () => {
    const words = Array.from({ length: 50 }, (_, i) => `Sentence number ${i}.`)
    const quote = tatoebaQuote({ name: 'english', words })

    expect(quote.source).toBe('english')
    expect(quote.length).toBe(quote.text.length)
    expect(quote.text.length).toBeGreaterThan(0)
    // Every sampled sentence comes from the pack.
    for (const sentence of quote.text.split('. ').map((s) => (s.endsWith('.') ? s : `${s}.`))) {
      expect(words).toContain(sentence)
    }
  })

  it('uses every sentence when the pack has fewer than the sample size', () => {
    const words = ['Only one.', 'And two.']
    const quote = tatoebaQuote({ name: 'small', words })
    expect(quote.text).toBe('Only one. And two.')
  })

  it('returns an empty quote for an empty pack', () => {
    const quote = tatoebaQuote({ name: 'empty', words: [] })
    expect(quote.text).toBe('')
    expect(quote.length).toBe(0)
  })

  it('samples exactly the configured number of sentences from a large pack', () => {
    const words = Array.from({ length: 100 }, (_, i) => `s${i}`)
    const quote = tatoebaQuote({ name: 'big', words })
    // Joined by single spaces; no sentence here contains a space, so token
    // count equals the sampled sentence count.
    expect(quote.text.split(' ')).toHaveLength(TATOEBA_SENTENCE_COUNT)
  })
})

describe('tatoebaQuoteToWords', () => {
  it('keeps non-ASCII characters intact — regression for the ASCII-strip bug', () => {
    // Real sentences from the Tatoeba japanese pack (CC BY 2.0 FR). The old
    // quoteToWords()-based tokenizer whitelist-stripped everything but ASCII,
    // collapsing sentences like these down to a single stray digit.
    const words = [
      '「0℃！ やばい熱ある」「かわいそうな雪だるまさん」',
      '「いい考えね」と思ったのは３名だけでした。',
    ]
    const quote = tatoebaQuote({ name: 'japanese', words })

    const tokens = tatoebaQuoteToWords(quote)

    expect(tokens.join('')).not.toBe('0')
    expect(tokens.some((t) => t.includes('やばい'))).toBe(true)
    expect(tokens.some((t) => t.includes('思ったのは３名だけでした。'))).toBe(true)
  })

  it('splits on whitespace without stripping punctuation/accents', () => {
    const quote = tatoebaQuote({ name: 'french', words: ["C'est très bien.", 'Où est-il ?'] })
    const tokens = tatoebaQuoteToWords(quote)
    expect(tokens).toEqual(["C'est", 'très', 'bien.', 'Où', 'est-il', '?'])
  })

  it('returns no tokens for an empty quote', () => {
    const quote = tatoebaQuote({ name: 'empty', words: [] })
    expect(tatoebaQuoteToWords(quote)).toEqual([])
  })
})
