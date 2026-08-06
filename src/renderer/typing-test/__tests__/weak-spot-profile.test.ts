// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectiveWeakSpotInputMethod, createMistakeProfileCache } from '../weak-spot-profile'
import { DEFAULT_MIN_MISS_COUNT } from '../weak-spot-scoring'
import { DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, type WeakSpotDetectionSettings } from '../weak-spot-settings'
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
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    // a: 3+2=5 misses (weak, score = log1p(5)). b: 1 miss only, BELOW
    // DEFAULT_MIN_MISS_COUNT (2) — not weak, absent from weights entirely.
    expect(Object.keys(profile.weights)).toEqual(['a'])
    expect(profile.weights.a).toBeGreaterThan(0)
    expect(profile.weakTokenCount).toBe(1)
  })

  it('skips rows with no mistakes field entirely', () => {
    const history: TypingTestResult[] = [
      makeResult({ mistakes: undefined }),
      makeResult({ mistakes: { x: DEFAULT_MIN_MISS_COUNT } }),
    ]
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    expect(Object.keys(profile.weights)).toEqual(['x'])
  })

  it('excludes synthetic decoration keys (digits, sentence punctuation, uppercase)', () => {
    const history: TypingTestResult[] = [
      makeResult({ mistakes: { a: 2, '.': 5, ',': 5, '7': 3, '123': 2, T: 4 } }),
    ]
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    expect(Object.keys(profile.weights)).toEqual(['a'])
  })

  it('scopes romaji and kana input methods separately even for the same language', () => {
    const history: TypingTestResult[] = [
      makeResult({ language: 'japanese_hiragana', romajiInput: true, mistakes: { ka: 3 } }),
      makeResult({ language: 'japanese_hiragana', kanaInput: true, mistakes: { か: 7 } }),
    ]
    const cache = createMistakeProfileCache()
    const romaji = cache.get(history, EMPTY_LOGS, 'japanese_hiragana', 'romaji', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    const kana = cache.get(history, EMPTY_LOGS, 'japanese_hiragana', 'kana', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    expect(Object.keys(romaji.weights)).toEqual(['ka'])
    expect(Object.keys(kana.weights)).toEqual(['か'])
  })

  it('a miss count of exactly DEFAULT_MIN_MISS_COUNT - 1 is not weak', () => {
    const history: TypingTestResult[] = [makeResult({ mistakes: { a: DEFAULT_MIN_MISS_COUNT - 1 } })]
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    expect(profile.weakTokenCount).toBe(0)
    expect(profile.weights).toEqual({})
  })

  it('a miss count of exactly DEFAULT_MIN_MISS_COUNT is weak', () => {
    const history: TypingTestResult[] = [makeResult({ mistakes: { a: DEFAULT_MIN_MISS_COUNT } })]
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    expect(profile.weakTokenCount).toBe(1)
  })

  it('returns a zero-weight, zero-weak-token profile for an empty history (never throws)', () => {
    const cache = createMistakeProfileCache()
    const profile = cache.get([], EMPTY_LOGS, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
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
    const profile = cache.get(history, runLogs, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)

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
    const profile = cache.get(history, runLogs, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    expect(profile.weakTokenCount).toBe(0)
    expect(profile.weights).toEqual({})
  })

  it('a row with a runId not present in runLogs (log absent) falls back to mistakes-only, no crash', () => {
    const history: TypingTestResult[] = [makeResult({ runId: 'missing-run', mistakes: { a: DEFAULT_MIN_MISS_COUNT } })]
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    expect(profile.weakTokenCount).toBe(1)
    expect(profile.weights.a).toBeGreaterThan(0)
  })

  it('a row with no runId at all contributes mistakes but no timing data', () => {
    const history: TypingTestResult[] = [makeResult({ runId: undefined, mistakes: { a: DEFAULT_MIN_MISS_COUNT } })]
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    expect(profile.weakTokenCount).toBe(1)
  })

  it('combines mistakes AND timing for the union of tokens across both sources', () => {
    const fastCats = Array.from({ length: 20 }, (_, i) => catWord(i * 1000, 100))
    const log = makeLog('run1', fastCats)
    const history: TypingTestResult[] = [
      makeResult({ runId: 'run1', mistakes: { z: DEFAULT_MIN_MISS_COUNT } }), // 'z' never appears in the log at all
    ]
    const runLogs = new Map([['run1', log]])
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, runLogs, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    expect(profile.weights.z).toBeGreaterThan(0) // miss-only token still weak
    expect(profile.weights.a).toBeUndefined() // fast, not weak
  })
})

describe('createMistakeProfileCache — memoization', () => {
  it('returns the identical object reference for repeated calls with the same history + runLogs + scope', () => {
    const history: TypingTestResult[] = [makeResult({ mistakes: { a: DEFAULT_MIN_MISS_COUNT } })]
    const cache = createMistakeProfileCache()
    const first = cache.get(history, EMPTY_LOGS, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    const second = cache.get(history, EMPTY_LOGS, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    expect(second).toBe(first)
  })

  it('invalidates the whole cache when the history array reference changes', () => {
    const history1: TypingTestResult[] = [makeResult({ mistakes: { a: DEFAULT_MIN_MISS_COUNT } })]
    const history2: TypingTestResult[] = [makeResult({ mistakes: { a: DEFAULT_MIN_MISS_COUNT, b: DEFAULT_MIN_MISS_COUNT } })]
    const cache = createMistakeProfileCache()
    const first = cache.get(history1, EMPTY_LOGS, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    const second = cache.get(history2, EMPTY_LOGS, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    expect(second).not.toBe(first)
    expect(Object.keys(second.weights).sort()).toEqual(['a', 'b'])
  })

  it('invalidates the whole cache when the runLogs reference changes, even with the same history', () => {
    const history: TypingTestResult[] = [makeResult({ runId: 'run1', mistakes: undefined })]
    const logs1: ReadonlyMap<string, RunKeystrokeLog> = new Map()
    const fastCats = Array.from({ length: 20 }, (_, i) => catWord(i * 1000, 100))
    const logs2: ReadonlyMap<string, RunKeystrokeLog> = new Map([['run1', makeLog('run1', fastCats)]])
    const cache = createMistakeProfileCache()
    const first = cache.get(history, logs1, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    const second = cache.get(history, logs2, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    expect(second).not.toBe(first)
  })

  it('keeps distinct entries per scope key for the same history reference', () => {
    const history: TypingTestResult[] = [
      makeResult({ mistakes: { a: DEFAULT_MIN_MISS_COUNT } }),
      makeResult({ language: 'french', mistakes: { z: DEFAULT_MIN_MISS_COUNT } }),
    ]
    const cache = createMistakeProfileCache()
    const english = cache.get(history, EMPTY_LOGS, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    const french = cache.get(history, EMPTY_LOGS, 'french', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    expect(Object.keys(english.weights)).toEqual(['a'])
    expect(Object.keys(french.weights)).toEqual(['z'])
  })

  it('caps at MAX_CACHED_PROFILES (8) entries per history/runLogs generation, evicting the oldest on insert', () => {
    const history: TypingTestResult[] = [makeResult({ mistakes: { a: DEFAULT_MIN_MISS_COUNT } })]
    const cache = createMistakeProfileCache()
    // 9 distinct settings-keyed entries (missThreshold 1..9) — the 9th
    // insert must evict the very first (missThreshold: 1) entry.
    const settingsFor = (missThreshold: number): WeakSpotDetectionSettings => ({ ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, missThreshold })
    const first = cache.get(history, EMPTY_LOGS, 'english', 'direct', settingsFor(1))
    for (let i = 2; i <= 9; i++) cache.get(history, EMPTY_LOGS, 'english', 'direct', settingsFor(i))
    const firstAgain = cache.get(history, EMPTY_LOGS, 'english', 'direct', settingsFor(1))
    expect(firstAgain).not.toBe(first) // recomputed — the original entry was evicted
  })
})

// --- Weak Spot Settings — rolling window (A) / time decay (B) / cache key ---

function dayResult(daysAgo: number, mistakes: Record<string, number>, overrides: Partial<TypingTestResult> = {}): TypingTestResult {
  const date = new Date(Date.parse('2026-06-20T00:00:00.000Z') - daysAgo * 24 * 60 * 60 * 1000).toISOString()
  return makeResult({ date, mistakes, ...overrides })
}

describe('createMistakeProfileCache — rolling window (A)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-20T00:00:00.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('unbounded ("all") includes every scoped row, matching pre-existing behaviour', () => {
    const history = Array.from({ length: 5 }, (_, i) => dayResult(i, { a: 1 }))
    const cache = createMistakeProfileCache()
    const settings: WeakSpotDetectionSettings = { ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, missWindow: 'all' }
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct', settings)
    // 5 rows × 1 miss each = 5, well over DEFAULT_MIN_MISS_COUNT.
    expect(profile.weights.a).toBeGreaterThan(0)
  })

  it('a small window excludes older rows from the aggregation entirely', () => {
    // 15 rows, 1 miss each, newest-first (index 0 = daysAgo 0, matching
    // typingTestHistory's own [result, ...prev] construction order — see
    // weak-spot-profile.ts's windowedRows doc comment). With
    // missThreshold=12: the unbounded window pools all 15 misses (>= 12
    // -> weak), while a window of 10 (the smallest valid
    // WeakSpotMissWindow value) keeps only the newest 10 misses (< 12 ->
    // not weak) — proving the older 5 rows were genuinely excluded from
    // the count, not just re-scoped.
    const history = Array.from({ length: 15 }, (_, i) => dayResult(i, { a: 1 }))
    const unbounded = createMistakeProfileCache().get(
      history, EMPTY_LOGS, 'english', 'direct', { ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, missWindow: 'all', missThreshold: 12 },
    )
    expect(unbounded.weakTokenCount).toBe(1)

    const windowed = createMistakeProfileCache().get(
      history, EMPTY_LOGS, 'english', 'direct', { ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, missWindow: 10, missThreshold: 12 },
    )
    expect(windowed.weakTokenCount).toBe(0)
  })

  it('selects the newest N by taking the FRONT of history (position-based, matches typingTestHistory\'s newest-first construction order) rather than re-sorting by date', () => {
    // 12 rows: the FRONT 10 (positions 0-9) carry a modest miss count;
    // the trailing 2 (positions 10-11) carry an extreme one that would
    // dominate if counted. A window of 10 must only ever look at the
    // front 10 by POSITION — proving windowedRows trusts caller order
    // rather than re-deriving it from `date` (every row here shares the
    // exact same `date`, so a date-based sort couldn't distinguish them
    // at all; only position can).
    const history: TypingTestResult[] = [
      ...Array.from({ length: 10 }, () => makeResult({ mistakes: { a: 1 } })),
      ...Array.from({ length: 2 }, () => makeResult({ mistakes: { a: 100 } })),
    ]
    const cache = createMistakeProfileCache()
    const settings: WeakSpotDetectionSettings = { ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, missWindow: 10, missThreshold: 15 }
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct', settings)
    // Front 10 rows sum to 10 misses (< 15 threshold) — the trailing 2
    // heavy-miss rows must never be counted despite existing in `history`.
    expect(profile.weakTokenCount).toBe(0)
  })

  it('applies the window to BOTH the miss aggregation and the timing sample selection (one shared row set)', () => {
    // 20 rows, newest-first: the NEWEST 10 (positions 0-9) have no
    // runId/log at all; the OLDEST 10 (positions 10-19) carry a run log
    // with a distinctly slow "dog" word (500ms gaps, well above the fast
    // "cat" baseline elsewhere in the same logs). A window of 10 keeps
    // only the newest 10 rows in scope — which have zero timing data —
    // so 'o'/'g' must never flag weak. Unbounded ('all') pulls the older
    // 10 logs' slow "dog" samples back in and DOES flag them, proving the
    // window genuinely gated the timing signal too, not just the miss
    // counts.
    let col = 0
    const ks = (pressMs: number, expectedChar: string): RunKeystroke => {
      col++
      return { pressMs, keycode: 0, row: 0, col, expectedChar, correct: true }
    }
    const catWord = (startMs: number, gapMs: number): RunWord => ({
      index: 0, display: 'cat', typed: 'cat', correct: true,
      keystrokes: [ks(startMs, 'c'), ks(startMs + gapMs, 'a'), ks(startMs + 2 * gapMs, 't')],
    })
    const dogWord = (startMs: number): RunWord => ({
      index: 1, display: 'dog', typed: 'dog', correct: true,
      keystrokes: [ks(startMs, 'd'), ks(startMs + 500, 'o'), ks(startMs + 1000, 'g')],
    })
    const makeSlowLog = (runId: string): RunKeystrokeLog => ({
      runId, uid: 'u1', startedAt: '2026-06-01T00:00:00.000Z', durationMs: 60000, mode: 'words', language: 'english',
      words: [
        ...Array.from({ length: 20 }, (_, i) => catWord(i * 1000, 100)),
        ...Array.from({ length: 20 }, (_, i) => dogWord(50000 + i * 2000)),
      ],
    })

    const history: TypingTestResult[] = []
    const runLogs = new Map<string, RunKeystrokeLog>()
    for (let i = 0; i < 10; i++) {
      // Newest 10 rows (positions 0-9, daysAgo 0..9): no runId at all.
      history.push(dayResult(i, {}))
    }
    for (let i = 0; i < 10; i++) {
      // Oldest 10 rows (positions 10-19, daysAgo 10..19): slow-logged.
      const runId = `old-${i}`
      history.push(dayResult(10 + i, {}, { runId }))
      runLogs.set(runId, makeSlowLog(runId))
    }

    const settings: WeakSpotDetectionSettings = { ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, missWindow: 10 }
    const windowed = createMistakeProfileCache().get(history, runLogs, 'english', 'direct', settings)
    expect(windowed.weights.o).toBeUndefined()
    expect(windowed.weights.g).toBeUndefined()

    const unboundedSettings: WeakSpotDetectionSettings = { ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, missWindow: 'all' }
    const unbounded = createMistakeProfileCache().get(history, runLogs, 'english', 'direct', unboundedSettings)
    expect(unbounded.weights.o).toBeGreaterThan(0)
    expect(unbounded.weights.g).toBeGreaterThan(0)
  })
})

describe('createMistakeProfileCache — time decay (B)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-20T12:00:00.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('a miss recorded minutes ago gets EXACTLY weight 1.0 (floor-to-day calibration)', () => {
    // A single miss just now must not be shaved below missThreshold by a
    // fractional-day decay weight — see decayWeight's own doc comment for
    // the calibration bug this floor prevents.
    const history: TypingTestResult[] = [dayResult(0, { a: 2 })]
    const cache = createMistakeProfileCache()
    const settings: WeakSpotDetectionSettings = { ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, decayHalfLifeDays: 7, missThreshold: 2 }
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct', settings)
    expect(profile.weakTokenCount).toBe(1) // 2 misses * weight 1.0 = 2 >= threshold 2
  })

  it('a miss exactly one half-life old is weighted down to ~half, dropping below threshold', () => {
    const history: TypingTestResult[] = [dayResult(7, { a: 2 })] // 7 days old
    const cache = createMistakeProfileCache()
    const settings: WeakSpotDetectionSettings = { ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, decayHalfLifeDays: 7, missThreshold: 2 }
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct', settings)
    // 2 * 0.5^(7/7) = 1.0, which is < missThreshold(2) -> not weak.
    expect(profile.weakTokenCount).toBe(0)
  })

  it('decay disabled ("none") applies full weight regardless of age', () => {
    const history: TypingTestResult[] = [dayResult(60, { a: 2 })] // 60 days old
    const cache = createMistakeProfileCache()
    const settings: WeakSpotDetectionSettings = { ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, decayHalfLifeDays: 'none', missThreshold: 2 }
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct', settings)
    expect(profile.weakTokenCount).toBe(1)
  })

  it('never applies decay to timing signals (median stays unaffected by row age)', () => {
    let col = 0
    const ks = (pressMs: number, expectedChar: string): RunKeystroke => {
      col++
      return { pressMs, keycode: 0, row: 0, col, expectedChar, correct: true }
    }
    const catWord = (startMs: number, gapMs: number): RunWord => ({
      index: 0, display: 'cat', typed: 'cat', correct: true,
      keystrokes: [ks(startMs, 'c'), ks(startMs + gapMs, 'a'), ks(startMs + 2 * gapMs, 't')],
    })
    const log: RunKeystrokeLog = {
      runId: 'old-run', uid: 'u1', startedAt: '2026-01-01T00:00:00.000Z', durationMs: 60000, mode: 'words', language: 'english',
      words: Array.from({ length: 20 }, (_, i) => catWord(i * 1000, 500)), // uniformly slow-ish but internally consistent
    }
    const history: TypingTestResult[] = [dayResult(100, {}, { runId: 'old-run' })] // ancient row
    const runLogs = new Map([['old-run', log]])
    const cache = createMistakeProfileCache()
    const withDecay = createMistakeProfileCache().get(
      history, runLogs, 'english', 'direct', { ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, decayHalfLifeDays: 7 },
    )
    const withoutDecay = cache.get(
      history, runLogs, 'english', 'direct', { ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, decayHalfLifeDays: 'none' },
    )
    // Timing-only weakness (no mistakes at all) must be identical whether
    // decay is on or off — decay only ever touches the miss aggregation.
    expect(withDecay.weights.a).toEqual(withoutDecay.weights.a)
    expect(withDecay.weights.t).toEqual(withoutDecay.weights.t)
  })
})

describe('decayWeight — UTC calendar-day granularity (matches the cache day-bucket)', () => {
  afterEach(() => vi.useRealTimers())

  it('ages by exactly 1 day the instant a UTC midnight boundary is crossed, even seconds apart', () => {
    // A row recorded 1ms before UTC midnight, evaluated 2ms later (1ms
    // before + 1ms after midnight): under an elapsed-ms floor this is
    // ageDays=0 (barely any wall-clock time passed); under the fixed
    // calendar-day floor it's ageDays=1 the moment the day rolls over —
    // the same instant createMistakeProfileCache's own day bucket changes.
    const history: TypingTestResult[] = [makeResult({ date: '2026-06-20T23:59:59.999Z', mistakes: { a: 2 } })]
    const settings: WeakSpotDetectionSettings = { ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, decayHalfLifeDays: 7, missThreshold: 2 }

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-20T23:59:59.999Z'))
    const sameInstant = createMistakeProfileCache().get(history, EMPTY_LOGS, 'english', 'direct', settings)
    expect(sameInstant.weakTokenCount).toBe(1) // ageDays 0, weight 1.0, 2 misses >= threshold 2

    vi.setSystemTime(new Date('2026-06-21T00:00:00.001Z')) // 2ms later, next UTC calendar day
    const nextDay = createMistakeProfileCache().get(history, EMPTY_LOGS, 'english', 'direct', settings)
    expect(nextDay.weakTokenCount).toBe(0) // ageDays 1 despite only 2ms of wall-clock time elapsed
  })

  it('a row\'s decay weight stays constant across time-of-day changes within the same UTC calendar day', () => {
    const history: TypingTestResult[] = [makeResult({ date: '2026-06-13T00:00:00.000Z', mistakes: { a: 10 } })]
    const settings: WeakSpotDetectionSettings = { ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, decayHalfLifeDays: 7, missThreshold: 2 }

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-20T00:00:01.000Z')) // just after midnight, 7 days later
    const morning = createMistakeProfileCache().get(history, EMPTY_LOGS, 'english', 'direct', settings)
    vi.setSystemTime(new Date('2026-06-20T23:59:59.000Z')) // just before the next midnight, same calendar day
    const night = createMistakeProfileCache().get(history, EMPTY_LOGS, 'english', 'direct', settings)

    expect(morning.weakTokenCount).toBe(1)
    expect(night.weights.a).toEqual(morning.weights.a)
  })
})

describe('createMistakeProfileCache — settings-aware cache key', () => {
  it('a detection-settings change (e.g. missThreshold) produces a distinct cache entry, not a stale hit', () => {
    const history: TypingTestResult[] = [dayResult(0, { a: 2 })]
    const cache = createMistakeProfileCache()
    const loose = cache.get(history, EMPTY_LOGS, 'english', 'direct', { ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, missThreshold: 2 })
    const strict = cache.get(history, EMPTY_LOGS, 'english', 'direct', { ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, missThreshold: 3 })
    expect(loose.weakTokenCount).toBe(1)
    expect(strict.weakTokenCount).toBe(0)
  })

  it('the built-in defaults produce the pre-existing behaviour when passed explicitly', () => {
    const history: TypingTestResult[] = [dayResult(0, { a: DEFAULT_MIN_MISS_COUNT })]
    const cache = createMistakeProfileCache()
    const profile = cache.get(history, EMPTY_LOGS, 'english', 'direct', DEFAULT_WEAK_SPOT_DETECTION_SETTINGS)
    expect(profile.weakTokenCount).toBe(1)
  })

  it('a day-boundary crossing invalidates a decay-enabled entry even with unchanged history/runLogs', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-20T12:00:00.000Z'))
    try {
      const history: TypingTestResult[] = [dayResult(7, { a: 2 })] // exactly 1 half-life old at day 0
      const cache = createMistakeProfileCache()
      const settings: WeakSpotDetectionSettings = { ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, decayHalfLifeDays: 7, missThreshold: 2 }
      const before = cache.get(history, EMPTY_LOGS, 'english', 'direct', settings)
      expect(before.weakTokenCount).toBe(0) // weight 1.0 < threshold 2

      // Advance 1 more day: the row is now 8 days old under the SAME
      // history/runLogs reference — only Date.now() changed. Without
      // day-bucketing in the cache key this would return the STALE
      // memoized `before` result forever.
      vi.setSystemTime(new Date('2026-06-21T12:00:00.000Z'))
      const after = cache.get(history, EMPTY_LOGS, 'english', 'direct', settings)
      expect(after).not.toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a decay-disabled entry is NOT invalidated by a day-boundary crossing (no time dependency)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-20T12:00:00.000Z'))
    try {
      const history: TypingTestResult[] = [dayResult(0, { a: DEFAULT_MIN_MISS_COUNT })]
      const cache = createMistakeProfileCache()
      const settings: WeakSpotDetectionSettings = { ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, decayHalfLifeDays: 'none' }
      const before = cache.get(history, EMPTY_LOGS, 'english', 'direct', settings)
      vi.setSystemTime(new Date('2026-06-25T12:00:00.000Z'))
      const after = cache.get(history, EMPTY_LOGS, 'english', 'direct', settings)
      expect(after).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('biasRatio is excluded from the cache/computation entirely — not a WeakSpotDetectionSettings field', () => {
    // Structural check: WeakSpotDetectionSettings has no biasRatio field,
    // so passing detection settings alone can never carry it into the
    // memoization key — this is enforced by TypeScript at the call sites
    // above (every `settings` literal in this file already compiles
    // without a biasRatio field), documented here as an explicit assertion
    // that the DEFAULT constant itself has no such key.
    expect('biasRatio' in DEFAULT_WEAK_SPOT_DETECTION_SETTINGS).toBe(false)
  })
})

describe('createMistakeProfileCache — LRU eviction (not FIFO)', () => {
  it('a HIT refreshes recency, so overflow evicts the next-oldest key instead of the just-hit one', () => {
    const history: TypingTestResult[] = [dayResult(0, { a: 1 })]
    const cache = createMistakeProfileCache()
    const settingsFor = (missThreshold: number): WeakSpotDetectionSettings => (
      { ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS, decayHalfLifeDays: 'none', missThreshold }
    )
    const get = (missThreshold: number) => cache.get(history, EMPTY_LOGS, 'english', 'direct', settingsFor(missThreshold))

    // Fill the cache to its 8-entry cap (missThreshold 1..8 => 8 distinct
    // keys), oldest-inserted first.
    const entries = Array.from({ length: 8 }, (_, i) => get(i + 1))

    // Re-hit entry 1 (the oldest-inserted) — under true LRU this makes it
    // the MOST recently used, so it must survive the next eviction instead
    // of entry 2 (now the actual least-recently-used).
    expect(get(1)).toBe(entries[0])

    get(9) // a 9th distinct key pushes the cache over its 8-entry cap

    expect(get(1)).toBe(entries[0]) // survived — the re-hit protected it
    expect(get(2)).not.toBe(entries[1]) // evicted instead — recomputed fresh
  })
})
