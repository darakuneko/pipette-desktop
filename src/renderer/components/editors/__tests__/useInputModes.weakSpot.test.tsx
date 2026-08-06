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
 *  onSaveTypingTestResult. */
async function runOneWordToCompletion(weakSpotTraining: boolean | undefined): Promise<TypingTestResult> {
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

describe('useInputModes — weakSpotTraining passthrough into the saved result', () => {
  it('a run with weakSpotTraining: true saves weakSpotTraining: true', async () => {
    const saved = await runOneWordToCompletion(true)
    expect(saved.weakSpotTraining).toBe(true)
  })

  it('a run with weakSpotTraining: false saves weakSpotTraining: undefined (asymmetric)', async () => {
    const saved = await runOneWordToCompletion(false)
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
    const history: TypingTestResult[] = Array.from({ length: 5 }, (_, i) => ({
      date: `2025-01-0${i + 1}T00:00:00.000Z`,
      wpm: 50, accuracy: 95, wordCount: 30, correctChars: 100, incorrectChars: 0,
      durationSeconds: 30, mode: 'words', mode2: 30, language: 'english',
      punctuation: false, numbers: false, kspcKeystrokes: 200,
    }))
    const { result } = renderHook(() => useInputModes({
      rows: 1, cols: 1, keymap, unlocked: true, typingTestMode: true,
      savedTypingTestConfig: { mode: 'words', wordCount: 30, punctuation: false, numbers: false },
      typingTestHistory: history,
    }))
    // 5 rows * 200 keystrokes = 1000 >= threshold (200) -> gate met.
    expect(result.current.typingTest.weakSpotGate.status).toBe('met')
  })
})
