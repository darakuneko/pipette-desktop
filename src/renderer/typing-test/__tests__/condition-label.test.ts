// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { formatConditionLabel } from '../condition-label'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'

const identityT = (key: string): string => key

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

describe('formatConditionLabel', () => {
  it('formats words with the toggle suffix', () => {
    expect(formatConditionLabel(makeResult({ mode2: 50 }), identityT))
      .toBe('50 editor.typingTest.mode.words (english)')
    expect(formatConditionLabel(makeResult({ mode2: 50, punctuation: true, numbers: true }), identityT))
      .toBe('50 editor.typingTest.mode.words (english) editor.typingTest.history.conditionPunctuation editor.typingTest.history.conditionNumbers')
  })

  it('formats time as duration + s', () => {
    expect(formatConditionLabel(makeResult({ mode: 'time', mode2: 30, punctuation: true }), identityT))
      .toBe('30s (english) editor.typingTest.history.conditionPunctuation')
  })

  it('formats quote with the length label and no toggle suffix', () => {
    expect(formatConditionLabel(makeResult({ mode: 'quote', mode2: 'medium', punctuation: undefined, numbers: undefined }), identityT))
      .toBe('editor.typingTest.quoteLength.medium editor.typingTest.mode.quote (english)')
  })

  it('prefers the imported text name over the raw id', () => {
    expect(formatConditionLabel(makeResult({ mode: 'fileImport', mode2: 't1', fileImportTextName: 'novel.txt' }), identityT))
      .toBe('novel.txt')
    // Legacy rows without a captured name fall back to the stable id.
    expect(formatConditionLabel(makeResult({ mode: 'fileImport', mode2: 't1', fileImportTextName: undefined }), identityT))
      .toBe('t1')
  })

  it('formats tatoeba with the pack language', () => {
    expect(formatConditionLabel(makeResult({ mode: 'tatoeba', mode2: 'japanese', language: 'japanese' }), identityT))
      .toBe('editor.typingTest.history.conditionTatoeba (japanese)')
  })
})
