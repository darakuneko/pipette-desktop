// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { isTimeBoundedRun, runDurationSeconds, isWeakSpotTrainingActive } from '../types'
import type { TypingTestConfig } from '../types'

const wordsConfig: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false }
const timeConfig: TypingTestConfig = { mode: 'time', duration: 45, punctuation: false, numbers: false }
const quoteConfig: TypingTestConfig = { mode: 'quote', quoteLength: 'medium' }
const fileImportConfig: TypingTestConfig = { mode: 'fileImport', textId: 't1' }
const tatoebaLinesConfig: TypingTestConfig = { mode: 'tatoeba', language: 'english', pattern: 'lines', lineCount: 10, duration: 60 }
const tatoebaTimeConfig: TypingTestConfig = { mode: 'tatoeba', language: 'english', pattern: 'time', lineCount: 10, duration: 60 }

describe('isTimeBoundedRun', () => {
  it('is true for monkeytype time mode', () => {
    expect(isTimeBoundedRun(timeConfig)).toBe(true)
  })

  it('is true for tatoeba with the Time pattern', () => {
    expect(isTimeBoundedRun(tatoebaTimeConfig)).toBe(true)
  })

  it('is false for tatoeba with the Lines pattern', () => {
    expect(isTimeBoundedRun(tatoebaLinesConfig)).toBe(false)
  })

  it('is false for words/quote/fileImport', () => {
    expect(isTimeBoundedRun(wordsConfig)).toBe(false)
    expect(isTimeBoundedRun(quoteConfig)).toBe(false)
    expect(isTimeBoundedRun(fileImportConfig)).toBe(false)
  })
})

describe('runDurationSeconds', () => {
  it('reads duration from monkeytype time mode', () => {
    expect(runDurationSeconds(timeConfig)).toBe(45)
  })

  it('reads duration from tatoeba with the Time pattern', () => {
    expect(runDurationSeconds(tatoebaTimeConfig)).toBe(60)
  })

  it('is null for tatoeba with the Lines pattern, even though duration is still stored', () => {
    expect(runDurationSeconds(tatoebaLinesConfig)).toBeNull()
  })

  it('is null for words/quote/fileImport', () => {
    expect(runDurationSeconds(wordsConfig)).toBeNull()
    expect(runDurationSeconds(quoteConfig)).toBeNull()
    expect(runDurationSeconds(fileImportConfig)).toBeNull()
  })
})

describe('isWeakSpotTrainingActive', () => {
  it('is false when unset (default off)', () => {
    expect(isWeakSpotTrainingActive(wordsConfig)).toBe(false)
    expect(isWeakSpotTrainingActive(timeConfig)).toBe(false)
  })

  it('is false when explicitly false', () => {
    expect(isWeakSpotTrainingActive({ ...wordsConfig, weakSpotTrainingMode: false })).toBe(false)
  })

  it('is true for words/time when explicitly true', () => {
    expect(isWeakSpotTrainingActive({ ...wordsConfig, weakSpotTrainingMode: true })).toBe(true)
    expect(isWeakSpotTrainingActive({ ...timeConfig, weakSpotTrainingMode: true })).toBe(true)
  })

  it('is false for quote/fileImport/tatoeba — the field does not exist on those variants', () => {
    expect(isWeakSpotTrainingActive(quoteConfig)).toBe(false)
    expect(isWeakSpotTrainingActive(fileImportConfig)).toBe(false)
    expect(isWeakSpotTrainingActive(tatoebaLinesConfig)).toBe(false)
  })
})
