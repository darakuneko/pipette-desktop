// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { effectiveWeakSpotInputMethod, createMistakeProfileCache } from '../weak-spot-profile'
import { MIN_MISS_COUNT } from '../weak-spot-scoring'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
import type { RunKeystrokeLog, RunKeystroke, RunWord } from '../../../shared/types/typing-run-log'
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

const EMPTY_LOGS: ReadonlyMap<string, RunKeystrokeLog> = new Map()

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

describe('createMistakeProfileCache — miss-only aggregation (no run logs)', () => {
  it('aggregates mistakes only from rows matching language + input method', () => {
    const history: TypingTestResult[] = [
      makeResult({ mistakes: { a: 3 } }),                                                    // english/direct — matches
      makeResult({ language: 'japanese_hiragana', romajiInput: true, mistakes: { ka: 5 } }),  // different scope
      makeResult({ mistakes: { a: 2, b: 1 } }),                                               // english/direct — matches
    ]
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct')
    // a: 3+2=5 misses (weak, score = log1p(5)). b: 1 miss only, BELOW
    // MIN_MISS_COUNT (2) — not weak, absent from weights entirely.
    expect(Object.keys(profile.weights)).toEqual(['a'])
    expect(profile.weights.a).toBeGreaterThan(0)
    expect(profile.weakTokenCount).toBe(1)
  })

  it('skips rows with no mistakes field entirely', () => {
    const history: TypingTestResult[] = [
      makeResult({ mistakes: undefined }),
      makeResult({ mistakes: { x: MIN_MISS_COUNT } }),
    ]
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct')
    expect(Object.keys(profile.weights)).toEqual(['x'])
  })

  it('excludes synthetic decoration keys (digits, sentence punctuation, uppercase)', () => {
    const history: TypingTestResult[] = [
      makeResult({ mistakes: { a: 2, '.': 5, ',': 5, '7': 3, '123': 2, T: 4 } }),
    ]
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct')
    expect(Object.keys(profile.weights)).toEqual(['a'])
  })

  it('scopes romaji and kana input methods separately even for the same language', () => {
    const history: TypingTestResult[] = [
      makeResult({ language: 'japanese_hiragana', romajiInput: true, mistakes: { ka: 3 } }),
      makeResult({ language: 'japanese_hiragana', kanaInput: true, mistakes: { か: 7 } }),
    ]
    const cache = createMistakeProfileCache()
    const romaji = cache.get(history, EMPTY_LOGS, 'japanese_hiragana', 'romaji')
    const kana = cache.get(history, EMPTY_LOGS, 'japanese_hiragana', 'kana')
    expect(Object.keys(romaji.weights)).toEqual(['ka'])
    expect(Object.keys(kana.weights)).toEqual(['か'])
  })

  it('a miss count of exactly MIN_MISS_COUNT - 1 is not weak', () => {
    const history: TypingTestResult[] = [makeResult({ mistakes: { a: MIN_MISS_COUNT - 1 } })]
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct')
    expect(profile.weakTokenCount).toBe(0)
    expect(profile.weights).toEqual({})
  })

  it('a miss count of exactly MIN_MISS_COUNT is weak', () => {
    const history: TypingTestResult[] = [makeResult({ mistakes: { a: MIN_MISS_COUNT } })]
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct')
    expect(profile.weakTokenCount).toBe(1)
  })

  it('returns a zero-weight, zero-weak-token profile for an empty history (never throws)', () => {
    const cache = createMistakeProfileCache()
    const profile = cache.get([], EMPTY_LOGS, 'english', 'direct')
    expect(profile.weights).toEqual({})
    expect(profile.weakTokenCount).toBe(0)
  })
})

// --- Timing integration -----------------------------------------------

let nextCol = 0
function ks(pressMs: number, expectedChar: string, correct: boolean): RunKeystroke {
  nextCol++
  return { pressMs, keycode: 0, row: 0, col: nextCol, expectedChar, correct }
}

/** A "cat"-shaped 3-char clean word, first keystroke at `startMs`, each
 *  subsequent keystroke `gapMs` after the previous one — 'c' is always
 *  word-initial (never measured); 'a' and 't' each get one interval
 *  observation of `gapMs`. */
function catWord(startMs: number, gapMs: number): RunWord {
  return {
    index: 0, display: 'cat', typed: 'cat', correct: true,
    keystrokes: [ks(startMs, 'c', true), ks(startMs + gapMs, 'a', true), ks(startMs + 2 * gapMs, 't', true)],
  }
}

function makeLog(runId: string, words: RunWord[]): RunKeystrokeLog {
  return {
    runId, uid: 'u1', startedAt: '2026-06-20T00:00:00.000Z', durationMs: 60000,
    mode: 'words', language: 'english', words,
  }
}

