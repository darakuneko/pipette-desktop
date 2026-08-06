// SPDX-License-Identifier: GPL-2.0-or-later

// Weak Spot Training (Plan-miss-focus-mode): validateTypingTestConfig's
// optional carry-through for the new `weakSpotTrainingMode` boolean, exercised
// through the only exported entry point that reaches it, validateIpcPrefs
// — same "punctuation/numbers write path" the plan calls for. Kept as its
// own small file rather than growing a monolithic device-prefs-validate
// test suite that doesn't otherwise exist yet.

import { describe, it, expect } from 'vitest'
import { validateIpcPrefs } from '../device-prefs-validate'

function callValidate(typingTestConfig: unknown) {
  return validateIpcPrefs(
    { keyboardLayout: 'qwerty', autoAdvance: true, typingTestConfig },
    'qwerty', true, false, 'ansi', 'split', false,
  )
}

describe('validateIpcPrefs — typingTestConfig.weakSpotTrainingMode', () => {
  it('carries a persisted true through for words mode', () => {
    const result = callValidate({ mode: 'words', wordCount: 30, punctuation: false, numbers: false, weakSpotTrainingMode: true })
    expect(result?.typingTestConfig).toMatchObject({ mode: 'words', weakSpotTrainingMode: true })
  })

  it('carries a persisted true through for time mode', () => {
    const result = callValidate({ mode: 'time', duration: 30, punctuation: false, numbers: false, weakSpotTrainingMode: true })
    expect(result?.typingTestConfig).toMatchObject({ mode: 'time', weakSpotTrainingMode: true })
  })

  it('omits the field entirely when absent (not coerced to false)', () => {
    const result = callValidate({ mode: 'words', wordCount: 30, punctuation: false, numbers: false })
    expect(result?.typingTestConfig).not.toHaveProperty('weakSpotTrainingMode')
  })

  it('drops a malformed (non-boolean) value silently rather than rejecting the whole config', () => {
    const result = callValidate({ mode: 'words', wordCount: 30, punctuation: false, numbers: false, weakSpotTrainingMode: 'yes' })
    expect(result?.typingTestConfig).toBeDefined()
    expect(result?.typingTestConfig).not.toHaveProperty('weakSpotTrainingMode')
  })

  it('does not carry the field for quote mode (the field does not exist on that variant)', () => {
    const result = callValidate({ mode: 'quote', quoteLength: 'medium', weakSpotTrainingMode: true })
    expect(result?.typingTestConfig).not.toHaveProperty('weakSpotTrainingMode')
  })

  it('does not carry the field for fileImport mode', () => {
    const result = callValidate({ mode: 'fileImport', textId: 't1', weakSpotTrainingMode: true })
    expect(result?.typingTestConfig).not.toHaveProperty('weakSpotTrainingMode')
  })
})
