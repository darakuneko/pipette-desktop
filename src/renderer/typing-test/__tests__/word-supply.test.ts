// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWordsForConfigSync, createWordsForConfig, refillTimeModeWords } from '../word-supply'
import { getTatoebaPack } from '../word-generator'
import type { TypingTestConfig } from '../types'

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

describe('createWordsForConfig(Sync) — tatoeba', () => {
  it('Lines pattern samples exactly lineCount sentences', async () => {
    // Single-word "sentences" so the sampled word count equals the sampled
    // sentence count regardless of sampling order.
    const words = Array.from({ length: 100 }, (_, i) => `s${i}`)
    mockLangGet.mockResolvedValue({ name: 'lines-pack', words })
    await getTatoebaPack('lines-pack')

    const config: TypingTestConfig = { mode: 'tatoeba', language: 'lines-pack', pattern: 'lines', lineCount: 10, duration: 30 }
    expect(createWordsForConfigSync(config, 'english').words).toHaveLength(10)
    expect((await createWordsForConfig(config, 'english')).words).toHaveLength(10)
  })

  it('a different lineCount samples a different count', async () => {
    const words = Array.from({ length: 100 }, (_, i) => `s${i}`)
    mockLangGet.mockResolvedValue({ name: 'lines-pack-2', words })
    await getTatoebaPack('lines-pack-2')

    const config: TypingTestConfig = { mode: 'tatoeba', language: 'lines-pack-2', pattern: 'lines', lineCount: 40, duration: 30 }
    expect(createWordsForConfigSync(config, 'english').words).toHaveLength(40)
  })

  it('Time pattern samples the fixed initial time batch, independent of lineCount', async () => {
    const words = Array.from({ length: 100 }, (_, i) => `s${i}`)
    mockLangGet.mockResolvedValue({ name: 'time-pack', words })
    await getTatoebaPack('time-pack')

    // lineCount is set to an unrelated value — the Time pattern must ignore
    // it and sample its own fixed batch size (20, see TATOEBA_TIME_BATCH_SIZE
    // in word-supply.ts).
    const config: TypingTestConfig = { mode: 'tatoeba', language: 'time-pack', pattern: 'time', lineCount: 5, duration: 30 }
    expect(createWordsForConfigSync(config, 'english').words).toHaveLength(20)
    expect((await createWordsForConfig(config, 'english')).words).toHaveLength(20)
  })
})

describe('refillTimeModeWords', () => {
  it('returns null when the untyped tail is still above the low-water threshold', () => {
    const config: TypingTestConfig = { mode: 'time', duration: 30, punctuation: false, numbers: false }
    const words = Array.from({ length: 20 }, (_, i) => `w${i}`)
    expect(refillTimeModeWords(words, 5, config, 'english')).toBeNull()
  })

  it('monkeytype time: extends with a fresh batch and no line breaks', () => {
    const config: TypingTestConfig = { mode: 'time', duration: 30, punctuation: false, numbers: false }
    const words = Array.from({ length: 10 }, (_, i) => `w${i}`)
    const refill = refillTimeModeWords(words, 8, config, 'english')
    expect(refill).not.toBeNull()
    expect(refill!.words.length).toBeGreaterThan(words.length)
    expect(refill!.words.slice(0, words.length)).toEqual(words)
    expect(refill!.lineBreaks).toEqual([])
  })

  it('non-time-bounded configs (e.g. tatoeba Lines) never refill', () => {
    const config: TypingTestConfig = { mode: 'tatoeba', language: 'x', pattern: 'lines', lineCount: 5, duration: 30 }
    const words = Array.from({ length: 2 }, (_, i) => `w${i}`)
    expect(refillTimeModeWords(words, 1, config, 'english')).toBeNull()
  })

  it('tatoeba time: returns null when the pack is not cached', () => {
    const config: TypingTestConfig = { mode: 'tatoeba', language: 'not-cached', pattern: 'time', lineCount: 5, duration: 30 }
    const words = Array.from({ length: 2 }, (_, i) => `w${i}`)
    expect(refillTimeModeWords(words, 1, config, 'english')).toBeNull()
  })

  it('tatoeba time: extends with more sentences and stitches a seam line break at the old tail', async () => {
    // A pack small enough that the sampler deterministically returns every
    // sentence in order (see tatoeba-pack.test.ts's own coverage of that
    // fallback) — makes the refill's exact shape predictable.
    const words = ['s0a s0b', 's1a s1b', 's2a s2b']
    mockLangGet.mockResolvedValue({ name: 'refill-pack', words })
    await getTatoebaPack('refill-pack')

    const config: TypingTestConfig = { mode: 'tatoeba', language: 'refill-pack', pattern: 'time', lineCount: 5, duration: 30 }
    const initial = createWordsForConfigSync(config, 'english')
    // TATOEBA_TIME_BATCH_SIZE (20) exceeds the pack's 3 sentences, so the
    // initial batch is every sentence in order: 6 words, breaks after the
    // first two sentences (1, 3), none after the last (5).
    expect(initial.words).toEqual(['s0a', 's0b', 's1a', 's1b', 's2a', 's2b'])
    expect(initial.lineBreaks).toEqual([1, 3])

    const refill = refillTimeModeWords(initial.words, 1, config, 'english')
    expect(refill).not.toBeNull()
    // Same 3 sentences appended again (deterministic small-pack sampling).
    expect(refill!.words).toEqual([
      's0a', 's0b', 's1a', 's1b', 's2a', 's2b', 's0a', 's0b', 's1a', 's1b', 's2a', 's2b',
    ])
    // The seam (5, the old last word) plus the new batch's own internal
    // breaks offset by 6 (7, 9).
    expect(refill!.lineBreaks.slice().sort((a, b) => a - b)).toEqual([5, 7, 9])
  })
})
