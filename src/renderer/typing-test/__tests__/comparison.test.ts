// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { computeComparison, matchingResults, conditionKey, resultConditionKey } from '../comparison'
import { buildTypingTestResult, configKey } from '../result-builder'
import { isRomajiInputActive } from '../romaji-input'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
import type { TypingTestConfig } from '../types'

function makeResult(overrides: Partial<TypingTestResult> = {}): TypingTestResult {
  return {
    date: '2026-06-20T00:00:00.000Z',
    wpm: 60,
    accuracy: 95,
    wordCount: 30,
    correctChars: 300,
    incorrectChars: 5,
    durationSeconds: 30,
    mode: 'words',
    mode2: 30,
    language: 'english',
    punctuation: false,
    numbers: false,
    ...overrides,
  }
}

const wordsConfig: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false } as TypingTestConfig
const fileImportConfig: TypingTestConfig = { mode: 'fileImport', textId: 't1' } as TypingTestConfig
const tatoebaConfig: TypingTestConfig = { mode: 'tatoeba', language: 'english', pattern: 'lines', lineCount: 5, duration: 30 }

describe('matchingResults', () => {
  it('matches normal runs on mode + params + language + toggles', () => {
    const pool = [
      makeResult({ wpm: 70 }),                              // match
      makeResult({ wpm: 80, mode2: 60 }),                   // different wordCount
      makeResult({ wpm: 90, language: 'japanese' }),        // different language
      makeResult({ wpm: 50, punctuation: true }),           // different toggle
      makeResult({ wpm: 55, romajiInput: true }),           // different toggle (romaji)
    ]
    const out = matchingResults(pool, wordsConfig, 'english')
    expect(out.map((r) => r.wpm)).toEqual([70])
  })

  it('matches fileImport runs on the imported text id only', () => {
    const pool = [
      makeResult({ wpm: 40, mode: 'fileImport', mode2: 't1', language: 'a' }),
      makeResult({ wpm: 45, mode: 'fileImport', mode2: 't1', language: 'b' }), // same text, diff lang → still match
      makeResult({ wpm: 99, mode: 'fileImport', mode2: 't2' }),                 // different text
    ]
    const out = matchingResults(pool, fileImportConfig, 'english')
    expect(out.map((r) => r.wpm).sort()).toEqual([40, 45])
  })

  it('matches tatoeba runs on the pack language + pattern + unit (mode2), independent of word language', () => {
    const pool = [
      makeResult({ wpm: 40, mode: 'tatoeba', mode2: 'english|lines|5', language: 'english' }),  // match
      makeResult({ wpm: 45, mode: 'tatoeba', mode2: 'english|lines|5', language: 'german' }),   // same pack+pattern+count, stray lang → still match
      makeResult({ wpm: 99, mode: 'tatoeba', mode2: 'english|lines|10' }),                       // different line count
      makeResult({ wpm: 33, mode: 'tatoeba', mode2: 'english|time|30' }),                        // different pattern
      makeResult({ wpm: 77, mode: 'tatoeba', mode2: 'french|lines|5' }),                         // different pack
      makeResult({ wpm: 12, mode: 'words', mode2: 'english' }),                                  // different mode
    ]
    const out = matchingResults(pool, tatoebaConfig, 'german')
    expect(out.map((r) => r.wpm).sort((a, b) => a - b)).toEqual([40, 45])
  })

  it('excludes results at/after beforeMs (the in-flight run)', () => {
    const pool = [
      makeResult({ wpm: 70, date: '2026-06-20T00:00:00.000Z' }),
      makeResult({ wpm: 99, date: '2026-06-21T00:00:00.000Z' }), // the current run
    ]
    const beforeMs = new Date('2026-06-21T00:00:00.000Z').getTime()
    const out = matchingResults(pool, wordsConfig, 'english', beforeMs)
    expect(out.map((r) => r.wpm)).toEqual([70])
  })
})

