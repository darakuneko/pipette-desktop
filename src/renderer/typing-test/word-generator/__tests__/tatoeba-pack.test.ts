// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getTatoebaPack,
  getTatoebaPackSync,
  tatoebaRun,
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

describe('tatoebaRun', () => {
  it('folds sampled sentences into one quote labelled by the pack name', () => {
    const words = Array.from({ length: 50 }, (_, i) => `Sentence number ${i}.`)
    const run = tatoebaRun({ name: 'english', words })

    expect(run.quote.source).toBe('english')
    expect(run.quote.length).toBe(run.quote.text.length)
    expect(run.quote.text.length).toBeGreaterThan(0)
    expect(run.quote.text).toBe(run.words.join(' '))
  })

  it('uses every sentence when the pack has fewer than the sample size', () => {
    const words = ['Only one.', 'And two.']
    const run = tatoebaRun({ name: 'small', words })
    expect(run.quote.text).toBe('Only one. And two.')
    expect(run.words).toEqual(['Only', 'one.', 'And', 'two.'])
    // Break after the first sentence's last word (index 1); none after the
    // final sentence.
    expect(run.lineBreaks).toEqual([1])
  })

  it('returns an empty run for an empty pack', () => {
    const run = tatoebaRun({ name: 'empty', words: [] })
    expect(run.words).toEqual([])
    expect(run.lineBreaks).toEqual([])
    expect(run.quote.text).toBe('')
    expect(run.quote.length).toBe(0)
  })

  it('samples exactly the configured number of sentences from a large pack', () => {
    const words = Array.from({ length: 100 }, (_, i) => `s${i}`)
    const run = tatoebaRun({ name: 'big', words })
    // Every sentence here is a single space-free token, so word count
    // equals the sampled sentence count.
    expect(run.words).toHaveLength(TATOEBA_SENTENCE_COUNT)
  })

  it('places a line break on every sentence boundary except the final one, across mixed scripts', () => {
    // Mix of multi-word English sentences and space-free Japanese
    // sentences (each Japanese sentence collapses to a single "word").
    const words = ['One two three.', 'いい天気ですね。', 'Four five.', 'すぐに終わりますよ。']
    const run = tatoebaRun({ name: 'mixed', words })

    expect(run.words).toEqual(['One', 'two', 'three.', 'いい天気ですね。', 'Four', 'five.', 'すぐに終わりますよ。'])
    // Sentence-last-word indices: 2 (three.), 3 (いい天気ですね。), 5 (five.) —
    // the final sentence's break is dropped.
    expect(run.lineBreaks).toEqual([2, 3, 5])
  })

  it('gives a single-sentence pack no line breaks', () => {
    const run = tatoebaRun({ name: 'solo', words: ['ab cd'] })
    expect(run.words).toEqual(['ab', 'cd'])
    expect(run.lineBreaks).toEqual([])
  })

  it('keeps non-ASCII characters intact — regression for the ASCII-strip bug', () => {
    // Real sentences from the Tatoeba japanese pack (CC BY 2.0 FR). A
    // quoteToWords()-based tokenizer would whitelist-strip everything but
    // ASCII, collapsing sentences like these down to a single stray digit.
    const words = [
      '「0℃！ やばい熱ある」「かわいそうな雪だるまさん」',
      '「いい考えね」と思ったのは３名だけでした。',
    ]
    const run = tatoebaRun({ name: 'japanese', words })

    expect(run.words.join('')).not.toBe('0')
    expect(run.words.some((w) => w.includes('やばい'))).toBe(true)
    expect(run.words.some((w) => w.includes('思ったのは３名だけでした。'))).toBe(true)
  })

  it('splits on whitespace without stripping punctuation/accents', () => {
    const run = tatoebaRun({ name: 'french', words: ["C'est très bien.", 'Où est-il ?'] })
    expect(run.words).toEqual(["C'est", 'très', 'bien.', 'Où', 'est-il', '?'])
  })
})
