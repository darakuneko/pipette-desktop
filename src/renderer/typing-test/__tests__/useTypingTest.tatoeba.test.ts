// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTypingTest } from '../useTypingTest'
import { getTatoebaPack } from '../word-generator'

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

const type = (result: { current: { processKeyEvent: (k: string, c: boolean, a: boolean, m: boolean) => void } }, key: string): void => {
  act(() => result.current.processKeyEvent(key, false, false, false))
}

/** Submits the current word with whichever key it actually expects — Enter
 *  at a sentence-end word, Space elsewhere (see `state.lineBreaks`). Tatoeba
 *  sentences don't all have the same word count, so a fixed Space/Enter
 *  loop would silently get stuck partway through a multi-sentence sample. */
const submitWord = (result: {
  current: { state: { currentWordIndex: number; lineBreaks: Set<number> }; processKeyEvent: (k: string, c: boolean, a: boolean, m: boolean) => void }
}): void => {
  const key = result.current.state.lineBreaks.has(result.current.state.currentWordIndex) ? 'Enter' : ' '
  type(result, key)
}

describe('useTypingTest — tatoeba mode', () => {
  it('plays a downloaded pack as word-flow (no line breaks) and finishes on the last char', async () => {
    // A single-sentence pack makes the sampled quote deterministic (the
    // sampler returns the whole list when it is smaller than the batch size).
    mockLangGet.mockResolvedValue({ name: 'english-x', words: ['ab cd'] })
    // Warm the cache so the hook's synchronous initial state has the words.
    await getTatoebaPack('english-x')

    const { result } = renderHook(() => useTypingTest({ mode: 'tatoeba', language: 'english-x', pattern: 'lines', lineCount: 5, duration: 30 }, 'english'))

    // Word-flow: sentence split into space-delimited tokens, no line breaks.
    expect(result.current.state.words).toEqual(['ab', 'cd'])
    expect([...result.current.state.lineBreaks]).toEqual([])
    expect(result.current.state.currentQuote?.source).toBe('english-x')

    // Space advances between words; Enter is ignored (word-flow, not line-row).
    type(result, 'a')
    type(result, 'b')
    type(result, 'Enter') // ignored in word-flow modes
    expect(result.current.state.currentWordIndex).toBe(0)
    type(result, ' ')
    expect(result.current.state.currentWordIndex).toBe(1)

    // Last word finishes on the final character (no trailing separator).
    type(result, 'c')
    type(result, 'd')
    expect(result.current.state.status).toBe('finished')
  })

  it('loads the pack asynchronously when switching into tatoeba mode', async () => {
    mockLangGet.mockResolvedValue({ name: 'english-y', words: ['hi yo'] })

    const { result } = renderHook(() => useTypingTest({ mode: 'words', wordCount: 5, punctuation: false, numbers: false }, 'english'))

    await act(async () => {
      await result.current.setConfig({ mode: 'tatoeba', language: 'english-y', pattern: 'lines', lineCount: 5, duration: 30 })
    })

    expect(result.current.config).toEqual({ mode: 'tatoeba', language: 'english-y', pattern: 'lines', lineCount: 5, duration: 30 })
    expect(result.current.state.words).toEqual(['hi', 'yo'])
    expect(mockLangGet).toHaveBeenCalledWith('english-y', 'tatoeba')
  })

  it('yields no words when the pack is not downloaded', async () => {
    mockLangGet.mockResolvedValue(null)

    const { result } = renderHook(() => useTypingTest({ mode: 'words', wordCount: 5, punctuation: false, numbers: false }, 'english'))

    await act(async () => {
      await result.current.setConfig({ mode: 'tatoeba', language: 'missing', pattern: 'lines', lineCount: 5, duration: 30 })
    })

    expect(result.current.state.words).toEqual([])
  })

  it('plays a Japanese pack without ASCII-stripping the sentences (regression)', async () => {
    // Real sentence from the Tatoeba japanese pack (CC BY 2.0 FR). Before the
    // tokenizer fix this collapsed to a single stray '0' via quoteToWords'
    // ASCII whitelist.
    mockLangGet.mockResolvedValue({
      name: 'japanese',
      words: ['「0℃！ やばい熱ある」「かわいそうな雪だるまさん」'],
    })
    await getTatoebaPack('japanese-regression')

    const { result } = renderHook(() => useTypingTest({ mode: 'tatoeba', language: 'japanese-regression', pattern: 'lines', lineCount: 5, duration: 30 }, 'english'))

    expect(result.current.state.words.join('')).not.toBe('0')
    expect(result.current.state.words.some((w) => w.includes('やばい'))).toBe(true)
  })

  it('renders each sampled sentence as its own line and advances past a sentence-end word on Enter, not Space', async () => {
    // Two sentences, both under TATOEBA_SENTENCE_COUNT, so the sampler keeps
    // the whole list in order (deterministic): words = ['ab', 'cd', 'ef'],
    // lineBreaks = [1] (after 'cd', the first sentence's last word).
    mockLangGet.mockResolvedValue({ name: 'english-z', words: ['ab cd', 'ef'] })
    await getTatoebaPack('english-z')

    const { result } = renderHook(() => useTypingTest({ mode: 'tatoeba', language: 'english-z', pattern: 'lines', lineCount: 5, duration: 30 }, 'english'))

    expect(result.current.state.words).toEqual(['ab', 'cd', 'ef'])
    expect([...result.current.state.lineBreaks]).toEqual([1])

    // Word 0 ('ab') is not a sentence-end word: Space advances, Enter is a no-op.
    type(result, 'a')
    type(result, 'Enter')
    expect(result.current.state.currentWordIndex).toBe(0)
    type(result, ' ')
    expect(result.current.state.currentWordIndex).toBe(1)

    // Word 1 ('cd') is the sentence-end word: Space is a no-op, Enter advances.
    type(result, 'c')
    type(result, ' ')
    expect(result.current.state.currentWordIndex).toBe(1)
    type(result, 'Enter')
    expect(result.current.state.currentWordIndex).toBe(2)
  })
})

