// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTypingTest } from '../useTypingTest'
import { getLanguageData } from '../word-generator'
import type { TypingTestConfig } from '../types'

const mockLangGet = vi.fn()
const originalVialAPI = window.vialAPI

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  window.vialAPI = {
    ...(window.vialAPI ?? {}),
    langGet: mockLangGet,
  } as unknown as typeof window.vialAPI
})

afterEach(() => {
  window.vialAPI = originalVialAPI
})

type Pressable = { current: { processKeyEvent: (key: string, ctrlKey: boolean, altKey: boolean, metaKey: boolean) => void } }

function press(result: Pressable, key: string): void {
  act(() => result.current.processKeyEvent(key, false, false, false))
}

function type(result: Pressable, keys: string): void {
  for (const key of keys) press(result, key)
}

/** Pre-warm the word-generator language cache with a single-word list so
 *  `sampleWords` deterministically returns that one word `wordCount` times
 *  (its no-repeat-last-word logic only applies to lists with 2+ entries) —
 *  giving each test full control over the kana the matcher judges against. */
async function seedKanaLanguage(name: string, words: string[]): Promise<void> {
  mockLangGet.mockResolvedValueOnce({
    name,
    rightToLeft: false,
    orderedByFrequency: false,
    bcp47: 'ja',
    words,
  })
  await getLanguageData(name)
}

const wordsConfig = (wordCount: number): TypingTestConfig => ({
  mode: 'words',
  wordCount,
  punctuation: false,
  numbers: false,
  romajiInput: true,
})

const timeConfig = (duration: number): TypingTestConfig => ({
  mode: 'time',
  duration,
  punctuation: false,
  numbers: false,
  romajiInput: true,
})

describe('useTypingTest — romaji input mode', () => {
  it('completes a word via its digraph spelling, counting every keystroke as correct', async () => {
    await seedKanaLanguage('romaji-digraph', ['でぃなーにいく'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(1), 'romaji-digraph'))
    expect(result.current.state.words).toEqual(['でぃなーにいく'])

    type(result, 'dhina-niiku')

    expect(result.current.state.status).toBe('finished')
    expect(result.current.state.correctChars).toBe('dhina-niiku'.length)
    expect(result.current.state.incorrectChars).toBe(0)
    expect(result.current.state.wordResults).toEqual([
      { word: 'でぃなーにいく', typed: 'dhina-niiku', correct: true },
    ])
  })

  it('completes the same word via a decomposed small-kana spelling (dexi)', async () => {
    await seedKanaLanguage('romaji-decomposed', ['でぃなーにいく'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(1), 'romaji-decomposed'))

    type(result, 'dexina-niiku')

    expect(result.current.state.status).toBe('finished')
    expect(result.current.state.correctChars).toBe('dexina-niiku'.length)
    expect(result.current.state.incorrectChars).toBe(0)
  })

  it('rejects an invalid keystroke without advancing the matcher, then continues correctly', async () => {
    await seedKanaLanguage('romaji-reject', ['か'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(1), 'romaji-reject'))

    press(result, 'x') // not a valid start for か (ka/ca)
    expect(result.current.state.incorrectChars).toBe(1)
    expect(result.current.state.correctChars).toBe(0)
    expect(result.current.state.status).toBe('running')

    type(result, 'ka')
    expect(result.current.state.status).toBe('finished')
    expect(result.current.state.correctChars).toBe(2)
    expect(result.current.state.incorrectChars).toBe(1)
  })

  it('auto-advances to the next word on completion, without a space press', async () => {
    await seedKanaLanguage('romaji-multi', ['あ'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(3), 'romaji-multi'))
    expect(result.current.state.words).toEqual(['あ', 'あ', 'あ'])

    press(result, 'a')
    expect(result.current.state.currentWordIndex).toBe(1)
    press(result, 'a')
    expect(result.current.state.currentWordIndex).toBe(2)
    press(result, 'a')

    expect(result.current.state.status).toBe('finished')
    expect(result.current.state.wordResults).toHaveLength(3)
    expect(result.current.state.wordResults.every((w) => w.correct)).toBe(true)
  })

  it('time mode refills the word supply once fewer than 10 words remain', async () => {
    await seedKanaLanguage('romaji-time', ['あ'])
    const { result } = renderHook(() => useTypingTest(timeConfig(120), 'romaji-time'))
    expect(result.current.state.words).toHaveLength(60)

    for (let i = 0; i < 51; i++) press(result, 'a')

    expect(result.current.state.currentWordIndex).toBe(51)
    expect(result.current.state.words).toHaveLength(120)
    expect(result.current.state.status).toBe('running')
  })

  it('ignores the submit key while waiting; a printable keystroke starts the run', async () => {
    await seedKanaLanguage('romaji-waiting', ['あ'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(2), 'romaji-waiting'))

    press(result, ' ')
    expect(result.current.state.status).toBe('waiting')
    expect(result.current.state.currentWordIndex).toBe(0)

    press(result, 'a')
    expect(result.current.state.status).toBe('running')
  })

  it('Backspace is a no-op and is not counted', async () => {
    await seedKanaLanguage('romaji-backspace', ['あい'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(1), 'romaji-backspace'))

    press(result, 'a')
    expect(result.current.state.correctChars).toBe(1)
    const keystrokesBefore = result.current.state.romajiKeystrokes

    press(result, 'Backspace')

    expect(result.current.state.correctChars).toBe(1)
    expect(result.current.state.incorrectChars).toBe(0)
    expect(result.current.state.romajiKeystrokes).toBe(keystrokesBefore)
    expect(result.current.state.currentWordIndex).toBe(0)
  })

  it('ignores IME composition input entirely', async () => {
    await seedKanaLanguage('romaji-composition', ['あい'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(1), 'romaji-composition'))

    act(() => result.current.processCompositionEnd('あ'))

    expect(result.current.state.status).toBe('waiting')
    expect(result.current.state.currentInput).toBe('')
    expect(result.current.state.romajiKeystrokes).toBe('')
  })

  it('leaves non-romaji words-mode behaviour unchanged', () => {
    const { result } = renderHook(() => useTypingTest({ mode: 'words', wordCount: 2, punctuation: false, numbers: false }, 'english'))
    const firstWord = result.current.state.words[0]

    type(result, firstWord)
    press(result, ' ')

    expect(result.current.state.currentWordIndex).toBe(1)
    expect(result.current.state.wordResults[0]).toEqual({ word: firstWord, typed: firstWord, correct: true })
  })
})
