// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Weak Spot Training (Plan-miss-focus-mode) end-to-end coverage at the
// useInputModes layer: the getMistakeProfile thunk built from
// typingTestHistory reaches useTypingTest, and a finished run's
// weakSpotTraining flag reaches the saved TypingTestResult. Drives a real
// 1-word practice run the same way useInputModes.run-log.test.tsx does.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useInputModes } from '../useInputModes'
import { configKey } from '../../../typing-test/result-builder'
import type { TypingTestResult } from '../../../../shared/types/pipette-settings'

function buildKeymap(): Map<string, number> {
  const m = new Map<string, number>()
  m.set('0,0,0', 0x04) // KC_A
  return m
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Drives a 1-word practice run to completion via real matrix presses +
 *  DOM char events, mirroring useInputModes.run-log.test.tsx's own
 *  helper shape. Returns the finished result recorded via
 *  onSaveTypingTestResult. `typingTestHistory` (omitted by default) feeds
 *  the getMistakeProfile thunk the same way a real caller's device-prefs
 *  history would — required to reach a 'met' gate at all. */
async function runOneWordToCompletion(
  weakSpotTraining: boolean | undefined,
  typingTestHistory?: TypingTestResult[],
): Promise<TypingTestResult> {
  const onSaveTypingTestResult = vi.fn()
  const keymap = buildKeymap()
  const config = { mode: 'words' as const, wordCount: 1, punctuation: false, numbers: false, weakSpotTraining }
  const { result } = renderHook(() => useInputModes({
    rows: 1,
    cols: 1,
    keymap,
    unlocked: true,
    typingTestMode: true,
    typingTestViewOnly: false,
    onSaveTypingTestResult,
    savedTypingTestConfig: config,
    saveUnnamed: true,
    typingTestHistory,
  }))

  act(() => {
    result.current.typingTest.setWindowFocused(true)
  })
  const [word] = result.current.typingTest.state.words
  for (const char of word) {
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), keymap)
    })
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(), keymap)
    })
    act(() => {
      result.current.typingTest.processKeyEvent(char, false, false, false)
    })
  }
  expect(result.current.typingTest.state.status).toBe('finished')
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })

  expect(onSaveTypingTestResult).toHaveBeenCalledTimes(1)
  return onSaveTypingTestResult.mock.calls[0][0] as TypingTestResult
}

// A history whose scope (english/direct) sums to >= the 200-keystroke gate
// — mirrors the "getMistakeProfile thunk wiring" describe block below.
function sufficientHistory(): TypingTestResult[] {
  return Array.from({ length: 5 }, (_, i) => ({
    date: `2025-01-0${i + 1}T00:00:00.000Z`,
    wpm: 50, accuracy: 95, wordCount: 30, correctChars: 100, incorrectChars: 0,
    durationSeconds: 30, mode: 'words', mode2: 30, language: 'english',
    punctuation: false, numbers: false, kspcKeystrokes: 200,
  }))
}

// Same scope, deliberately under the threshold (1 row * 50 keystrokes = 50
// < 200) — gate 'insufficient', not 'unavailable' (history IS loaded).
function insufficientHistory(): TypingTestResult[] {
  return [{
    date: '2025-01-01T00:00:00.000Z',
    wpm: 50, accuracy: 95, wordCount: 30, correctChars: 45, incorrectChars: 5,
    durationSeconds: 30, mode: 'words', mode2: 30, language: 'english',
    punctuation: false, numbers: false, kspcKeystrokes: 50,
  }]
}

describe('useInputModes — weakSpotTraining passthrough into the saved result', () => {
  // codex regression: the saved flag used to come straight from the
  // config toggle (isWeakSpotTrainingActive), so a run started with the
  // toggle ON but the gate NOT met (sampled normally — state.weakSpotProfile
  // stayed undefined) was still persisted as a weak-spot run, wrongly
  // splitting it into the biased PB/comparison condition alongside genuinely
  // biased runs. The flag must now reflect whether the run's own snapshot
  // profile (`state.weakSpotProfile`) was actually non-null.

  it('toggle ON + gate insufficient: the run sampled normally, so NO flag is saved and it groups with normal runs', async () => {
    const saved = await runOneWordToCompletion(true, insufficientHistory())
    expect(saved.weakSpotTraining).toBeUndefined()
    // Groups with a plain (toggle-never-touched) run of the same
    // condition — same configKey, no `|weakspot` split into a separate
    // PB/comparison pool.
    const plainRun: TypingTestResult = { ...saved, weakSpotTraining: undefined }
    expect(configKey(saved)).toBe(configKey(plainRun))
    expect(configKey(saved)).not.toMatch(/\|weakspot$/)
  })

  it('toggle ON + gate unavailable (no history loaded at all): NO flag is saved either', async () => {
    const saved = await runOneWordToCompletion(true)
    expect(saved.weakSpotTraining).toBeUndefined()
  })

  it('toggle ON + gate met: the run actually sampled biased, so the flag IS saved', async () => {
    const saved = await runOneWordToCompletion(true, sufficientHistory())
    expect(saved.weakSpotTraining).toBe(true)
    expect(configKey(saved)).toMatch(/\|weakspot$/)
  })

  it('a run with weakSpotTraining: false saves weakSpotTraining: undefined (asymmetric), even with a met gate', async () => {
    const saved = await runOneWordToCompletion(false, sufficientHistory())
    expect(saved.weakSpotTraining).toBeUndefined()
  })

  it('a run with weakSpotTraining unset saves weakSpotTraining: undefined', async () => {
    const saved = await runOneWordToCompletion(undefined)
    expect(saved.weakSpotTraining).toBeUndefined()
  })
})

describe('useInputModes — getMistakeProfile thunk wiring', () => {
  it('weakSpotGate is "unavailable" when typingTestHistory is not passed at all', () => {
    const keymap = buildKeymap()
    const { result } = renderHook(() => useInputModes({
      rows: 1, cols: 1, keymap, unlocked: true, typingTestMode: true,
      savedTypingTestConfig: { mode: 'words', wordCount: 30, punctuation: false, numbers: false },
    }))
    expect(result.current.typingTest.weakSpotGate.status).toBe('unavailable')
  })

  it('weakSpotGate reflects an aggregated profile once typingTestHistory is provided', () => {
    const keymap = buildKeymap()
    const { result } = renderHook(() => useInputModes({
      rows: 1, cols: 1, keymap, unlocked: true, typingTestMode: true,
      savedTypingTestConfig: { mode: 'words', wordCount: 30, punctuation: false, numbers: false },
      typingTestHistory: sufficientHistory(),
    }))
    // 5 rows * 200 keystrokes = 1000 >= threshold (200) -> gate met.
    expect(result.current.typingTest.weakSpotGate.status).toBe('met')
  })

  it('weakSpotGate is "insufficient" (not "unavailable") when history is loaded but under threshold', () => {
    const keymap = buildKeymap()
    const { result } = renderHook(() => useInputModes({
      rows: 1, cols: 1, keymap, unlocked: true, typingTestMode: true,
      savedTypingTestConfig: { mode: 'words', wordCount: 30, punctuation: false, numbers: false },
      typingTestHistory: insufficientHistory(),
    }))
    expect(result.current.typingTest.weakSpotGate.status).toBe('insufficient')
    expect(result.current.typingTest.weakSpotGate.deficit).toBe(150)
  })
})
