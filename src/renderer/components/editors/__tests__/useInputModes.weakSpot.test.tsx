// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Weak Spot Training (Plan-miss-focus-mode) end-to-end coverage at the
// useInputModes layer: the getMistakeProfile thunk built from
// typingTestHistory reaches useTypingTest, and a finished run's
// weakSpotTrainingMode flag reaches the saved TypingTestResult. Drives a real
// 1-word practice run the same way useInputModes.run-log.test.tsx does.
// These fixtures use MISS-based weakness (not timing) — the mistake
// signal needs no run log, keeping this file free of IPC mocking; the
// timing-signal path has its own dedicated coverage in
// weak-spot-timing.test.ts / weak-spot-scoring.test.ts /
// weak-spot-profile.test.ts (composite aggregation).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useInputModes } from '../useInputModes'
import { configKey } from '../../../typing-test/result-builder'
import { DEFAULT_MIN_MISS_COUNT } from '../../../typing-test/weak-spot-scoring'
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
 *  history would — required to reach an 'active' gate at all. No
 *  `typingRecordKeyboard` is ever passed, so useWeakSpotRunLogs's uid is
 *  always undefined and it never touches `window.vialAPI` — these tests
 *  exercise the miss-only path deliberately. */
async function runOneWordToCompletion(
  weakSpotTrainingMode: boolean | undefined,
  typingTestHistory?: TypingTestResult[],
): Promise<TypingTestResult> {
  const onSaveTypingTestResult = vi.fn()
  const keymap = buildKeymap()
  const config = { mode: 'words' as const, wordCount: 1, punctuation: false, numbers: false, weakSpotTrainingMode }
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

// english/direct scope, one token ('a') crossing DEFAULT_MIN_MISS_COUNT — gate
// 'active'.
function activeHistory(): TypingTestResult[] {
  return [{
    date: '2025-01-01T00:00:00.000Z',
    wpm: 50, accuracy: 95, wordCount: 30, correctChars: 90, incorrectChars: 10,
    durationSeconds: 30, mode: 'words', mode2: 30, language: 'english',
    punctuation: false, numbers: false, mistakes: { a: DEFAULT_MIN_MISS_COUNT },
  }]
}

// Same scope, loaded but with no mistakes at all — gate 'no-weak-spots'
// (not 'unavailable' — history IS loaded).
function noWeakSpotsHistory(): TypingTestResult[] {
  return [{
    date: '2025-01-01T00:00:00.000Z',
    wpm: 50, accuracy: 95, wordCount: 30, correctChars: 100, incorrectChars: 0,
    durationSeconds: 30, mode: 'words', mode2: 30, language: 'english',
    punctuation: false, numbers: false,
  }]
}

describe('useInputModes — weakSpotTrainingMode passthrough into the saved result', () => {
  // codex regression: the saved flag used to come straight from the
  // config toggle (isWeakSpotTrainingActive), so a run started with the
  // toggle ON but the gate NOT met (sampled normally — state.weakSpotProfile
  // stayed undefined) was still persisted as a weak-spot run, wrongly
  // splitting it into the biased PB/comparison condition alongside genuinely
  // biased runs. The flag must now reflect whether the run's own snapshot
  // profile (`state.weakSpotProfile`) was actually non-null.

  it('toggle ON + gate no-weak-spots: the run sampled normally, so NO flag is saved and it groups with normal runs', async () => {
    const saved = await runOneWordToCompletion(true, noWeakSpotsHistory())
    expect(saved.weakSpotTrainingMode).toBeUndefined()
    // Groups with a plain (toggle-never-touched) run of the same
    // condition — same configKey, no `|weakspot` split into a separate
    // PB/comparison pool.
    const plainRun: TypingTestResult = { ...saved, weakSpotTrainingMode: undefined }
    expect(configKey(saved)).toBe(configKey(plainRun))
    expect(configKey(saved)).not.toMatch(/\|weakspot$/)
  })

  it('toggle ON + gate unavailable (no history loaded at all): NO flag is saved either', async () => {
    const saved = await runOneWordToCompletion(true)
    expect(saved.weakSpotTrainingMode).toBeUndefined()
  })

  it('toggle ON + gate active: the run actually sampled biased, so the flag IS saved', async () => {
    const saved = await runOneWordToCompletion(true, activeHistory())
    expect(saved.weakSpotTrainingMode).toBe(true)
    expect(configKey(saved)).toMatch(/\|weakspot$/)
  })

  it('toggle ON + gate active: the effective settings snapshot is saved alongside the flag, using the DEFAULT values since no weakSpot detail was configured', async () => {
    const saved = await runOneWordToCompletion(true, activeHistory())
    expect(saved.weakSpotSettings).toEqual({
      missThreshold: 2, slownessRatio: 1.5, stallRate: 0.2, stallMultiple: 2, minTimingSamples: 15,
      missWindow: 50, decayHalfLifeDays: 'none', biasRatio: 0.6,
    })
  })

  it('a run that sampled normally (no snapshot flag) saves no settings snapshot either (both-or-neither)', async () => {
    const saved = await runOneWordToCompletion(true, noWeakSpotsHistory())
    expect(saved.weakSpotSettings).toBeUndefined()
  })

  it('a run with weakSpotTrainingMode: false saves weakSpotTrainingMode: undefined (asymmetric), even with an active gate', async () => {
    const saved = await runOneWordToCompletion(false, activeHistory())
    expect(saved.weakSpotTrainingMode).toBeUndefined()
  })

  it('a run with weakSpotTrainingMode unset saves weakSpotTrainingMode: undefined', async () => {
    const saved = await runOneWordToCompletion(undefined)
    expect(saved.weakSpotTrainingMode).toBeUndefined()
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
      typingTestHistory: activeHistory(),
    }))
    expect(result.current.typingTest.weakSpotGate.status).toBe('active')
  })

  it('weakSpotGate is "no-weak-spots" (not "unavailable") when history is loaded but nothing is weak', () => {
    const keymap = buildKeymap()
    const { result } = renderHook(() => useInputModes({
      rows: 1, cols: 1, keymap, unlocked: true, typingTestMode: true,
      savedTypingTestConfig: { mode: 'words', wordCount: 30, punctuation: false, numbers: false },
      typingTestHistory: noWeakSpotsHistory(),
    }))
    expect(result.current.typingTest.weakSpotGate.status).toBe('no-weak-spots')
  })
})
