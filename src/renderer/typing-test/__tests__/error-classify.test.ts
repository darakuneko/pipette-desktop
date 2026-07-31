// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { classifyErrors, classifyWordResults, errorClassGroup, sumErrorClassGroups } from '../error-classify'
import type { WordResult } from '../run-state'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'

describe('classifyErrors', () => {
  it('classifies a single substitution (road -> riad)', () => {
    expect(classifyErrors('road', 'riad')).toEqual({
      substitutions: 1,
      omissions: 0,
      insertions: 0,
      targetChars: 4,
    })
  })

  it('classifies a single omission (committee -> commitee)', () => {
    expect(classifyErrors('committee', 'commitee')).toEqual({
      substitutions: 0,
      omissions: 1,
      insertions: 0,
      targetChars: 9,
    })
  })

  it('classifies a single insertion (string -> strring)', () => {
    expect(classifyErrors('string', 'strring')).toEqual({
      substitutions: 0,
      omissions: 0,
      insertions: 1,
      targetChars: 6,
    })
  })

  it('returns all-zero counts for two empty strings', () => {
    expect(classifyErrors('', '')).toEqual({
      substitutions: 0,
      omissions: 0,
      insertions: 0,
      targetChars: 0,
    })
  })

  it('treats an empty typed string as all-omissions (all-deleted)', () => {
    expect(classifyErrors('abc', '')).toEqual({
      substitutions: 0,
      omissions: 3,
      insertions: 0,
      targetChars: 3,
    })
  })

  it('treats an empty target string as all-insertions', () => {
    expect(classifyErrors('', 'abc')).toEqual({
      substitutions: 0,
      omissions: 0,
      insertions: 3,
      targetChars: 0,
    })
  })

  it('tie-break: prefers substitution over an omission+insertion split (ab -> ba)', () => {
    // Both "two substitutions" and "one omission + one insertion" (in some
    // arrangement) reach the minimal distance of 2. The documented
    // priority (diagonal move first) always picks the substitution
    // reading.
    expect(classifyErrors('ab', 'ba')).toEqual({
      substitutions: 2,
      omissions: 0,
      insertions: 0,
      targetChars: 2,
    })
  })

  it('tie-break: prefers omission over insertion when both are optimal (aba -> bcab)', () => {
    // A reversed priority (insertion before omission) would read this as
    // 2 substitutions + 1 insertion instead — same distance (3), a
    // different class split. Pinning the documented priority here
    // guarantees this doesn't silently drift.
    expect(classifyErrors('aba', 'bcab')).toEqual({
      substitutions: 0,
      omissions: 1,
      insertions: 2,
      targetChars: 3,
    })
  })

  it('is code-point safe for surrogate pairs', () => {
    // U+1F600 (😀) and U+1F601 (😁) are each a surrogate pair (2 UTF-16
    // code units). A naive index-based diff would see 4 mismatched code
    // units here instead of 1 substituted code point.
    expect(classifyErrors('😀b', '😁b')).toEqual({
      substitutions: 1,
      omissions: 0,
      insertions: 0,
      targetChars: 2,
    })
  })

  it('is code-point safe when a surrogate pair is entirely omitted', () => {
    expect(classifyErrors('a😀b', 'ab')).toEqual({
      substitutions: 0,
      omissions: 1,
      insertions: 0,
      targetChars: 3,
    })
  })

  it('handles an over-typed word (typed much longer than target)', () => {
    const result = classifyErrors('a', 'aaaaa')
    expect(result.omissions).toBe(0)
    expect(result.substitutions).toBe(0)
    expect(result.insertions).toBe(4)
    expect(result.targetChars).toBe(1)
  })

  it('bails out to an all-zero, zero-targetChars result when target*typed exceeds the DP cell cap', () => {
    // 600 * 600 = 360,000 cells, over MAX_DP_CELLS (250,000) — a
    // pathological single "word" (e.g. a line-break-free File Import
    // source with no space to break on) rather than anything a human
    // actually types. Even though the two strings are identical (which
    // would normally classify as zero errors anyway), the honest
    // fallback still excludes targetChars entirely — nothing was
    // computed for this word, so it must not contribute to the rate
    // denominator either.
    const huge = 'a'.repeat(600)
    expect(classifyErrors(huge, huge)).toEqual({
      substitutions: 0,
      omissions: 0,
      insertions: 0,
      targetChars: 0,
    })
  })
})

