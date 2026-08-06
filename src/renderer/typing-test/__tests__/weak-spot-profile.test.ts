// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  meetsWeakSpotThreshold,
  weakSpotKeystrokeDeficit,
  effectiveWeakSpotInputMethod,
  createMistakeProfileCache,
  WEAK_SPOT_KEYSTROKE_THRESHOLD,
} from '../weak-spot-profile'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
import type { TypingTestConfig } from '../types'

function makeResult(overrides: Partial<TypingTestResult> = {}): TypingTestResult {
  return {
    date: '2026-06-20T00:00:00.000Z',
    wpm: 60,
    accuracy: 95,
    wordCount: 30,
    correctChars: 100,
    incorrectChars: 10,
    durationSeconds: 30,
    mode: 'words',
    mode2: 30,
    language: 'english',
    punctuation: false,
    numbers: false,
    ...overrides,
  }
}

describe('meetsWeakSpotThreshold / weakSpotKeystrokeDeficit', () => {
  it('threshold is 200', () => {
    expect(WEAK_SPOT_KEYSTROKE_THRESHOLD).toBe(200)
  })

  it('is not met just below the threshold, met exactly at and above it', () => {
    expect(meetsWeakSpotThreshold(199)).toBe(false)
    expect(meetsWeakSpotThreshold(200)).toBe(true)
    expect(meetsWeakSpotThreshold(500)).toBe(true)
  })

  it('deficit is the remaining count, 0 once met', () => {
    expect(weakSpotKeystrokeDeficit(0)).toBe(200)
    expect(weakSpotKeystrokeDeficit(150)).toBe(50)
    expect(weakSpotKeystrokeDeficit(200)).toBe(0)
    expect(weakSpotKeystrokeDeficit(500)).toBe(0)
  })
})

describe('effectiveWeakSpotInputMethod', () => {
  it('is direct for a non-kana language', () => {
    const config: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false }
    expect(effectiveWeakSpotInputMethod(config, 'english')).toBe('direct')
  })

  it('is romaji for a default-on kana language (romajiInput unset = on)', () => {
    const config: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false }
    expect(effectiveWeakSpotInputMethod(config, 'japanese_hiragana')).toBe('romaji')
  })

  it('is direct for a kana language with romajiInput explicitly off', () => {
    const config: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false, romajiInput: false }
    expect(effectiveWeakSpotInputMethod(config, 'japanese_hiragana')).toBe('direct')
  })

  it('is kana when the kana input method is selected', () => {
    const config: TypingTestConfig = {
      mode: 'words', wordCount: 30, punctuation: false, numbers: false, romaji: { inputMethod: 'kana' },
    }
    expect(effectiveWeakSpotInputMethod(config, 'japanese_hiragana')).toBe('kana')
  })
})

describe('createMistakeProfileCache — scope aggregation', () => {
  it('aggregates mistakes only from rows matching language + input method', () => {
    const history: TypingTestResult[] = [
      makeResult({ mistakes: { a: 3 } }),                                                    // english/direct — matches
      makeResult({ language: 'japanese_hiragana', romajiInput: true, mistakes: { ka: 5 } }),  // different scope
      makeResult({ mistakes: { a: 2, b: 1 } }),                                               // english/direct — matches
    ]
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, 'english', 'direct')
    expect(profile.weights).toEqual({ a: 5, b: 1 })
  })

  it('skips rows with no mistakes field entirely', () => {
    const history: TypingTestResult[] = [
      makeResult({ mistakes: undefined }),
      makeResult({ mistakes: { x: 1 } }),
    ]
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, 'english', 'direct')
    expect(profile.weights).toEqual({ x: 1 })
  })

  it('excludes synthetic decoration keys (digits, sentence punctuation, uppercase)', () => {
    const history: TypingTestResult[] = [
      makeResult({ mistakes: { a: 2, '.': 5, ',': 5, '7': 3, '123': 2, T: 4 } }),
    ]
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, 'english', 'direct')
    expect(profile.weights).toEqual({ a: 2 })
  })

  it('scopes romaji and kana input methods separately even for the same language', () => {
    const history: TypingTestResult[] = [
      makeResult({ language: 'japanese_hiragana', romajiInput: true, mistakes: { ka: 3 } }),
      makeResult({ language: 'japanese_hiragana', kanaInput: true, mistakes: { か: 7 } }),
    ]
    const cache = createMistakeProfileCache()
    const romaji = cache.get(history, 'japanese_hiragana', 'romaji')
    const kana = cache.get(history, 'japanese_hiragana', 'kana')
    expect(romaji.weights).toEqual({ ka: 3 })
    expect(kana.weights).toEqual({ か: 7 })
  })

  it('sums per-row keystroke fallback (kspcKeystrokes ?? correctChars+incorrectChars) AFTER the fallback, per row', () => {
    const history: TypingTestResult[] = [
      makeResult({ kspcKeystrokes: 120, correctChars: 999, incorrectChars: 999 }), // uses kspcKeystrokes: 120
      makeResult({ kspcKeystrokes: undefined, correctChars: 50, incorrectChars: 10 }), // fallback: 60
    ]
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, 'english', 'direct')
    expect(profile.keystrokes).toBe(180)
  })

  it('boundary: a scope with exactly 199 vs 200 summed keystrokes', () => {
    const below: TypingTestResult[] = [makeResult({ kspcKeystrokes: 199 })]
    const at: TypingTestResult[] = [makeResult({ kspcKeystrokes: 200 })]
    const cache = createMistakeProfileCache()
    expect(meetsWeakSpotThreshold(cache.get(below, 'english', 'direct').keystrokes)).toBe(false)
    expect(meetsWeakSpotThreshold(cache.get(at, 'english', 'direct').keystrokes)).toBe(true)
  })

  it('returns a zero-keystroke, empty-weights profile for an empty history (never throws)', () => {
    const cache = createMistakeProfileCache()
    const profile = cache.get([], 'english', 'direct')
    expect(profile.weights).toEqual({})
    expect(profile.keystrokes).toBe(0)
  })
})

describe('createMistakeProfileCache — memoization', () => {
  it('returns the identical object reference for repeated calls with the same history array + scope', () => {
    const history: TypingTestResult[] = [makeResult({ mistakes: { a: 1 } })]
    const cache = createMistakeProfileCache()
    const first = cache.get(history, 'english', 'direct')
    const second = cache.get(history, 'english', 'direct')
    expect(second).toBe(first)
  })

  it('invalidates the whole cache when the history array reference changes', () => {
    const history1: TypingTestResult[] = [makeResult({ mistakes: { a: 1 } })]
    const history2: TypingTestResult[] = [makeResult({ mistakes: { a: 1, b: 2 } })]
    const cache = createMistakeProfileCache()
    const first = cache.get(history1, 'english', 'direct')
    const second = cache.get(history2, 'english', 'direct')
    expect(second).not.toBe(first)
    expect(second.weights).toEqual({ a: 1, b: 2 })
  })

  it('keeps distinct entries per scope key for the same history reference', () => {
    const history: TypingTestResult[] = [
      makeResult({ mistakes: { a: 1 } }),
      makeResult({ language: 'french', mistakes: { z: 9 } }),
    ]
    const cache = createMistakeProfileCache()
    const english = cache.get(history, 'english', 'direct')
    const french = cache.get(history, 'french', 'direct')
    expect(english.weights).toEqual({ a: 1 })
    expect(french.weights).toEqual({ z: 9 })
  })
})