describe('conditionKey', () => {
  it('keys normal modes on mode + params + language + toggles', () => {
    expect(conditionKey(wordsConfig, 'english')).toBe('words|30|english|false|false|false')
    const timeConfig = { mode: 'time', duration: 10 } as TypingTestConfig
    expect(conditionKey(timeConfig, 'english')).toBe('time|10|english|false|false|false')
  })

  it('keys fileImport on the imported text id only (language-independent)', () => {
    expect(conditionKey(fileImportConfig, 'english')).toBe('fileImport|t1')
    expect(conditionKey(fileImportConfig, 'japanese')).toBe('fileImport|t1')
  })

  it('keys tatoeba on the pack language + pattern + unit (word-language-independent)', () => {
    expect(conditionKey(tatoebaConfig, 'german')).toBe('tatoeba|english|lines|5')
    expect(conditionKey(tatoebaConfig, 'japanese')).toBe('tatoeba|english|lines|5')
  })

  it('distinguishes tatoeba configs that differ only in pattern or line count/duration', () => {
    const lines5: TypingTestConfig = { mode: 'tatoeba', language: 'english', pattern: 'lines', lineCount: 5, duration: 30 }
    const lines10: TypingTestConfig = { mode: 'tatoeba', language: 'english', pattern: 'lines', lineCount: 10, duration: 30 }
    const time30: TypingTestConfig = { mode: 'tatoeba', language: 'english', pattern: 'time', lineCount: 5, duration: 30 }
    const lines5Again: TypingTestConfig = { mode: 'tatoeba', language: 'english', pattern: 'lines', lineCount: 5, duration: 60 }
    const keys = [lines5, lines10, time30].map((c) => conditionKey(c, 'english'))
    expect(new Set(keys).size).toBe(3)
    // Same language + pattern + lineCount → same key, even if the unused duration field differs.
    expect(conditionKey(lines5, 'english')).toBe(conditionKey(lines5Again, 'english'))
  })

  it('distinguishes different conditions', () => {
    const a = conditionKey(wordsConfig, 'english')
    const b = conditionKey({ mode: 'time', duration: 10 } as TypingTestConfig, 'english')
    const c = conditionKey(fileImportConfig, 'english')
    const d = conditionKey(tatoebaConfig, 'english')
    expect(new Set([a, b, c, d]).size).toBe(4)
  })

  it('distinguishes a romaji run from a verbatim run of the same kana pack', () => {
    // romajiInput defaults ON for a capable (kana) language, so a genuine
    // "verbatim" run needs the explicit opt-out — an unset romajiInput on a
    // kana language is itself the (default-active) romaji run.
    const verbatimConfig: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false, romajiInput: false }
    const romajiConfig: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false, romajiInput: true }
    const a = conditionKey(verbatimConfig, 'japanese_hiragana')
    const b = conditionKey(romajiConfig, 'japanese_hiragana')
    expect(a).not.toBe(b)
  })
})

describe('resultConditionKey', () => {
  it('keys normal modes on mode + params + language + toggles', () => {
    expect(resultConditionKey(makeResult())).toBe('words|30|english|false|false|false')
    expect(resultConditionKey(makeResult({ mode: 'time', mode2: 30 })))
      .toBe('time|30|english|false|false|false')
  })

  it('distinguishes different word counts, languages and toggles', () => {
    const a = resultConditionKey(makeResult())
    const b = resultConditionKey(makeResult({ mode2: 60 }))
    const c = resultConditionKey(makeResult({ language: 'japanese' }))
    const d = resultConditionKey(makeResult({ punctuation: true }))
    const e = resultConditionKey(makeResult({ romajiInput: true }))
    expect(new Set([a, b, c, d, e]).size).toBe(5)
  })

  it('keys fileImport on the imported text id only (language-independent)', () => {
    const r1 = makeResult({ mode: 'fileImport', mode2: 't1', language: 'english' })
    const r2 = makeResult({ mode: 'fileImport', mode2: 't1', language: 'japanese' })
    expect(resultConditionKey(r1)).toBe(resultConditionKey(r2))
    expect(resultConditionKey(r1)).toBe('fileImport|t1')
  })

  it('keys tatoeba on the pack language + pattern + unit (mode2) only', () => {
    const r1 = makeResult({ mode: 'tatoeba', mode2: 'japanese|lines|5', language: 'japanese' })
    const r2 = makeResult({ mode: 'tatoeba', mode2: 'japanese|lines|5', language: 'german' })
    expect(resultConditionKey(r1)).toBe(resultConditionKey(r2))
    expect(resultConditionKey(r1)).toBe('tatoeba|japanese|lines|5')
  })

  it('falls back sensibly for legacy rows missing mode/mode2/language', () => {
    const legacy: TypingTestResult = {
      date: '2025-01-01T00:00:00.000Z', wpm: 50, accuracy: 90, wordCount: 10,
      correctChars: 50, incorrectChars: 2, durationSeconds: 20,
    }
    expect(resultConditionKey(legacy)).toBe('words|||false|false|false')
  })
})

