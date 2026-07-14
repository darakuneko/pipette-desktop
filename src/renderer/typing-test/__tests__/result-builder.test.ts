// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  buildTypingTestResult,
  computeRawWpm,
  computeConsistency,
  isPbForConfig,
  trimResults,
  typingTestResultMaterialLabel,
  resultKpm,
  buildResultNameChips,
} from '../result-builder'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
import type { TypingTestConfig } from '../types'

describe('typingTestResultMaterialLabel', () => {
  const base: TypingTestResult = {
    date: '2026-01-01T00:00:00.000Z', wpm: 50, accuracy: 95, wordCount: 10,
    correctChars: 50, incorrectChars: 2, durationSeconds: 30,
  }
  it('uses mode (language) for normal modes', () => {
    expect(typingTestResultMaterialLabel({ ...base, mode: 'words', language: 'english' }))
      .toBe('words (english)')
    expect(typingTestResultMaterialLabel({ ...base, mode: 'quote', language: 'japanese' }))
      .toBe('quote (japanese)')
  })
  it('uses the snapshotted text name for fileImport mode', () => {
    expect(typingTestResultMaterialLabel({ ...base, mode: 'fileImport', fileImportTextName: 'novel.txt' }))
      .toBe('novel.txt')
    // Falls back to 'fileImport' when the name wasn't captured.
    expect(typingTestResultMaterialLabel({ ...base, mode: 'fileImport' })).toBe('fileImport')
  })
  it('uses tatoeba-<language> for tatoeba mode', () => {
    expect(typingTestResultMaterialLabel({ ...base, mode: 'tatoeba', language: 'english' }))
      .toBe('tatoeba-english')
  })
})

describe('computeRawWpm', () => {
  it('computes raw WPM from total chars and duration', () => {
    // 300 chars in 60000ms = 1 minute → 300/5 = 60 WPM
    expect(computeRawWpm(300, 60000)).toBe(60)
  })

  it('returns 0 for zero duration', () => {
    expect(computeRawWpm(100, 0)).toBe(0)
  })

  it('rounds to nearest integer', () => {
    // 37 chars in 60000ms → 37/5 = 7.4 → 7
    expect(computeRawWpm(37, 60000)).toBe(7)
    // 38 chars in 60000ms → 38/5 = 7.6 → 8
    expect(computeRawWpm(38, 60000)).toBe(8)
  })
})

describe('computeConsistency', () => {
  it('returns 100 for constant WPM', () => {
    expect(computeConsistency([60, 60, 60, 60, 60])).toBe(100)
  })

  it('returns 100 for single-element array', () => {
    expect(computeConsistency([80])).toBe(100)
  })

  it('returns 100 for empty array', () => {
    expect(computeConsistency([])).toBe(100)
  })

  it('returns lower value for variable WPM', () => {
    const result = computeConsistency([20, 80, 20, 80, 20])
    expect(result).toBeGreaterThanOrEqual(0)
    expect(result).toBeLessThan(100)
  })

  it('returns value between 0 and 100', () => {
    const result = computeConsistency([10, 100, 50, 30, 90])
    expect(result).toBeGreaterThanOrEqual(0)
    expect(result).toBeLessThanOrEqual(100)
  })

  it('handles all-zero WPM', () => {
    expect(computeConsistency([0, 0, 0])).toBe(100)
  })
})

