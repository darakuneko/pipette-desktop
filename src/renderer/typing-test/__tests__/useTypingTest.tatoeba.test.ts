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

describe('useTypingTest — tatoeba mode', () => {
  it('plays a downloaded pack as word-flow (no line breaks) and finishes on the last char', async () => {
    // A single-sentence pack makes the sampled quote deterministic (the
    // sampler returns the whole list when it is smaller than the batch size).
    mockLangGet.mockResolvedValue({ name: 'english-x', words: ['ab cd'] })
    // Warm the cache so the hook's synchronous initial state has the words.
    await getTatoebaPack('english-x')

    const { result } = renderHook(() => useTypingTest({ mode: 'tatoeba', language: 'english-x' }, 'english'))

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
      await result.current.setConfig({ mode: 'tatoeba', language: 'english-y' })
    })

    expect(result.current.config).toEqual({ mode: 'tatoeba', language: 'english-y' })
    expect(result.current.state.words).toEqual(['hi', 'yo'])
    expect(mockLangGet).toHaveBeenCalledWith('english-y', 'tatoeba')
  })

  it('yields no words when the pack is not downloaded', async () => {
    mockLangGet.mockResolvedValue(null)

    const { result } = renderHook(() => useTypingTest({ mode: 'words', wordCount: 5, punctuation: false, numbers: false }, 'english'))

    await act(async () => {
      await result.current.setConfig({ mode: 'tatoeba', language: 'missing' })
    })

    expect(result.current.state.words).toEqual([])
  })
})
