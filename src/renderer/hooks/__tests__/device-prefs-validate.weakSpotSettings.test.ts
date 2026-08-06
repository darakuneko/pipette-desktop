// SPDX-License-Identifier: GPL-2.0-or-later

// Weak Spot Settings modal (Plan-weak-spot-settings-modal): field-level
// validation of the optional `weakSpot` nested object on words/time
// TypingTestConfig — mirrors device-prefs-validate.weakSpot.test.ts's own
// coverage of the (unrelated) `weakSpotTrainingMode` boolean flag, kept as its
// own file for the same "small focused suite" reason that one gives.

import { describe, it, expect } from 'vitest'
import { validateIpcPrefs } from '../device-prefs-validate'

function callValidate(typingTestConfig: unknown) {
  return validateIpcPrefs(
    { keyboardLayout: 'qwerty', autoAdvance: true, typingTestConfig },
    'qwerty', true, false, 'ansi', 'split', false,
  )
}

const VALID_WEAK_SPOT = {
  missThreshold: 5, slownessRatio: 2.5, stallRate: 0.3, stallMultiple: 3, minTimingSamples: 25,
  missWindow: 100, decayHalfLifeDays: 14, biasRatio: 0.8,
}

describe('validateIpcPrefs — typingTestConfig.weakSpot', () => {
  it('carries every valid field through unchanged for words mode', () => {
    const result = callValidate({ mode: 'words', wordCount: 30, punctuation: false, numbers: false, weakSpot: VALID_WEAK_SPOT })
    expect(result?.typingTestConfig).toMatchObject({ mode: 'words', weakSpot: VALID_WEAK_SPOT })
  })

  it('carries every valid field through unchanged for time mode', () => {
    const result = callValidate({ mode: 'time', duration: 30, punctuation: false, numbers: false, weakSpot: VALID_WEAK_SPOT })
    expect(result?.typingTestConfig).toMatchObject({ mode: 'time', weakSpot: VALID_WEAK_SPOT })
  })

  it('carries the "all"/"none" literal escape values through for missWindow/decayHalfLifeDays', () => {
    const result = callValidate({
      mode: 'words', wordCount: 30, punctuation: false, numbers: false,
      weakSpot: { missWindow: 'all', decayHalfLifeDays: 'none' },
    })
    expect(result?.typingTestConfig).toMatchObject({ weakSpot: { missWindow: 'all', decayHalfLifeDays: 'none' } })
  })

  it('omits weakSpot entirely when absent (not coerced to an empty object)', () => {
    const result = callValidate({ mode: 'words', wordCount: 30, punctuation: false, numbers: false })
    expect(result?.typingTestConfig).not.toHaveProperty('weakSpot')
  })

  it('drops an individually out-of-range field while keeping every valid sibling field (field-level validation)', () => {
    const result = callValidate({
      mode: 'words', wordCount: 30, punctuation: false, numbers: false,
      weakSpot: { missThreshold: 999, slownessRatio: 2.5 },
    })
    expect(result?.typingTestConfig).toMatchObject({ weakSpot: { slownessRatio: 2.5 } })
    const weakSpot = (result?.typingTestConfig as { weakSpot?: Record<string, unknown> })?.weakSpot
    expect(weakSpot).not.toHaveProperty('missThreshold')
  })

  it('drops a non-integer missThreshold (fractional, not one of the curated options)', () => {
    const result = callValidate({ mode: 'words', wordCount: 30, punctuation: false, numbers: false, weakSpot: { missThreshold: 2.5 } })
    expect(result?.typingTestConfig).not.toHaveProperty('weakSpot')
  })

  it('drops an unrecognized slownessRatio (not one of the 5 curated options)', () => {
    const result = callValidate({ mode: 'words', wordCount: 30, punctuation: false, numbers: false, weakSpot: { slownessRatio: 1.8 } })
    expect(result?.typingTestConfig).not.toHaveProperty('weakSpot')
  })

  it('drops an unrecognized missWindow value (not one of the 5 valid options)', () => {
    const result = callValidate({ mode: 'words', wordCount: 30, punctuation: false, numbers: false, weakSpot: { missWindow: 15 } })
    expect(result?.typingTestConfig).not.toHaveProperty('weakSpot')
  })

  it('drops an unrecognized decayHalfLifeDays value', () => {
    const result = callValidate({ mode: 'words', wordCount: 30, punctuation: false, numbers: false, weakSpot: { decayHalfLifeDays: 21 } })
    expect(result?.typingTestConfig).not.toHaveProperty('weakSpot')
  })

  it('drops an out-of-range biasRatio (above 1.0)', () => {
    const result = callValidate({ mode: 'words', wordCount: 30, punctuation: false, numbers: false, weakSpot: { biasRatio: 1.5 } })
    expect(result?.typingTestConfig).not.toHaveProperty('weakSpot')
  })

  it('drops a malformed (non-object) weakSpot silently rather than rejecting the whole config', () => {
    const result = callValidate({ mode: 'words', wordCount: 30, punctuation: false, numbers: false, weakSpot: 'nope' })
    expect(result?.typingTestConfig).toBeDefined()
    expect(result?.typingTestConfig).not.toHaveProperty('weakSpot')
  })

  it('does not carry weakSpot for quote mode (the field does not exist on that variant)', () => {
    const result = callValidate({ mode: 'quote', quoteLength: 'medium', weakSpot: VALID_WEAK_SPOT })
    expect(result?.typingTestConfig).not.toHaveProperty('weakSpot')
  })

  it('does not carry weakSpot for fileImport mode', () => {
    const result = callValidate({ mode: 'fileImport', textId: 't1', weakSpot: VALID_WEAK_SPOT })
    expect(result?.typingTestConfig).not.toHaveProperty('weakSpot')
  })

  it('words -> quote -> time carry (mirrors the romaji detail carry test): a valid weakSpot round-trips through validation independently of mode switches', () => {
    // validateTypingTestConfig itself is stateless per call — this asserts
    // the SAME payload validates identically for words and time, which is
    // what TypingTestSettingsBar's togglesRef carry-through depends on
    // (see TypingTestSettingsBar.test.tsx's own mode-switch carry test for
    // the live-carry behavior; this just confirms both target shapes
    // validate the field the same way).
    const words = callValidate({ mode: 'words', wordCount: 30, punctuation: false, numbers: false, weakSpot: { missThreshold: 5 } })
    const time = callValidate({ mode: 'time', duration: 30, punctuation: false, numbers: false, weakSpot: { missThreshold: 5 } })
    expect(words?.typingTestConfig).toMatchObject({ weakSpot: { missThreshold: 5 } })
    expect(time?.typingTestConfig).toMatchObject({ weakSpot: { missThreshold: 5 } })
  })
})
