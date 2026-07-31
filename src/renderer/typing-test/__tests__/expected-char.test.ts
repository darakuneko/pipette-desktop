// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { deriveExpectedChar } from '../expected-char'
import type { TypingTestState } from '../run-state'
import { createInitialState } from '../run-state'
import { DEFAULT_CONFIG, DEFAULT_LANGUAGE } from '../types'

describe('deriveExpectedChar', () => {
  it('returns the next unconfirmed character of the current word in verbatim mode', () => {
    const state: TypingTestState = { ...createInitialState(DEFAULT_CONFIG, DEFAULT_LANGUAGE), words: ['hello'], currentInput: 'he' }
    expect(deriveExpectedChar(state, DEFAULT_CONFIG, DEFAULT_LANGUAGE)).toBe('l')
  })

  it('returns undefined once past the last word', () => {
    const state: TypingTestState = { ...createInitialState(DEFAULT_CONFIG, DEFAULT_LANGUAGE), words: ['hi'], currentWordIndex: 1 }
    expect(deriveExpectedChar(state, DEFAULT_CONFIG, DEFAULT_LANGUAGE)).toBeUndefined()
  })
})
