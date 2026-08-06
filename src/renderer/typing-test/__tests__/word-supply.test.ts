// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWordsForConfigSync, createWordsForConfig, refillTimeModeWords } from '../word-supply'
import { getTatoebaPack, getLanguageData } from '../word-generator'
import type { TypingTestConfig } from '../types'
import type { WeakSpotBiasProfile } from '../word-generator/weak-spot-weighting'

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

  it('monkeytype time: given the seedLastRawWord it was asked for, never repeats it as the refill\'s first word', () => {
    // Explicitly threading the seed (the 6th arg) — without it, the retry
    // loop has nothing to compare against and this proves nothing.
    const config: TypingTestConfig = { mode: 'time', duration: 30, punctuation: false, numbers: false }
    for (let i = 0; i < 20; i++) {
      const seedBatch = createWordsForConfigSync(config, 'english')
      const tailWord = seedBatch.words[seedBatch.words.length - 1]
      const words = [tailWord]
      const refill = refillTimeModeWords(words, 0, config, 'english', undefined, tailWord)
      expect(refill).not.toBeNull()
      expect(refill!.words[1]).not.toBe(tailWord)
    }
  })

  // codex regression: refillTimeModeWords used to seed its own repeat-
  // avoidance with `words[words.length - 1]` — the DECORATED tail of the
  // PREVIOUS batch (post injectPunctuation/injectNumbers) — while
  // sampleWords always compares that seed against RAW candidates pulled
  // straight from the language word list. A decorated seed (capitalized /
  // trailing punctuation / digit-replaced) almost never string-matches a
  // raw candidate, so the anti-repeat check silently became a no-op across
  // every refill boundary whenever punctuation/numbers was on — a refill
  // could immediately re-draw the exact same source word that just ended
  // the previous batch. The fix threads the RAW word via
  // `WordsForConfig.lastRawWord`/`TypingTestState.lastRawWord` instead of
  // reading it off the decorated `words` tail.
  it('with punctuation ON, a refill never repeats the previous batch\'s RAW source word at the boundary', async () => {
    // Normalizes ONLY for this test's own comparison (never in production
    // code) — strips capitalization (injectPunctuation always capitalizes
    // the first word of a new batch) and any trailing sentence/comma
    // punctuation, to recover the underlying source word from a decorated
    // one so the boundary check can compare like-for-like against the
    // already-raw `lastRawWord`.
    const stripDecoration = (word: string): string => word.toLowerCase().replace(/[.,!?]+$/, '')

    // A tiny 3-word pack (not 'english's 200 words) so a raw collision at
    // the boundary is near-certain without the fix (~1/3 chance per trial
    // instead of ~1/200) — this is what makes the test actually catch a
    // regression, not just pass by the large word list's own low collision
    // odds.
    const words3 = ['alpha', 'bravo', 'charlie']
    mockLangGet.mockResolvedValue({ name: 'tiny-punct-pack', words: words3 })
    await getLanguageData('tiny-punct-pack')

    const config: TypingTestConfig = { mode: 'time', duration: 30, punctuation: true, numbers: false }
    for (let i = 0; i < 30; i++) {
      const seedBatch = createWordsForConfigSync(config, 'tiny-punct-pack')
      expect(seedBatch.lastRawWord).toBeDefined()
      expect(words3).toContain(seedBatch.lastRawWord)
      // Sanity: lastRawWord is genuinely the undecorated source word, not
      // a copy of the (possibly punctuated) decorated tail.
      expect(seedBatch.lastRawWord).toBe(stripDecoration(seedBatch.lastRawWord!))

      // Minimal "words so far" array (below TIME_MODE_EXTEND_THRESHOLD so
      // the refill actually fires) — its one entry is the DECORATED tail
      // (what `state.words` would really hold), while the seed passed
      // alongside is the separately-tracked RAW form, exactly how
      // `advanceAfterWord` threads `TypingTestState.lastRawWord` in.
      const decoratedTail = seedBatch.words[seedBatch.words.length - 1]
      const refill = refillTimeModeWords([decoratedTail], 0, config, 'tiny-punct-pack', undefined, seedBatch.lastRawWord)
      expect(refill).not.toBeNull()
      const firstOfRefill = refill!.words[1]
      expect(stripDecoration(firstOfRefill)).not.toBe(seedBatch.lastRawWord)
    }
  })

  it('monkeytype time: threads a weakSpotProfile into the refill batch (biases toward matched words)', () => {
    const config: TypingTestConfig = { mode: 'time', duration: 30, punctuation: false, numbers: false }
    const profile: WeakSpotBiasProfile = { inputMethod: 'direct', weights: { e: 1000 } }
    const words = Array.from({ length: 10 }, (_, i) => `w${i}`)
    const refill = refillTimeModeWords(words, 8, config, 'english', profile)
    expect(refill).not.toBeNull()
    const refilledOnly = refill!.words.slice(words.length)
    const withE = refilledOnly.filter((w) => w.includes('e')).length
    expect(withE / refilledOnly.length).toBeGreaterThan(0.5)
  })

  it('tatoeba time refill ignores a weakSpotProfile entirely (explicitly gated out)', async () => {
    const words = ['s0a s0b', 's1a s1b', 's2a s2b']
    mockLangGet.mockResolvedValue({ name: 'weakspot-gate-pack', words })
    await getTatoebaPack('weakspot-gate-pack')
    const config: TypingTestConfig = { mode: 'tatoeba', language: 'weakspot-gate-pack', pattern: 'time', lineCount: 5, duration: 30 }
    const initial = createWordsForConfigSync(config, 'english')
    const profile: WeakSpotBiasProfile = { inputMethod: 'direct', weights: { zzz: 999 } }
    // Same deterministic-small-pack shape as the unbiased test above —
    // passing a profile must not change the tatoeba branch's own output.
    const refill = refillTimeModeWords(initial.words, 1, config, 'english', profile)
    expect(refill).not.toBeNull()
    expect(refill!.words).toEqual([
      's0a', 's0b', 's1a', 's1b', 's2a', 's2b', 's0a', 's0b', 's1a', 's1b', 's2a', 's2b',
    ])
  })
})

describe('createWordsForConfig(Sync) — weakSpotProfile gating', () => {
  const profile: WeakSpotBiasProfile = { inputMethod: 'direct', weights: { e: 1000 } }

  it('quote mode ignores a weakSpotProfile (fixed corpus, not this module\'s sampler)', () => {
    const config: TypingTestConfig = { mode: 'quote', quoteLength: 'medium' }
    // Must not throw and must produce the same shape as without a profile.
    const withProfile = createWordsForConfigSync(config, 'english', profile)
    expect(withProfile.words.length).toBeGreaterThan(0)
  })

  it('words mode threads the profile into sampling (biases toward matched words)', () => {
    const config: TypingTestConfig = { mode: 'words', wordCount: 300, punctuation: false, numbers: false }
    const result = createWordsForConfigSync(config, 'english', profile)
    const withE = result.words.filter((w) => w.includes('e')).length
    expect(withE / result.words.length).toBeGreaterThan(0.5)
  })

  it('time mode (initial batch) threads the profile into sampling too', async () => {
    const config: TypingTestConfig = { mode: 'time', duration: 30, punctuation: false, numbers: false }
    const result = await createWordsForConfig(config, 'english', profile)
    const withE = result.words.filter((w) => w.includes('e')).length
    expect(withE / result.words.length).toBeGreaterThan(0.5)
  })
})
