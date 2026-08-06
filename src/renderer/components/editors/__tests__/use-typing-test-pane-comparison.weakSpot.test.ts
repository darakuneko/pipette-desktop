// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// codex regression coverage: useTypingTestPaneComparison's currentConditionKey
// (and matchingResults/computeComparison calls) used to key weakSpotTrainingMode
// off the raw toggle (isWeakSpotTrainingActive), while a saved result only
// ever sets the flag when the run's OWN state.weakSpotProfile snapshot was
// actually non-null (use-typing-test-result-save.ts). With the toggle on but
// the keystroke gate not met, the live key carried `|weakspot` while every
// comparable saved result (including this exact run's own) never did —
// breaking PB/comparison grouping. This exercises the REAL useTypingTest +
// useTypingTestPaneComparison wiring (not just comparison.ts's own unit
// tests) to prove the effective-state override actually reaches both hooks.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTypingTest } from '../../../typing-test/useTypingTest'
import { useTypingTestPaneComparison } from '../use-typing-test-pane-comparison'
import type { TypingTestResult, TypingTestComparisonBaselines } from '../../../../shared/types/pipette-settings'
import type { TypingTestConfig } from '../../../typing-test/types'
import type { MistakeProfile } from '../../../typing-test/weak-spot-profile'

const MET_PROFILE: MistakeProfile = { weights: { e: 1000 }, weakTokenCount: 1, topWeakTokens: ['e'] }

const mockPipetteSettingsListAllTypingResults = vi.fn<() => Promise<TypingTestResult[]>>()

beforeEach(() => {
  mockPipetteSettingsListAllTypingResults.mockReset().mockResolvedValue([])
  Object.defineProperty(window, 'vialAPI', {
    value: { pipetteSettingsListAllTypingResults: mockPipetteSettingsListAllTypingResults },
    writable: true,
    configurable: true,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

const weakSpotConfig: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false, weakSpotTrainingMode: true }

/** The legacy (no-suffix) key a plain, non-weak-spot 30-word English run
 *  keys under — hardcoded the same way comparison.test.ts's own backward-
 *  compatibility regression pins it, so this test doesn't silently pass if
 *  configKey's own format ever drifts. */
const LEGACY_KEY = 'words|30|english|false|false|false'
const WEAKSPOT_KEY = `${LEGACY_KEY}|weakspot`

function renderCombined(opts: {
  gateMet: boolean
  comparisonBaselines?: TypingTestComparisonBaselines
  typingTestHistory?: TypingTestResult[]
}) {
  return renderHook(() => {
    const typingTest = useTypingTest(weakSpotConfig, 'english', {
      getMistakeProfile: opts.gateMet ? (() => MET_PROFILE) : undefined,
    })
    const comparison = useTypingTestPaneComparison({
      typingTest,
      typingTestHistory: opts.typingTestHistory,
      comparisonBaselines: opts.comparisonBaselines,
    })
    return { typingTest, comparison }
  })
}

describe('useTypingTestPaneComparison — weakSpotActive wiring', () => {
  it('toggle ON + gate unmet: state.weakSpotProfile is null and the baseline is looked up under the LEGACY (no-suffix) key', async () => {
    const { result } = renderCombined({
      gateMet: false,
      comparisonBaselines: { [LEGACY_KEY]: { kind: 'best' }, [WEAKSPOT_KEY]: { kind: 'average' } },
    })
    await flushMicrotasks()
    expect(result.current.typingTest.state.weakSpotProfile).toBeUndefined()
    // If the live key wrongly carried `|weakspot` here, this would resolve
    // to 'average' (or the DEFAULT_COMPARISON_BASELINE, if it read a key
    // present in neither) instead of the legacy entry's 'best'.
    expect(result.current.comparison.comparisonBaselineValue).toEqual({ kind: 'best' })
  })

  it('toggle ON + gate met: state.weakSpotProfile is set and the baseline is looked up under the |weakspot key', async () => {
    const { result } = renderCombined({
      gateMet: true,
      comparisonBaselines: { [LEGACY_KEY]: { kind: 'best' }, [WEAKSPOT_KEY]: { kind: 'average' } },
    })
    await flushMicrotasks()
    expect(result.current.typingTest.state.weakSpotProfile).toBeDefined()
    expect(result.current.comparison.comparisonBaselineValue).toEqual({ kind: 'average' })
  })

  it('toggle ON + gate unmet: sameConditionResults pools with a normal (unflagged) saved result, not a biased one', async () => {
    const normalResult: TypingTestResult = {
      date: '2026-01-01T00:00:00.000Z', wpm: 40, accuracy: 95, wordCount: 30,
      correctChars: 100, incorrectChars: 5, durationSeconds: 30,
      mode: 'words', mode2: 30, language: 'english', punctuation: false, numbers: false,
    }
    const biasedResult: TypingTestResult = { ...normalResult, wpm: 90, weakSpotTrainingMode: true }
    mockPipetteSettingsListAllTypingResults.mockResolvedValue([normalResult, biasedResult])

    const { result, rerender } = renderCombined({ gateMet: false })
    await flushMicrotasks()
    rerender()
    expect(result.current.comparison.sameConditionResults).toEqual([normalResult])
  })

  it('toggle ON + gate met: sameConditionResults pools with the biased saved result, not the normal one', async () => {
    const normalResult: TypingTestResult = {
      date: '2026-01-01T00:00:00.000Z', wpm: 40, accuracy: 95, wordCount: 30,
      correctChars: 100, incorrectChars: 5, durationSeconds: 30,
      mode: 'words', mode2: 30, language: 'english', punctuation: false, numbers: false,
    }
    const biasedResult: TypingTestResult = { ...normalResult, wpm: 90, weakSpotTrainingMode: true }
    mockPipetteSettingsListAllTypingResults.mockResolvedValue([normalResult, biasedResult])

    const { result, rerender } = renderCombined({ gateMet: true })
    await flushMicrotasks()
    rerender()
    expect(result.current.comparison.sameConditionResults).toEqual([biasedResult])
  })
})
