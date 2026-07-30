// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { isNonNegInt, sanitizeTypingTestResult } from '../typing-test-result-sanitize'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'

function baseResult(overrides: Partial<TypingTestResult> = {}): TypingTestResult {
  return {
    date: '2026-01-01T00:00:00.000Z',
    wpm: 50,
    accuracy: 95,
    wordCount: 10,
    correctChars: 50,
    incorrectChars: 2,
    durationSeconds: 30,
    ...overrides,
  }
}

describe('isNonNegInt', () => {
  it('accepts a non-negative integer', () => {
    expect(isNonNegInt(0)).toBe(true)
    expect(isNonNegInt(42)).toBe(true)
  })

  it('rejects a fractional number', () => {
    expect(isNonNegInt(1.5)).toBe(false)
    expect(isNonNegInt(0.1)).toBe(false)
  })

  it('rejects a negative number, NaN, Infinity, and non-numbers', () => {
    expect(isNonNegInt(-1)).toBe(false)
    expect(isNonNegInt(Number.NaN)).toBe(false)
    expect(isNonNegInt(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isNonNegInt('3')).toBe(false)
    expect(isNonNegInt(null)).toBe(false)
    expect(isNonNegInt(undefined)).toBe(false)
  })
})

describe('sanitizeTypingTestResult KSPC fields', () => {
  it('keeps a valid integer kspcKeystrokes/kspcChars pair', () => {
    const result = sanitizeTypingTestResult(baseResult({ kspcKeystrokes: 12, kspcChars: 10 }))
    expect(result.kspcKeystrokes).toBe(12)
    expect(result.kspcChars).toBe(10)
  })

  it('drops a fractional kspcKeystrokes/kspcChars pair rather than treating it as valid', () => {
    const result = sanitizeTypingTestResult(baseResult({ kspcKeystrokes: 12.5, kspcChars: 10 }))
    expect(result.kspcKeystrokes).toBeUndefined()
    expect(result.kspcChars).toBeUndefined()
  })

  it('drops a fractional kspcChars even when kspcKeystrokes is a valid integer', () => {
    const result = sanitizeTypingTestResult(baseResult({ kspcKeystrokes: 12, kspcChars: 10.25 }))
    expect(result.kspcKeystrokes).toBeUndefined()
    expect(result.kspcChars).toBeUndefined()
  })
})
