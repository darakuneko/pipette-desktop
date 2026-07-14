// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { isTimeBoundedRun, runDurationSeconds } from '../types'
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