describe('conditionKey / resultConditionKey agreement', () => {
  // Guards against the two definitions drifting apart: conditionKey derives
  // its key from a live TypingTestConfig, resultConditionKey from a saved
  // TypingTestResult — they must key every mode identically since
  // matchingResults compares one against the other.
  const buildInput = (config: TypingTestConfig) => ({
    correctChars: 100,
    incorrectChars: 5,
    wordCount: 20,
    wpm: 60,
    accuracy: 95,
    elapsedMs: 20_000,
    config,
    language: 'english',
    wpmHistory: [60],
    fileImportTextName: 'novel.txt',
    mistakes: {},
    // Mirrors the real call site (useInputModes.ts): romajiActive is always
    // the effective isRomajiInputActive state, not the raw config flag — a
    // config with an explicit `romajiInput: true` on a non-capable language
    // (as below) is still inactive, and conditionKey must agree.
    romajiActive: isRomajiInputActive(config, 'english', undefined),
  })

  it('agrees for every mode', () => {
    const configs: TypingTestConfig[] = [
      { mode: 'words', wordCount: 30, punctuation: false, numbers: false },
      { mode: 'words', wordCount: 30, punctuation: true, numbers: true },
      { mode: 'words', wordCount: 30, punctuation: false, numbers: false, romajiInput: true },
      { mode: 'time', duration: 30, punctuation: false, numbers: false },
      { mode: 'quote', quoteLength: 'medium' },
      { mode: 'fileImport', textId: 't1' },
      { mode: 'tatoeba', language: 'japanese', pattern: 'lines', lineCount: 5, duration: 30 },
    ]
    for (const config of configs) {
      const result = buildTypingTestResult(buildInput(config))
      expect(conditionKey(config, 'english')).toBe(resultConditionKey(result))
    }
  })

  it('groups a default-ON kana words run with its own saved result (regression)', () => {
    // romajiInput is left unset — default-ON — on a kana-capable language.
    // The live conditionKey must land on the same key as the result this
    // exact run produces, or a fresh PB/comparison never finds its own history.
    const config: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false }
    const language = 'japanese_hiragana'
    const romajiActive = isRomajiInputActive(config, language, undefined)
    expect(romajiActive).toBe(true)
    const result = buildTypingTestResult({
      correctChars: 100,
      incorrectChars: 5,
      wordCount: 20,
      wpm: 60,
      accuracy: 95,
      elapsedMs: 20_000,
      config,
      language,
      wpmHistory: [60],
      romajiActive,
      mistakes: {},
    })
    expect(conditionKey(config, language)).toBe(resultConditionKey(result))
    expect(conditionKey(config, language)).toBe(configKey(result))
  })
})

describe('computeComparison', () => {
  const pool = [
    makeResult({ wpm: 60, accuracy: 90, date: '2026-06-18T00:00:00.000Z' }),
    makeResult({ wpm: 80, accuracy: 96, date: '2026-06-19T00:00:00.000Z' }),
    makeResult({ wpm: 70, accuracy: 92, date: '2026-06-20T00:00:00.000Z' }),
  ]

  it('off → null', () => {
    expect(computeComparison(pool, wordsConfig, 'english', { kind: 'off' })).toBeNull()
  })

  it('previous → most recent matching run', () => {
    const out = computeComparison(pool, wordsConfig, 'english', { kind: 'previous' })
    expect(out?.wpm).toBe(70)
  })

  it('best → highest WPM', () => {
    const out = computeComparison(pool, wordsConfig, 'english', { kind: 'best' })
    expect(out?.wpm).toBe(80)
  })

  it('average → rounded mean of each metric', () => {
    const out = computeComparison(pool, wordsConfig, 'english', { kind: 'average' })
    expect(out?.wpm).toBe(70) // (60+80+70)/3
    expect(out?.accuracy).toBe(93) // (90+96+92)/3 = 92.67 → 93
  })

  it('pinned → the result with the matching date, condition-independent', () => {
    const out = computeComparison(pool, fileImportConfig, 'english', { kind: 'pinned', pinnedDate: '2026-06-19T00:00:00.000Z' })
    expect(out?.wpm).toBe(80)
  })

  it('pinned with a missing/unknown date → null', () => {
    expect(computeComparison(pool, wordsConfig, 'english', { kind: 'pinned' })).toBeNull()
    expect(computeComparison(pool, wordsConfig, 'english', { kind: 'pinned', pinnedDate: 'nope' })).toBeNull()
  })

  it('no matching history → null', () => {
    const out = computeComparison([], wordsConfig, 'english', { kind: 'previous' })
    expect(out).toBeNull()
  })
})