describe('createMistakeProfileCache — timing integration', () => {
  it('a token with n>=15 clean intervals, no mistakes at all, still flags weak via timing alone', () => {
    // 20 "cat" words at a brisk, uniform 100ms gap — baseline (scope median
    // ~100ms) — plus one more batch of "cat" words at a much slower
    // 400ms gap (ratio 4x >= 1.5) to make 't'/'a' clearly slow. Simplify:
    // put ALL "cat" words at 100ms EXCEPT we need SOME token to actually
    // be slow relative to the scope median. Use a second word shape "dog"
    // typed slowly to create the scope's slow outlier while keeping 'cat'
    // fast, so 'o'/'g' (dog's non-initial tokens) end up weak.
    const fastCats = Array.from({ length: 20 }, (_, i) => catWord(i * 1000, 100))
    const dogWord = (startMs: number): RunWord => ({
      index: 1, display: 'dog', typed: 'dog', correct: true,
      keystrokes: [ks(startMs, 'd', true), ks(startMs + 500, 'o', true), ks(startMs + 1000, 'g', true)],
    })
    const slowDogs = Array.from({ length: 20 }, (_, i) => dogWord(50000 + i * 2000))
    const log = makeLog('run1', [...fastCats, ...slowDogs])

    const history: TypingTestResult[] = [makeResult({ runId: 'run1', mistakes: undefined })]
    const runLogs = new Map([['run1', log]])
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, runLogs, 'english', 'direct')

    // 'a'/'t' (fast, ~100ms, near scope median) should NOT be weak.
    expect(profile.weights.a).toBeUndefined()
    expect(profile.weights.t).toBeUndefined()
    // 'o'/'g' (500ms/1000ms gaps, well above scope median) should be weak.
    expect(profile.weights.o).toBeGreaterThan(0)
    expect(profile.weights.g).toBeGreaterThan(0)
    expect(profile.weakTokenCount).toBeGreaterThanOrEqual(2)
  })

  it('a token with fewer than 15 clean intervals never flags via timing, even if drastically slow', () => {
    const slowCats = Array.from({ length: 10 }, (_, i) => catWord(i * 10000, 5000 - 1)) // just under the 5s cap
    const log = makeLog('run1', slowCats)
    const history: TypingTestResult[] = [makeResult({ runId: 'run1', mistakes: undefined })]
    const runLogs = new Map([['run1', log]])
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, runLogs, 'english', 'direct')
    expect(profile.weakTokenCount).toBe(0)
    expect(profile.weights).toEqual({})
  })

  it('a row with a runId not present in runLogs (log absent) falls back to mistakes-only, no crash', () => {
    const history: TypingTestResult[] = [makeResult({ runId: 'missing-run', mistakes: { a: MIN_MISS_COUNT } })]
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct')
    expect(profile.weakTokenCount).toBe(1)
    expect(profile.weights.a).toBeGreaterThan(0)
  })

  it('a row with no runId at all contributes mistakes but no timing data', () => {
    const history: TypingTestResult[] = [makeResult({ runId: undefined, mistakes: { a: MIN_MISS_COUNT } })]
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct')
    expect(profile.weakTokenCount).toBe(1)
  })

  it('combines mistakes AND timing for the union of tokens across both sources', () => {
    const fastCats = Array.from({ length: 20 }, (_, i) => catWord(i * 1000, 100))
    const log = makeLog('run1', fastCats)
    const history: TypingTestResult[] = [
      makeResult({ runId: 'run1', mistakes: { z: MIN_MISS_COUNT } }), // 'z' never appears in the log at all
    ]
    const runLogs = new Map([['run1', log]])
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, runLogs, 'english', 'direct')
    expect(profile.weights.z).toBeGreaterThan(0) // miss-only token still weak
    expect(profile.weights.a).toBeUndefined() // fast, not weak
  })
})

describe('createMistakeProfileCache — memoization', () => {
  it('returns the identical object reference for repeated calls with the same history + runLogs + scope', () => {
    const history: TypingTestResult[] = [makeResult({ mistakes: { a: MIN_MISS_COUNT } })]
    const cache = createMistakeProfileCache()
    const first = cache.get(history, EMPTY_LOGS, 'english', 'direct')
    const second = cache.get(history, EMPTY_LOGS, 'english', 'direct')
    expect(second).toBe(first)
  })

  it('invalidates the whole cache when the history array reference changes', () => {
    const history1: TypingTestResult[] = [makeResult({ mistakes: { a: MIN_MISS_COUNT } })]
    const history2: TypingTestResult[] = [makeResult({ mistakes: { a: MIN_MISS_COUNT, b: MIN_MISS_COUNT } })]
    const cache = createMistakeProfileCache()
    const first = cache.get(history1, EMPTY_LOGS, 'english', 'direct')
    const second = cache.get(history2, EMPTY_LOGS, 'english', 'direct')
    expect(second).not.toBe(first)
    expect(Object.keys(second.weights).sort()).toEqual(['a', 'b'])
  })

  it('invalidates the whole cache when the runLogs reference changes, even with the same history', () => {
    const history: TypingTestResult[] = [makeResult({ runId: 'run1', mistakes: undefined })]
    const logs1: ReadonlyMap<string, RunKeystrokeLog> = new Map()
    const fastCats = Array.from({ length: 20 }, (_, i) => catWord(i * 1000, 100))
    const logs2: ReadonlyMap<string, RunKeystrokeLog> = new Map([['run1', makeLog('run1', fastCats)]])
    const cache = createMistakeProfileCache()
    const first = cache.get(history, logs1, 'english', 'direct')
    const second = cache.get(history, logs2, 'english', 'direct')
    expect(second).not.toBe(first)
  })

  it('keeps distinct entries per scope key for the same history reference', () => {
    const history: TypingTestResult[] = [
      makeResult({ mistakes: { a: MIN_MISS_COUNT } }),
      makeResult({ language: 'french', mistakes: { z: MIN_MISS_COUNT } }),
    ]
    const cache = createMistakeProfileCache()
    const english = cache.get(history, EMPTY_LOGS, 'english', 'direct')
    const french = cache.get(history, EMPTY_LOGS, 'french', 'direct')
    expect(Object.keys(english.weights)).toEqual(['a'])
    expect(Object.keys(french.weights)).toEqual(['z'])
  })
})