describe('isPbForConfig', () => {
  const makeResult = (wpm: number, mode: 'words' | 'time' | 'quote' = 'words', mode2: number | string = 30): TypingTestResult => ({
    date: new Date().toISOString(),
    wpm,
    accuracy: 95,
    wordCount: 30,
    correctChars: 100,
    incorrectChars: 5,
    durationSeconds: 30,
    mode,
    mode2,
    language: 'english',
    punctuation: false,
    numbers: false,
  })

  it('returns true when no previous results exist', () => {
    expect(isPbForConfig(makeResult(60), [])).toBe(true)
  })

  it('returns true when WPM exceeds all previous for same config', () => {
    const history = [makeResult(50), makeResult(55)]
    expect(isPbForConfig(makeResult(60), history)).toBe(true)
  })

  it('returns false when WPM does not exceed previous best', () => {
    const history = [makeResult(70), makeResult(55)]
    expect(isPbForConfig(makeResult(60), history)).toBe(false)
  })

  it('ignores results from different config', () => {
    const history = [makeResult(100, 'time', 30)]
    expect(isPbForConfig(makeResult(60, 'words', 30), history)).toBe(true)
  })

  it('ignores results with different mode2', () => {
    const history = [makeResult(100, 'words', 60)]
    expect(isPbForConfig(makeResult(60, 'words', 30), history)).toBe(true)
  })

  it('distinguishes by language', () => {
    const history = [{ ...makeResult(100), language: 'japanese' }]
    const result = { ...makeResult(60), language: 'english' }
    expect(isPbForConfig(result, history)).toBe(true)
  })

  it('distinguishes by punctuation', () => {
    const history = [{ ...makeResult(100), punctuation: true }]
    const result = { ...makeResult(60), punctuation: false }
    expect(isPbForConfig(result, history)).toBe(true)
  })

  it('distinguishes by numbers', () => {
    const history = [{ ...makeResult(100), numbers: true }]
    const result = { ...makeResult(60), numbers: false }
    expect(isPbForConfig(result, history)).toBe(true)
  })

  it('distinguishes by romajiInput', () => {
    const history = [{ ...makeResult(100), romajiInput: true }]
    const result = { ...makeResult(60), romajiInput: false }
    expect(isPbForConfig(result, history)).toBe(true)
  })
})

describe('trimResults', () => {
  it('returns array unchanged when under limit', () => {
    const results = [{ date: '1' } as TypingTestResult, { date: '2' } as TypingTestResult]
    expect(trimResults(results, 500)).toHaveLength(2)
  })

  it('trims to max keeping most recent (first) entries', () => {
    const results = Array.from({ length: 10 }, (_, i) => ({ date: String(i) }) as TypingTestResult)
    const trimmed = trimResults(results, 5)
    expect(trimmed).toHaveLength(5)
    expect(trimmed[0].date).toBe('0')
    expect(trimmed[4].date).toBe('4')
  })

  it('handles empty array', () => {
    expect(trimResults([], 500)).toHaveLength(0)
  })
})

describe('buildTypingTestResult', () => {
  it('builds a complete result from inputs', () => {
    const config: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: true, numbers: false }
    const result = buildTypingTestResult({
      correctChars: 100,
      incorrectChars: 5,
      wordCount: 30,
      wpm: 60,
      accuracy: 95,
      elapsedMs: 30000,
      config,
      language: 'english',
      wpmHistory: [55, 58, 60, 62],
      romajiActive: false,
    })

    expect(result.wpm).toBe(60)
    expect(result.accuracy).toBe(95)
    expect(result.wordCount).toBe(30)
    expect(result.correctChars).toBe(100)
    expect(result.incorrectChars).toBe(5)
    expect(result.durationSeconds).toBe(30)
    expect(result.mode).toBe('words')
    expect(result.mode2).toBe(30)
    expect(result.language).toBe('english')
    expect(result.punctuation).toBe(true)
    expect(result.numbers).toBe(false)
    expect(result.rawWpm).toBeTypeOf('number')
    expect(result.consistency).toBeTypeOf('number')
    expect(result.wpmHistory).toEqual([55, 58, 60, 62])
    expect(result.date).toBeTruthy()
  })

  it('records romajiInput from the romajiActive input, not the raw config flag', () => {
    const wordsConfig: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false, romajiInput: true }
    const withRomaji = buildTypingTestResult({
      correctChars: 20, incorrectChars: 1, wordCount: 5, wpm: 40, accuracy: 95, elapsedMs: 20000,
      config: wordsConfig, language: 'japanese_hiragana', wpmHistory: [], romajiActive: true,
    })
    expect(withRomaji.romajiInput).toBe(true)

    const notActive = buildTypingTestResult({
      correctChars: 20, incorrectChars: 1, wordCount: 5, wpm: 40, accuracy: 95, elapsedMs: 20000,
      config: wordsConfig, language: 'japanese_hiragana', wpmHistory: [], romajiActive: false,
    })
    expect(notActive.romajiInput).toBeUndefined()

    const quoteConfig: TypingTestConfig = { mode: 'quote', quoteLength: 'medium' }
    const quoteResult = buildTypingTestResult({
      correctChars: 20, incorrectChars: 1, wordCount: 5, wpm: 40, accuracy: 95, elapsedMs: 20000,
      config: quoteConfig, language: 'english', wpmHistory: [], romajiActive: false,
    })
    expect(quoteResult.romajiInput).toBeUndefined()
  })

  it('records romajiInput for tatoeba/fileImport runs too, now that recording follows romajiActive', () => {
    const tatoebaCfg: TypingTestConfig = { mode: 'tatoeba', language: 'japanese_hiragana', pattern: 'lines', lineCount: 5, duration: 30 }
    const result = buildTypingTestResult({
      correctChars: 20, incorrectChars: 1, wordCount: 5, wpm: 40, accuracy: 95, elapsedMs: 20000,
      config: tatoebaCfg, language: 'english', wpmHistory: [], romajiActive: true,
    })
    expect(result.romajiInput).toBe(true)
  })

  it('derives mode2 from time config', () => {
    const config: TypingTestConfig = { mode: 'time', duration: 60, punctuation: false, numbers: false }
    const result = buildTypingTestResult({
      correctChars: 200,
      incorrectChars: 10,
      wordCount: 42,
      wpm: 80,
      accuracy: 95,
      elapsedMs: 60000,
      config,
      language: 'english',
      wpmHistory: [],
      romajiActive: false,
    })
    expect(result.mode).toBe('time')
    expect(result.mode2).toBe(60)
  })

  it('derives mode2 from quote config', () => {
    const config: TypingTestConfig = { mode: 'quote', quoteLength: 'medium' }
    const result = buildTypingTestResult({
      correctChars: 150,
      incorrectChars: 3,
      wordCount: 30,
      wpm: 70,
      accuracy: 98,
      elapsedMs: 45000,
      config,
      language: 'english',
      wpmHistory: [],
      romajiActive: false,
    })
    expect(result.mode).toBe('quote')
    expect(result.mode2).toBe('medium')
  })

  it('stores the tatoeba pack language as language + mode2, not the input language', () => {
    const config: TypingTestConfig = { mode: 'tatoeba', language: 'english', pattern: 'lines', lineCount: 5, duration: 30 }
    const result = buildTypingTestResult({
      correctChars: 120,
      incorrectChars: 4,
      wordCount: 20,
      wpm: 65,
      accuracy: 97,
      elapsedMs: 40000,
      config,
      // The top-level (MonkeyType) language is irrelevant for tatoeba.
      language: 'german',
      wpmHistory: [],
      romajiActive: false,
    })
    expect(result.mode).toBe('tatoeba')
    expect(result.mode2).toBe('english')
    expect(result.language).toBe('english')
    expect(typingTestResultMaterialLabel(result)).toBe('tatoeba-english')
  })
})