describe('useTypingTest — tatoeba Lines pattern is bounded to lineCount sentences', () => {
  it('finishes once every sampled word is typed, never refilling', async () => {
    // A pack far larger than lineCount — the Lines pattern must sample
    // exactly lineCount sentences and finish there, not keep extending
    // like the Time pattern does.
    const words = Array.from({ length: 100 }, (_, i) => `s${i}`)
    mockLangGet.mockResolvedValue({ name: 'lines-bounded', words })
    await getTatoebaPack('lines-bounded')

    const { result } = renderHook(() => useTypingTest(
      { mode: 'tatoeba', language: 'lines-bounded', pattern: 'lines', lineCount: 3, duration: 30 },
      'english',
    ))

    expect(result.current.state.words).toHaveLength(3)

    for (let i = 0; i < 2; i++) {
      type(result, 'a')
      submitWord(result)
    }
    expect(result.current.state.status).toBe('running')
    expect(result.current.state.currentWordIndex).toBe(2)
    expect(result.current.state.words).toHaveLength(3) // no refill

    // Last word finishes on its final character (no trailing separator).
    const lastWord = result.current.state.words[2]
    for (const ch of lastWord) type(result, ch)
    expect(result.current.state.status).toBe('finished')
  })
})

describe('useTypingTest — tatoeba Time pattern', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('counts down and finishes at the configured duration', async () => {
    const words = Array.from({ length: 30 }, (_, i) => `s${i}`)
    mockLangGet.mockResolvedValue({ name: 'time-countdown', words })
    await getTatoebaPack('time-countdown')

    const { result } = renderHook(() => useTypingTest(
      { mode: 'tatoeba', language: 'time-countdown', pattern: 'time', lineCount: 5, duration: 15 },
      'english',
    ))

    expect(result.current.remainingSeconds).toBe(15)

    act(() => result.current.processKeyEvent('s', false, false, false))
    expect(result.current.state.status).toBe('running')

    act(() => vi.advanceTimersByTime(15000))
    expect(result.current.state.status).toBe('finished')
    expect(result.current.remainingSeconds).toBe(0)
  })

  it('never finishes from completing all sampled words — only the timer ends it', async () => {
    const words = ['s0a s0b', 's1a s1b', 's2a s2b']
    mockLangGet.mockResolvedValue({ name: 'time-no-word-finish', words })
    await getTatoebaPack('time-no-word-finish')

    const { result } = renderHook(() => useTypingTest(
      { mode: 'tatoeba', language: 'time-no-word-finish', pattern: 'time', lineCount: 5, duration: 120 },
      'english',
    ))

    const initialWordCount = result.current.state.words.length
    const submitCount = initialWordCount + 2
    for (let i = 0; i < submitCount; i++) {
      type(result, 'a')
      submitWord(result)
    }

    // Ran clean through (and past) the initial batch — refilled, not finished.
    expect(result.current.state.currentWordIndex).toBe(submitCount)
    expect(result.current.state.status).toBe('running')
    expect(result.current.state.words.length).toBeGreaterThan(initialWordCount)
  })
})
