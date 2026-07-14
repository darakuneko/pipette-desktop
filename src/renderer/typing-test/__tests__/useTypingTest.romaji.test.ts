// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTypingTest } from '../useTypingTest'
import { clearLanguageCache, getLanguageData, clearFileImportTextCache } from '../word-generator'
import type { TypingTestConfig, RomajiGuide } from '../types'
import { applyRomajiCaseStyle } from '../types'

// A real kana pack id (see ROMAJI_INPUT_LANGUAGES) is required everywhere a
// test wants the romaji matcher actually active: `romajiInput: true` alone
// is not enough — `isRomajiInputActive` also requires the active language
// to be a kana pack (see useTypingTest.ts). Every case below reseeds this
// same id with its own single-word list via `seedKanaLanguage`, which
// evicts the previous entry first.
const KANA_LANGUAGE = 'japanese_hiragana'

const mockLangGet = vi.fn()
const mockTypingTestTextStoreGet = vi.fn()
const originalVialAPI = window.vialAPI

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  clearFileImportTextCache()
  window.vialAPI = {
    ...(window.vialAPI ?? {}),
    langGet: mockLangGet,
    typingTestTextStoreGet: mockTypingTestTextStoreGet,
  } as unknown as typeof window.vialAPI
})

afterEach(() => {
  window.vialAPI = originalVialAPI
  clearFileImportTextCache()
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
 *  giving each test full control over the kana the matcher judges against.
 *  Evicts any entry already cached under `name` first: tests reuse the
 *  same real kana id (see `KANA_LANGUAGE`) with different word lists, and
 *  `getLanguageData` otherwise returns whatever is already cached without
 *  re-fetching. */
async function seedKanaLanguage(name: string, words: string[]): Promise<void> {
  clearLanguageCache(name)
  mockLangGet.mockResolvedValueOnce({
    name,
    rightToLeft: false,
    orderedByFrequency: false,
    bcp47: 'ja',
    words,
  })
  await getLanguageData(name)
}

// Narrowed to the words variant so spreads like `{ ...wordsConfig(1), romaji }`
// stay a single discriminated member instead of the whole config union.
const wordsConfig = (wordCount: number): Extract<TypingTestConfig, { mode: 'words' }> => ({
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
    await seedKanaLanguage(KANA_LANGUAGE, ['でぃなーにいく'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(1), KANA_LANGUAGE))
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
    await seedKanaLanguage(KANA_LANGUAGE, ['でぃなーにいく'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(1), KANA_LANGUAGE))

    type(result, 'dexina-niiku')

    expect(result.current.state.status).toBe('finished')
    expect(result.current.state.correctChars).toBe('dexina-niiku'.length)
    expect(result.current.state.incorrectChars).toBe(0)
  })

  it('rejects an invalid keystroke without advancing the matcher, then continues correctly', async () => {
    await seedKanaLanguage(KANA_LANGUAGE, ['か'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(1), KANA_LANGUAGE))

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
    await seedKanaLanguage(KANA_LANGUAGE, ['あ'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(3), KANA_LANGUAGE))
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
    await seedKanaLanguage(KANA_LANGUAGE, ['あ'])
    const { result } = renderHook(() => useTypingTest(timeConfig(120), KANA_LANGUAGE))
    expect(result.current.state.words).toHaveLength(60)

    for (let i = 0; i < 51; i++) press(result, 'a')

    expect(result.current.state.currentWordIndex).toBe(51)
    expect(result.current.state.words).toHaveLength(120)
    expect(result.current.state.status).toBe('running')
  })

  it('ignores the submit key while waiting; a printable keystroke starts the run', async () => {
    await seedKanaLanguage(KANA_LANGUAGE, ['あ'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(2), KANA_LANGUAGE))

    press(result, ' ')
    expect(result.current.state.status).toBe('waiting')
    expect(result.current.state.currentWordIndex).toBe(0)

    press(result, 'a')
    expect(result.current.state.status).toBe('running')
  })

  it('Backspace is a no-op and is not counted', async () => {
    await seedKanaLanguage(KANA_LANGUAGE, ['あい'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(1), KANA_LANGUAGE))

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
    await seedKanaLanguage(KANA_LANGUAGE, ['あい'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(1), KANA_LANGUAGE))

    act(() => result.current.processCompositionEnd('あ'))

    expect(result.current.state.status).toBe('waiting')
    expect(result.current.state.currentInput).toBe('')
    expect(result.current.state.romajiKeystrokes).toBe('')
  })

  it('exposes kanaCompleted alongside typed/remaining in the guide, advancing per committed segment', async () => {
    await seedKanaLanguage(KANA_LANGUAGE, ['でぃなー'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(1), KANA_LANGUAGE))

    expect(result.current.romajiGuide).toEqual({ typed: '', remaining: 'dhina-', kanaCompleted: 0, lookahead: [], showRow: true })

    press(result, 'd')
    press(result, 'h')
    press(result, 'i') // commits でぃ as one 2-kana digraph segment
    expect(result.current.romajiGuide).toEqual({ typed: 'dhi', remaining: 'na-', kanaCompleted: 2, lookahead: [], showRow: true })
  })

  it('previews the next word as lookahead by default (guideWordCount 2 = current + 1), shrinking near the end of the run', async () => {
    // Single-word lists sample deterministically (see sampleWords), so a
    // 3-word run against the same word gives full control over the queue
    // without needing to control random word selection.
    await seedKanaLanguage(KANA_LANGUAGE, ['あい'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(3), KANA_LANGUAGE))
    expect(result.current.state.words).toEqual(['あい', 'あい', 'あい'])

    // At word 0: only word 1 is upcoming (default guideWordCount 2 = current + 1 next).
    expect(result.current.romajiGuide?.lookahead).toEqual(['ai'])
    expect(result.current.romajiGuide?.showRow).toBe(true)

    type(result, 'ai')
    expect(result.current.state.currentWordIndex).toBe(1)
    // At word 1: word 2 remains upcoming.
    expect(result.current.romajiGuide?.lookahead).toEqual(['ai'])

    type(result, 'ai')
    expect(result.current.state.currentWordIndex).toBe(2)
    // At the last word: nothing left to preview.
    expect(result.current.romajiGuide?.lookahead).toEqual([])
  })

  it('hides the guide row and shows no lookahead when guideWordCount is 0', async () => {
    await seedKanaLanguage(KANA_LANGUAGE, ['あい'])
    const config = { ...wordsConfig(3), romaji: { guideWordCount: 0 } }
    const { result } = renderHook(() => useTypingTest(config, KANA_LANGUAGE))

    expect(result.current.romajiGuide?.lookahead).toEqual([])
    expect(result.current.romajiGuide?.showRow).toBe(false)
    // kanaCompleted still tracks progress even with the row hidden — the
    // coloring in WordDisplay must keep working at guideWordCount 0.
    expect(result.current.romajiGuide?.kanaCompleted).toBe(0)
  })

  it('shows the row with only the current word (no lookahead) when guideWordCount is 1', async () => {
    await seedKanaLanguage(KANA_LANGUAGE, ['あい'])
    const config = { ...wordsConfig(3), romaji: { guideWordCount: 1 } }
    const { result } = renderHook(() => useTypingTest(config, KANA_LANGUAGE))

    expect(result.current.romajiGuide?.lookahead).toEqual([])
    expect(result.current.romajiGuide?.showRow).toBe(true)
  })

  it('previews up to 2 upcoming words when guideWordCount is 3 (current + next two)', async () => {
    await seedKanaLanguage(KANA_LANGUAGE, ['あい'])
    const config = { ...wordsConfig(4), romaji: { guideWordCount: 3 } }
    const { result } = renderHook(() => useTypingTest(config, KANA_LANGUAGE))
    expect(result.current.state.words).toEqual(['あい', 'あい', 'あい', 'あい'])

    expect(result.current.romajiGuide?.lookahead).toEqual(['ai', 'ai'])
    expect(result.current.romajiGuide?.showRow).toBe(true)
  })

  it('keeps romajiInput saved but inactive once the language switches off a kana pack', async () => {
    await seedKanaLanguage(KANA_LANGUAGE, ['あ'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(1), KANA_LANGUAGE))
    expect(result.current.config.mode === 'words' && result.current.config.romajiInput).toBe(true)

    await act(async () => {
      await result.current.setLanguage('english')
    })

    expect(result.current.language).toBe('english')
    expect(result.current.config.mode).toBe('words')
    // The flag itself is preserved, same as punctuation/numbers — it's just
    // not honored while a non-kana language is active.
    if (result.current.config.mode === 'words') {
      expect(result.current.config.romajiInput).toBe(true)
    }
    // Inactive language takes matching out of romaji mode immediately — a
    // submitted word now goes through verbatim comparison, not the matcher.
    expect(result.current.romajiGuide).toBeNull()
  })

  it('mounts with a persisted romajiInput=true + non-kana language pair inactive, not stripped', () => {
    // Mirrors a persisted config/language pair restored from device prefs
    // (e.g. via sync). The flag is kept as-is; isRomajiInputActive is what
    // decides it isn't honored yet.
    const persistedConfig: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false, romajiInput: true }
    const { result } = renderHook(() => useTypingTest(persistedConfig, 'english'))

    expect(result.current.language).toBe('english')
    expect(result.current.config.mode).toBe('words')
    if (result.current.config.mode === 'words') {
      expect(result.current.config.romajiInput).toBe(true)
    }
    expect(result.current.romajiGuide).toBeNull()
  })

  it('keeps romajiInput from a config pushed via setConfig inactive against whichever language is already active', async () => {
    // Mirrors useInputModes.ts's device-prefs sync effect, which calls
    // setConfig directly with a persisted config rather than going through
    // setLanguage.
    const { result } = renderHook(() => useTypingTest(undefined, 'english'))

    await act(async () => {
      await result.current.setConfig({ mode: 'words', wordCount: 10, punctuation: false, numbers: false, romajiInput: true })
    })

    expect(result.current.config.mode).toBe('words')
    if (result.current.config.mode === 'words') {
      expect(result.current.config.romajiInput).toBe(true)
    }
    expect(result.current.romajiGuide).toBeNull()
  })

  it('regression: honors romajiInput once the language sync catches up, even when the config sync landed first', async () => {
    // Reproduces the reported bug: useInputModes.ts syncs the persisted
    // config and language into useTypingTest via two independent effects.
    // When the config effect resolves before the language effect (both can
    // fire on the same mount, in either order), a config-first setConfig
    // call must not lose romajiInput before setLanguage lands the kana
    // pack that makes it meaningful again.
    await seedKanaLanguage(KANA_LANGUAGE, ['あ'])
    const { result } = renderHook(() => useTypingTest(undefined, undefined))

    await act(async () => {
      await result.current.setConfig(wordsConfig(1))
    })
    // Config landed while the default (non-kana) language was still active —
    // the flag must survive this, not just carry through a same-order path.
    expect(result.current.language).toBe('english')
    if (result.current.config.mode === 'words') {
      expect(result.current.config.romajiInput).toBe(true)
    }
    expect(result.current.romajiGuide).toBeNull()

    await act(async () => {
      await result.current.setLanguage(KANA_LANGUAGE)
    })

    expect(result.current.language).toBe(KANA_LANGUAGE)
    if (result.current.config.mode === 'words') {
      expect(result.current.config.romajiInput).toBe(true)
    }
    expect(result.current.romajiGuide).not.toBeNull()
    expect(result.current.state.words).toEqual(['あ'])

    press(result, 'a')
    expect(result.current.state.status).toBe('finished')
    expect(result.current.state.correctChars).toBe(1)
  })

  it('preserves romajiInput when switching between two kana languages', async () => {
    await seedKanaLanguage('japanese_hiragana', ['あ'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(1), 'japanese_hiragana'))
    await seedKanaLanguage('japanese_katakana', ['ア'])

    await act(async () => {
      await result.current.setLanguage('japanese_katakana')
    })

    expect(result.current.language).toBe('japanese_katakana')
    if (result.current.config.mode === 'words') {
      expect(result.current.config.romajiInput).toBe(true)
    }
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

// Plan-typing-mistake-analysis Phase 1: a rejected keystroke marks the
// in-progress kana segment as erred; once that segment completes, one
// mistake is tallied (keyed by the segment's canonical romaji spelling),
// regardless of how many rejected keystrokes it took to get there.
describe('useTypingTest — romaji mistake tracking', () => {
  it('records exactly 1 mistake for a segment typed with a wrong key then corrected', async () => {
    await seedKanaLanguage(KANA_LANGUAGE, ['か'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(1), KANA_LANGUAGE))

    press(result, 'x') // not a valid start for か (ka/ca)
    expect(result.current.state.incorrectChars).toBe(1)
    type(result, 'ka')

    expect(result.current.state.status).toBe('finished')
    expect(result.current.state.mistakes).toEqual({ ka: 1 })
  })

  it('records nothing for a clean segment', async () => {
    await seedKanaLanguage(KANA_LANGUAGE, ['か'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(1), KANA_LANGUAGE))

    type(result, 'ka')

    expect(result.current.state.status).toBe('finished')
    expect(result.current.state.mistakes).toEqual({})
  })

  it('records 2 distinct keys for two separately erred segments', async () => {
    await seedKanaLanguage(KANA_LANGUAGE, ['かき'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(1), KANA_LANGUAGE))

    press(result, 'x') // not a valid start for か
    type(result, 'ka')
    press(result, 'x') // not a valid start for き (only ki)
    type(result, 'ki')

    expect(result.current.state.status).toBe('finished')
    expect(result.current.state.mistakes).toEqual({ ka: 1, ki: 1 })
  })

  it('tallies only 1 mistake per segment regardless of how many keystrokes inside it were rejected', async () => {
    await seedKanaLanguage(KANA_LANGUAGE, ['か'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(1), KANA_LANGUAGE))

    press(result, 'x')
    press(result, 'z')
    type(result, 'ka')

    expect(result.current.state.mistakes).toEqual({ ka: 1 })
  })
})

// Plan-typing-romaji-settings-modal Step 2: `config.romaji`'s disabledStyles
// / guideStyles wired into the matcher (via `romajiMatcherOptions`), and
// caseStyle applied as a display-only transform to the guide row.
describe('useTypingTest — config.romaji wiring', () => {
  it('rejects a kunrei-tagged spelling once disabledStyles includes kunrei, while the canonical spelling still completes the word', async () => {
    // し's spellings: 'shi' (canonical, hepburn), 'si' (kunrei), 'ci' (c).
    await seedKanaLanguage(KANA_LANGUAGE, ['し'])
    const { result } = renderHook(() => useTypingTest(
      { mode: 'words', wordCount: 1, punctuation: false, numbers: false, romajiInput: true, romaji: { disabledStyles: ['kunrei'] } },
      KANA_LANGUAGE,
    ))

    press(result, 's')
    expect(result.current.state.incorrectChars).toBe(0)
    press(result, 'i')
    // 'si' is disabled and isn't a live prefix of the remaining canonical
    // ('shi') or c ('ci') spellings, so the second keystroke is rejected.
    expect(result.current.state.incorrectChars).toBe(1)
    expect(result.current.state.status).not.toBe('finished')
  })

  it('still completes the word via its canonical spelling with the same style disabled', async () => {
    await seedKanaLanguage(KANA_LANGUAGE, ['し'])
    const { result } = renderHook(() => useTypingTest(
      { mode: 'words', wordCount: 1, punctuation: false, numbers: false, romajiInput: true, romaji: { disabledStyles: ['kunrei'] } },
      KANA_LANGUAGE,
    ))

    type(result, 'shi')

    expect(result.current.state.status).toBe('finished')
    expect(result.current.state.incorrectChars).toBe(0)
  })

  it('steers the guide toward the requested style without changing acceptance', async () => {
    await seedKanaLanguage(KANA_LANGUAGE, ['し'])
    const { result } = renderHook(() => useTypingTest(
      { mode: 'words', wordCount: 1, punctuation: false, numbers: false, romajiInput: true, romaji: { guideStyles: ['kunrei'] } },
      KANA_LANGUAGE,
    ))

    expect(result.current.romajiGuide).toEqual({ typed: '', remaining: 'si', kanaCompleted: 0, lookahead: [], showRow: true })

    // The canonical spelling is still accepted even though the guide shows 'si'.
    type(result, 'shi')
    expect(result.current.state.status).toBe('finished')
    expect(result.current.state.incorrectChars).toBe(0)
  })

  it('uppercases the whole guide for caseStyle upper, display-only', async () => {
    await seedKanaLanguage(KANA_LANGUAGE, ['あい'])
    const { result } = renderHook(() => useTypingTest(
      { mode: 'words', wordCount: 1, punctuation: false, numbers: false, romajiInput: true, romaji: { caseStyle: 'upper' } },
      KANA_LANGUAGE,
    ))

    expect(result.current.romajiGuide).toEqual({ typed: '', remaining: 'AI', kanaCompleted: 0, lookahead: [], showRow: true })
    press(result, 'a')
    expect(result.current.romajiGuide).toEqual({ typed: 'A', remaining: 'I', kanaCompleted: 1, lookahead: [], showRow: true })
    // Lowercase 'a' is still what's accepted — the transform never reaches acceptance.
    expect(result.current.state.incorrectChars).toBe(0)
  })

  it('capitalizes only the first character of the word for caseStyle capital', async () => {
    await seedKanaLanguage(KANA_LANGUAGE, ['あい'])
    const { result } = renderHook(() => useTypingTest(
      { mode: 'words', wordCount: 1, punctuation: false, numbers: false, romajiInput: true, romaji: { caseStyle: 'capital' } },
      KANA_LANGUAGE,
    ))

    // Nothing typed yet — the capital lands on the first char of `remaining`.
    expect(result.current.romajiGuide).toEqual({ typed: '', remaining: 'Ai', kanaCompleted: 0, lookahead: [], showRow: true })

    press(result, 'a')
    // Once something is typed, the capital moves onto `typed`'s first char
    // and `remaining` goes back to lowercase.
    expect(result.current.romajiGuide).toEqual({ typed: 'A', remaining: 'i', kanaCompleted: 1, lookahead: [], showRow: true })
  })

  it('applies caseStyle to lookahead entries too, upper and capital alike', async () => {
    // Default guideWordCount (2 = current + 1 next), so at word 0 only one
    // upcoming word is previewed even with a 3-word run.
    await seedKanaLanguage(KANA_LANGUAGE, ['あい'])
    const { result: upperResult } = renderHook(() => useTypingTest(
      { mode: 'words', wordCount: 3, punctuation: false, numbers: false, romajiInput: true, romaji: { caseStyle: 'upper' } },
      KANA_LANGUAGE,
    ))
    expect(upperResult.current.romajiGuide?.lookahead).toEqual(['AI'])

    await seedKanaLanguage(KANA_LANGUAGE, ['あい'])
    const { result: capitalResult } = renderHook(() => useTypingTest(
      { mode: 'words', wordCount: 3, punctuation: false, numbers: false, romajiInput: true, romaji: { caseStyle: 'capital' } },
      KANA_LANGUAGE,
    ))
    expect(capitalResult.current.romajiGuide?.lookahead).toEqual(['Ai'])
  })

  it('changing config.romaji via setConfig restarts the test, same as any other config field change', async () => {
    // Plan-typing-romaji-settings-modal Step 2 design judgement: the Romaji
    // Settings modal writes through the same onConfigChange -> setConfig
    // path as punctuation/numbers/mode, which unconditionally regenerates
    // words and resets state (see `setConfig` above) — so a disabledStyles
    // edit mid-word already gets a full restart with no special-case code.
    await seedKanaLanguage(KANA_LANGUAGE, ['し'])
    const { result } = renderHook(() => useTypingTest(wordsConfig(1), KANA_LANGUAGE))

    press(result, 's')
    expect(result.current.state.romajiKeystrokes).toBe('s')

    await act(async () => {
      await result.current.setConfig({ ...wordsConfig(1), romaji: { disabledStyles: ['kunrei'] } })
    })

    expect(result.current.state.romajiKeystrokes).toBe('')
    expect(result.current.state.currentWordIndex).toBe(0)
    expect(result.current.state.status).toBe('waiting')
  })
})

describe('applyRomajiCaseStyle — lookahead entries', () => {
  const baseGuide: RomajiGuide = { typed: '', remaining: 'a', kanaCompleted: 0, lookahead: ['ai', 'ka'], showRow: true }

  it('leaves lookahead untouched for lower/undefined', () => {
    expect(applyRomajiCaseStyle(baseGuide, undefined).lookahead).toEqual(['ai', 'ka'])
    expect(applyRomajiCaseStyle(baseGuide, 'lower').lookahead).toEqual(['ai', 'ka'])
  })

  it('uppercases every lookahead word in full for upper', () => {
    expect(applyRomajiCaseStyle(baseGuide, 'upper').lookahead).toEqual(['AI', 'KA'])
  })

  it('capitalizes only the first character of each lookahead word for capital', () => {
    expect(applyRomajiCaseStyle(baseGuide, 'capital').lookahead).toEqual(['Ai', 'Ka'])
  })

  it('capitalizes lookahead even when the current word itself has nothing to capitalize', () => {
    const emptyWordGuide: RomajiGuide = { typed: '', remaining: '', kanaCompleted: 0, lookahead: ['ai'], showRow: true }
    expect(applyRomajiCaseStyle(emptyWordGuide, 'capital').lookahead).toEqual(['Ai'])
  })
})

// Plan-romaji-capability Phase 2: romaji judging extended beyond monkeytype
// words/time to a fileImport text, gated on the text's own kana-pure
// content (`textRomajiCapable`, threaded from the store's computed
// `romajiCapable` meta field) rather than the active word-language pack.
describe('useTypingTest — romaji input mode (fileImport)', () => {
  it('judges keystrokes through the romaji matcher for a kana-pure fileImport text', async () => {
    mockTypingTestTextStoreGet.mockResolvedValue({
      success: true,
      data: { meta: { id: 't1', romajiCapable: true }, data: { name: 'Kana Text', text: 'か' } },
    })
    const { result } = renderHook(() => useTypingTest(undefined, 'english'))

    await act(async () => {
      await result.current.setConfig({ mode: 'fileImport', textId: 't1', romajiInput: true })
    })

    expect(result.current.state.words).toEqual(['か'])
    expect(result.current.romajiGuide).not.toBeNull()

    type(result, 'ka')

    expect(result.current.state.status).toBe('finished')
    expect(result.current.state.correctChars).toBe('ka'.length)
    expect(result.current.state.incorrectChars).toBe(0)
  })

  it('stays in verbatim mode for a fileImport text whose content is not kana-pure, even with romajiInput true', async () => {
    mockTypingTestTextStoreGet.mockResolvedValue({
      success: true,
      data: { meta: { id: 't2', romajiCapable: false }, data: { name: 'Mixed Text', text: 'hello' } },
    })
    const { result } = renderHook(() => useTypingTest(undefined, 'english'))

    await act(async () => {
      await result.current.setConfig({ mode: 'fileImport', textId: 't2', romajiInput: true })
    })

    expect(result.current.state.words).toEqual(['hello'])
    expect(result.current.romajiGuide).toBeNull()

    type(result, 'hello')

    expect(result.current.state.status).toBe('finished')
    expect(result.current.state.wordResults).toEqual([{ word: 'hello', typed: 'hello', correct: true }])
  })
})
