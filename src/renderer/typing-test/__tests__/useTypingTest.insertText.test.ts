// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTypingTest } from '../useTypingTest'
import { clearLanguageCache, getLanguageData } from '../word-generator'
import type { TypingTestConfig } from '../types'
import type { TypingAnalyticsEventPayload } from '../../../shared/types/typing-analytics'

// `isRomajiInputActive` / `isKanaInputActive` only turn on for a real kana
// pack id, so the romaji/kana cases reuse one; the direct-input cases seed
// a made-up id with accented words.
const KANA_LANGUAGE = 'japanese_hiragana'
const ACCENT_LANGUAGE = 'insert_text_accent'

const mockLangGet = vi.fn()
const originalVialAPI = window.vialAPI

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  window.vialAPI = { ...(window.vialAPI ?? {}), langGet: mockLangGet } as unknown as typeof window.vialAPI
})

afterEach(() => {
  window.vialAPI = originalVialAPI
  vi.useRealTimers()
})

/** Caches `name` with a single-word list so every sampled word is `words[0]`. */
async function seedLanguage(name: string, words: string[]): Promise<void> {
  clearLanguageCache(name)
  mockLangGet.mockResolvedValueOnce({ name, rightToLeft: false, orderedByFrequency: false, words })
  await getLanguageData(name)
}

const wordsConfig = (extra: Partial<Extract<TypingTestConfig, { mode: 'words' }>> = {}): TypingTestConfig => ({
  mode: 'words',
  wordCount: 1,
  punctuation: false,
  numbers: false,
  romajiInput: false,
  ...extra,
})

function renderWithSink(config: TypingTestConfig) {
  const sink = vi.fn<(payload: TypingAnalyticsEventPayload) => void>()
  const { result } = renderHook(() => useTypingTest(config, ACCENT_LANGUAGE, {
    onPrepareAnalyticsEvent: () => true,
    onEmitAnalyticsEvent: (_prepared: unknown, event: TypingAnalyticsEventPayload) => sink(event),
  }))
  return { result, sink }
}

describe('useTypingTest processInsertedText', () => {
  it('types a single inserted character like a keystroke and finishes the word', async () => {
    await seedLanguage(ACCENT_LANGUAGE, ['olá'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(), ACCENT_LANGUAGE))
    act(() => result.current.processKeyEvent('o', false, false, false))
    act(() => result.current.processKeyEvent('l', false, false, false))
    act(() => result.current.processInsertedText('á'))

    expect(result.current.state.status).toBe('finished')
    expect(result.current.state.wordResults).toEqual([{ word: 'olá', typed: 'olá', correct: true }])
    expect(result.current.state.totalKeystrokes).toBe(3)
    expect(result.current.state.kspcUncomputable).toBe(false)
  })

  it('starts the run from waiting and emits one char analytics event', async () => {
    await seedLanguage(ACCENT_LANGUAGE, ['ó'])
    const { result, sink } = renderWithSink(wordsConfig({ wordCount: 2 }))
    expect(result.current.state.status).toBe('waiting')
    act(() => result.current.processInsertedText('ó'))

    expect(result.current.state.status).toBe('running')
    expect(result.current.state.currentInput).toBe('ó')
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0][0]).toMatchObject({ kind: 'char', key: 'ó' })
  })

  it.each([
    ['a surrogate pair', '😀'],
    ['a multi-character commit', '東京都'],
  ])('appends %s without counting keystrokes and marks KSPC uncomputable', async (_label, text) => {
    await seedLanguage(ACCENT_LANGUAGE, ['olá'])
    const { result, sink } = renderWithSink(wordsConfig({ wordCount: 2 }))
    act(() => result.current.processInsertedText(text))

    expect(result.current.state.status).toBe('running')
    expect(result.current.state.currentInput).toBe(text)
    expect(result.current.state.totalKeystrokes).toBe(0)
    expect(result.current.state.kspcUncomputable).toBe(true)
    expect(sink).not.toHaveBeenCalled()
  })

  it('does not advance the word when a multi-character commit contains a space', async () => {
    await seedLanguage(ACCENT_LANGUAGE, ['olá'])
    const { result } = renderHook(() => useTypingTest(wordsConfig({ wordCount: 2 }), ACCENT_LANGUAGE))
    act(() => result.current.processInsertedText('hello world'))

    expect(result.current.state.currentWordIndex).toBe(0)
    expect(result.current.state.currentInput).toBe('hello world')
  })

  it.each([
    ['romaji', wordsConfig({ romajiInput: true })],
    ['kana', wordsConfig({ romajiInput: true, romaji: { inputMethod: 'kana' } })],
  ])('ignores inserted text in %s input mode', async (_label, config) => {
    await seedLanguage(KANA_LANGUAGE, ['あ'])
    const { result } = renderHook(() => useTypingTest(config, KANA_LANGUAGE))
    act(() => result.current.processInsertedText('あ'))
    act(() => result.current.processInsertedText('a'))

    expect(result.current.state.status).toBe('waiting')
    expect(result.current.state.currentInput).toBe('')
    expect(result.current.state.romajiKeystrokes).toBe('')
    expect(result.current.state.kanaCharIndex).toBe(0)
    expect(result.current.state.totalKeystrokes).toBe(0)
    expect(result.current.state.kspcUncomputable).toBe(false)
  })
})