describe('classifyWordResults', () => {
  it('sums classifyErrors across every finalized word, including Σ target length', () => {
    const wordResults: WordResult[] = [
      { word: 'road', typed: 'riad', correct: false },
      { word: 'committee', typed: 'commitee', correct: false },
      { word: 'string', typed: 'strring', correct: false },
    ]
    expect(classifyWordResults(wordResults)).toEqual({
      substitutions: 1,
      omissions: 1,
      insertions: 1,
      targetChars: 4 + 9 + 6,
    })
  })

  it('treats a skipped word (typed: "") as all-omissions', () => {
    const wordResults: WordResult[] = [
      { word: 'hello', typed: '', correct: false },
    ]
    expect(classifyWordResults(wordResults)).toEqual({
      substitutions: 0,
      omissions: 5,
      insertions: 0,
      targetChars: 5,
    })
  })

  it('returns all-zero counts for an empty word-result list', () => {
    expect(classifyWordResults([])).toEqual({
      substitutions: 0,
      omissions: 0,
      insertions: 0,
      targetChars: 0,
    })
  })

  it('does not classify correctly-typed words as errors', () => {
    const wordResults: WordResult[] = [
      { word: 'hello', typed: 'hello', correct: true },
    ]
    expect(classifyWordResults(wordResults)).toEqual({
      substitutions: 0,
      omissions: 0,
      insertions: 0,
      targetChars: 5,
    })
  })

  it('excludes a pathologically long word from the run aggregate entirely, including targetChars', () => {
    const huge = 'a'.repeat(600)
    const wordResults: WordResult[] = [
      { word: 'road', typed: 'riad', correct: false },
      { word: huge, typed: huge, correct: true },
    ]
    // Only 'road' contributes — the huge word adds nothing, not even to
    // targetChars (see classifyErrors' MAX_DP_CELLS guard).
    expect(classifyWordResults(wordResults)).toEqual({
      substitutions: 1,
      omissions: 0,
      insertions: 0,
      targetChars: 4,
    })
  })
})

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

describe('errorClassGroup', () => {
  it('reads back the 4-field group when all fields are present', () => {
    const group = errorClassGroup(baseResult({
      errorSubstitutions: 2, errorOmissions: 1, errorInsertions: 0, errorTargetChars: 40,
    }))
    expect(group).toEqual({ substitutions: 2, omissions: 1, insertions: 0, targetChars: 40 })
  })

  it('returns null when any one of the four fields is missing', () => {
    expect(errorClassGroup(baseResult())).toBeNull()
    expect(errorClassGroup(baseResult({ errorSubstitutions: 2, errorTargetChars: 40 }))).toBeNull()
  })

  it('reads back an all-zero group (not mistaken for "not set")', () => {
    const group = errorClassGroup(baseResult({
      errorSubstitutions: 0, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 40,
    }))
    expect(group).toEqual({ substitutions: 0, omissions: 0, insertions: 0, targetChars: 40 })
  })

  it('returns null when a field is null rather than a number (malformed JSON, not just absent)', () => {
    // `=== undefined` alone would let a smuggled `null` through and hand
    // callers a non-number; `typeof !== 'number'` catches it. Cast
    // through `unknown` since this shape is deliberately off-contract
    // for TypingTestResult (that's the point of the test).
    const malformed = baseResult({
      errorSubstitutions: 2, errorOmissions: 1, errorInsertions: 0, errorTargetChars: 40,
    }) as unknown as Record<string, unknown>
    malformed.errorOmissions = null
    expect(errorClassGroup(malformed as unknown as TypingTestResult)).toBeNull()
  })
})

describe('sumErrorClassGroups', () => {
  it('sums the 4-field group char-weighted across every qualifying result', () => {
    const results: TypingTestResult[] = [
      baseResult({ errorSubstitutions: 2, errorOmissions: 1, errorInsertions: 0, errorTargetChars: 100 }),
      baseResult({ errorSubstitutions: 1, errorOmissions: 1, errorInsertions: 1, errorTargetChars: 100 }),
    ]
    expect(sumErrorClassGroups(results)).toEqual({
      substitutions: 3, omissions: 2, insertions: 1, targetChars: 200,
    })
  })

  it('excludes results missing the group instead of treating them as zero', () => {
    const results: TypingTestResult[] = [
      baseResult({ errorSubstitutions: 4, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 100 }),
      baseResult(), // no group at all
    ]
    expect(sumErrorClassGroups(results)).toEqual({
      substitutions: 4, omissions: 0, insertions: 0, targetChars: 100,
    })
  })

  it('returns null when nothing in the set qualifies', () => {
    expect(sumErrorClassGroups([baseResult()])).toBeNull()
    expect(sumErrorClassGroups([])).toBeNull()
  })
})