describe('resultKpm', () => {
  const base: TypingTestResult = {
    date: '2026-01-01T00:00:00.000Z', wpm: 50, accuracy: 95, wordCount: 10,
    correctChars: 150, incorrectChars: 2, durationSeconds: 30,
  }
  it('derives keys per minute from chars and duration', () => {
    // 150 chars over 30s -> 300 kpm
    expect(resultKpm(base)).toBe(300)
  })
  it('returns 0 for zero duration', () => {
    expect(resultKpm({ ...base, durationSeconds: 0 })).toBe(0)
  })
})

describe('buildResultNameChips', () => {
  const base: TypingTestResult = {
    date: '2026-06-29T11:05:01.000Z', wpm: 139, accuracy: 99, wordCount: 10,
    correctChars: 150, incorrectChars: 2, durationSeconds: 30,
  }
  // Stub translator: maps the metric-label keys to their English labels.
  const tStub = (k: string): string =>
    ({ 'editor.typingTest.wpm': 'WPM', 'editor.typingTest.kpm': 'KPM', 'editor.typingTest.accuracy': 'Accuracy' }[k] ?? k)
  it('builds material-label, timestamp and metric chips', () => {
    const chips = buildResultNameChips({ ...base, mode: 'fileImport', fileImportTextName: 'Scala - Test001' }, tStub)
    expect(chips[0]).toBe('Scala - Test001')
    // compact local timestamp YYYYMMDDHHmmss (14 digits)
    expect(chips[1]).toMatch(/^\d{14}$/)
    expect(chips).toContain('WPM139')
    expect(chips).toContain('KPM300')
    expect(chips).toContain('Accuracy99')
  })
  it('uses mode (language) label for normal modes', () => {
    const chips = buildResultNameChips({ ...base, mode: 'words', language: 'english' }, tStub)
    expect(chips[0]).toBe('words (english)')
  })
  it('prepends the keyboard name when provided', () => {
    const chips = buildResultNameChips({ ...base, mode: 'words', language: 'english' }, tStub, 'Ieneko54R')
    expect(chips[0]).toBe('Ieneko54R')
    expect(chips[1]).toBe('words (english)')
  })
})
