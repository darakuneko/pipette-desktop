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

describe('sanitizeTypingTestResult average key-hold fields', () => {
  it('keeps a valid holdSumMs/holdSamples pair', () => {
    const result = sanitizeTypingTestResult(baseResult({ holdSumMs: 240, holdSamples: 3 }))
    expect(result.holdSumMs).toBe(240)
    expect(result.holdSamples).toBe(3)
  })

  it('leaves both fields undefined when neither is present', () => {
    const result = sanitizeTypingTestResult(baseResult())
    expect(result.holdSumMs).toBeUndefined()
    expect(result.holdSamples).toBeUndefined()
  })

  it('drops the pair when only one of the two fields is present', () => {
    expect(sanitizeTypingTestResult(baseResult({ holdSumMs: 240 })).holdSumMs).toBeUndefined()
    expect(sanitizeTypingTestResult(baseResult({ holdSamples: 3 })).holdSamples).toBeUndefined()
  })

  it('drops the pair when holdSamples is 0 (division-by-zero guard)', () => {
    const result = sanitizeTypingTestResult(baseResult({ holdSumMs: 0, holdSamples: 0 }))
    expect(result.holdSumMs).toBeUndefined()
    expect(result.holdSamples).toBeUndefined()
  })

  it('drops the pair when holdSamples is fractional or negative', () => {
    expect(sanitizeTypingTestResult(baseResult({ holdSumMs: 240, holdSamples: 3.5 })).holdSamples).toBeUndefined()
    expect(sanitizeTypingTestResult(baseResult({ holdSumMs: 240, holdSamples: -1 })).holdSamples).toBeUndefined()
  })

  it('drops the pair when holdSumMs is negative or non-finite', () => {
    expect(sanitizeTypingTestResult(baseResult({ holdSumMs: -10, holdSamples: 3 })).holdSumMs).toBeUndefined()
    expect(sanitizeTypingTestResult(baseResult({ holdSumMs: Number.NaN, holdSamples: 3 })).holdSumMs).toBeUndefined()
  })
})

describe('sanitizeTypingTestResult error-class fields', () => {
  it('keeps a valid all-four error-class group', () => {
    const result = sanitizeTypingTestResult(baseResult({
      errorSubstitutions: 2, errorOmissions: 1, errorInsertions: 0, errorTargetChars: 40,
    }))
    expect(result.errorSubstitutions).toBe(2)
    expect(result.errorOmissions).toBe(1)
    expect(result.errorInsertions).toBe(0)
    expect(result.errorTargetChars).toBe(40)
  })

  it('leaves all four fields undefined when none are present', () => {
    const result = sanitizeTypingTestResult(baseResult())
    expect(result.errorSubstitutions).toBeUndefined()
    expect(result.errorOmissions).toBeUndefined()
    expect(result.errorInsertions).toBeUndefined()
    expect(result.errorTargetChars).toBeUndefined()
  })

  it('drops the whole group when only some of the four fields are present', () => {
    const result = sanitizeTypingTestResult(baseResult({ errorSubstitutions: 2, errorTargetChars: 40 }))
    expect(result.errorSubstitutions).toBeUndefined()
    expect(result.errorOmissions).toBeUndefined()
    expect(result.errorInsertions).toBeUndefined()
    expect(result.errorTargetChars).toBeUndefined()
  })

  it('drops the whole group when errorTargetChars is 0 (division-by-zero guard)', () => {
    const result = sanitizeTypingTestResult(baseResult({
      errorSubstitutions: 0, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 0,
    }))
    expect(result.errorTargetChars).toBeUndefined()
  })

  it('drops the whole group when a field is fractional or negative', () => {
    const result = sanitizeTypingTestResult(baseResult({
      errorSubstitutions: 1.5, errorOmissions: 1, errorInsertions: 0, errorTargetChars: 40,
    }))
    expect(result.errorSubstitutions).toBeUndefined()
    expect(result.errorTargetChars).toBeUndefined()
  })
})

describe('sanitizeTypingTestResult — weakSpotTrainingMode', () => {
  it('passes through an explicit true', () => {
    expect(sanitizeTypingTestResult(baseResult({ weakSpotTrainingMode: true })).weakSpotTrainingMode).toBe(true)
  })

  it('coerces false to undefined (asymmetric true-only convention)', () => {
    expect(sanitizeTypingTestResult(baseResult({ weakSpotTrainingMode: false })).weakSpotTrainingMode).toBeUndefined()
  })

  it('is undefined when absent', () => {
    expect(sanitizeTypingTestResult(baseResult()).weakSpotTrainingMode).toBeUndefined()
  })

  it('coerces a malformed (non-boolean) value to undefined', () => {
    const corrupted = { ...baseResult(), weakSpotTrainingMode: 'yes' } as unknown as TypingTestResult
    expect(sanitizeTypingTestResult(corrupted).weakSpotTrainingMode).toBeUndefined()
  })
})
