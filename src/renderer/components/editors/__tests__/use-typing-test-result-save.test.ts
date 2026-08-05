// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// Focused unit coverage for useTypingTestResultSave's `lineBreaks`
// derivation at finish time (Plan-line-keystroke-timeline PR1) — see
// .claude/tasks/backlog/Task-line-timeline-pr1-persist-linebreaks.md and
// the P2 codex-review fixes: the source is chosen by `config.mode` (never
// by `state.lineBreaks.size`, which can't tell "real single-line text"
// apart from "no real line source"), and every clamp is STRICT
// (`< persistedWordCount - 1`, not `< persistedWordCount`) since a line
// break can never legitimately land on the run's own last persisted word.
// Every other existing behavior of this hook (result build/save,
// pending-unnamed naming, memory-clear-on-finish) is already covered
// end-to-end via useInputModes.run-log.test.tsx and
// useInputModes.analytics.test.tsx, so this file drives the hook
// directly with a minimal stub `typingTest` rather than a full HID-driven
// run.

import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { RefObject } from 'react'
import { useTypingTestResultSave } from '../use-typing-test-result-save'
import type { UseTypingTestResultSaveOptions } from '../use-typing-test-result-save'
import type { UseTypingTestReturn, TypingTestState } from '../../../typing-test/useTypingTest'
import type { LineSnapshot } from '../../../typing-test/TypingTestView'
import { DEFAULT_CONFIG } from '../../../typing-test/types'
import type { TypingTestConfig } from '../../../typing-test/types'
import type { UseRunLogRecorderReturn } from '../use-run-log-recorder'
import type { RunKeystrokeLog } from '../../../../shared/types/typing-run-log'

// Real-line sources (word-supply.ts): both route through
// parseFileImportText (typing-test-text-store.ts), so both carry genuine
// `state.lineBreaks` and both are subject to the terminal-break rule.
const FILE_IMPORT_CONFIG: TypingTestConfig = { mode: 'fileImport', textId: 't' }
const TATOEBA_TIME_CONFIG: TypingTestConfig = { mode: 'tatoeba', language: 'english', pattern: 'time', lineCount: 5, duration: 60 }

function makeState(overrides: Partial<TypingTestState> = {}): TypingTestState {
  return {
    status: 'finished',
    runId: 'run-1',
    words: ['a', 'b', 'c', 'd'],
    currentWordIndex: 4,
    currentInput: '',
    compositionText: '',
    wordResults: [
      { word: 'a', typed: 'a', correct: true },
      { word: 'b', typed: 'b', correct: true },
      { word: 'c', typed: 'c', correct: true },
      { word: 'd', typed: 'd', correct: true },
    ],
    startTime: 1000,
    endTime: 2000,
    correctChars: 4,
    incorrectChars: 0,
    totalKeystrokes: 4,
    confirmedChars: 4,
    kspcUncomputable: false,
    currentQuote: null,
    wpmHistory: [],
    lineBreaks: new Set(),
    lineIndents: [],
    romajiKeystrokes: '',
    kanaCharIndex: 0,
    kanaAwaitingMark: false,
    kanaSegmentErred: false,
    romajiCapable: false,
    mistakes: {},
    romajiSegmentErred: false,
    missedPositions: [],
    ...overrides,
  }
}

function makeTypingTest(stateOverrides: Partial<TypingTestState>, config: TypingTestConfig): UseTypingTestReturn {
  return {
    state: makeState(stateOverrides),
    wpm: 50,
    kpm: 0,
    accuracy: 100,
    kspc: null,
    romajiGuide: null,
    kanaGuide: null,
    elapsedSeconds: 1,
    remainingSeconds: null,
    config,
    language: 'english',
    isLanguageLoading: false,
    baseLayer: 0,
    effectiveLayer: 0,
    windowFocused: true,
    processMatrixFrame: vi.fn(),
    resetMatrixPressTracking: vi.fn().mockResolvedValue(undefined),
    processKeyEvent: vi.fn(),
    processCompositionStart: vi.fn(),
    processCompositionUpdate: vi.fn(),
    processCompositionEnd: vi.fn(),
    restart: vi.fn(),
    restartWithCountdown: vi.fn(),
    setConfig: vi.fn(),
    setLanguage: vi.fn(),
    setBaseLayer: vi.fn(),
    setWindowFocused: vi.fn(),
    captureMemory: vi.fn(),
    pause: vi.fn(),
    restoreState: vi.fn(),
  }
}

function run(
  stateOverrides: Partial<TypingTestState>,
  lineSnapshot: LineSnapshot | null = null,
  config: TypingTestConfig = DEFAULT_CONFIG,
): { finishAndSave: ReturnType<typeof vi.fn> } {
  const finishAndSave = vi.fn()
  const runLog: UseRunLogRecorderReturn = {
    record: vi.fn(),
    noteRegistration: vi.fn(),
    noteCharContext: vi.fn(),
    finishAndSave,
    currentRunHoldStats: vi.fn().mockReturnValue({ holdSumMs: 0, holdSamples: 0 }),
    discardRun: vi.fn(),
  }
  const options: UseTypingTestResultSaveOptions = {
    typingTest: makeTypingTest(stateOverrides, config),
    onSaveTypingTestResult: vi.fn(),
    saveUnnamed: true,
    savedMemoryRef: { current: undefined } as RefObject<undefined>,
    onMemoryChangeRef: { current: undefined } as RefObject<undefined>,
    keyboardRef: { current: { uid: 'kb-1', vendorId: 1, productId: 1, productName: 'x' } } as UseTypingTestResultSaveOptions['keyboardRef'],
    flushAfterPendingEmits: vi.fn(),
    runLog,
    lineSnapshotRef: { current: lineSnapshot },
  }
  renderHook(() => useTypingTestResultSave(options))
  return { finishAndSave }
}

function lineBreaksArg(finishAndSave: ReturnType<typeof vi.fn>): number[] | undefined {
  expect(finishAndSave).toHaveBeenCalledTimes(1)
  const meta = finishAndSave.mock.calls[0][2] as { lineBreaks?: number[] }
  return meta.lineBreaks
}

describe('useTypingTestResultSave — lineBreaks derivation (line timeline PR1)', () => {
  describe('real-line sources (config.mode, not state.lineBreaks.size, selects this path)', () => {
    it('fileImport: sorted, clamped strictly before the terminal word', () => {
      const { finishAndSave } = run({
        lineBreaks: new Set([3, 1, 6]), // out of order on purpose; 6 is far out of range
        words: ['a', 'b', 'c', 'd', 'e'],
        wordResults: [
          { word: 'a', typed: 'a', correct: true },
          { word: 'b', typed: 'b', correct: true },
          { word: 'c', typed: 'c', correct: true },
          { word: 'd', typed: 'd', correct: true },
          { word: 'e', typed: 'e', correct: true },
        ],
        currentWordIndex: 5,
        currentInput: '',
      }, null, FILE_IMPORT_CONFIG)
      // persistedWordCount = 5; bound is < 4 (5 - 1): 1 and 3 survive, 6 is dropped.
      expect(lineBreaksArg(finishAndSave)).toEqual([1, 3])
    })

    it('single-line fileImport run persists explicit [] — never undefined, never snapshot-derived', () => {
      // A tagged, otherwise-valid snapshot is present too, to prove the
      // real (empty) source wins outright rather than merely being
      // preferred when non-empty.
      const { finishAndSave } = run(
        { lineBreaks: new Set(), words: ['a', 'b'], wordResults: [{ word: 'a', typed: 'a', correct: true }, { word: 'b', typed: 'b', correct: true }] },
        { runId: 'run-1', wordCount: 2, lines: [[0], [1]] },
        FILE_IMPORT_CONFIG,
      )
      expect(lineBreaksArg(finishAndSave)).toEqual([])
    })

    it('a break at the terminal word (persistedWordCount - 1) is dropped', () => {
      const { finishAndSave } = run({
        lineBreaks: new Set([0, 2]),
        words: ['a', 'b', 'c'],
        wordResults: [
          { word: 'a', typed: 'a', correct: true },
          { word: 'b', typed: 'b', correct: true },
          { word: 'c', typed: 'c', correct: true },
        ],
        currentWordIndex: 3,
        currentInput: '',
      }, null, FILE_IMPORT_CONFIG)
      // persistedWordCount = 3; bound is < 2: 0 survives, 2 (the last
      // word, index persistedWordCount - 1) is dropped — nothing follows it.
      expect(lineBreaksArg(finishAndSave)).toEqual([0])
    })

    it('takes priority over a coincidentally present (and otherwise valid) snapshot', () => {
      const { finishAndSave } = run(
        {
          lineBreaks: new Set([2]),
          words: ['a', 'b', 'c', 'd'],
          wordResults: [
            { word: 'a', typed: 'a', correct: true },
            { word: 'b', typed: 'b', correct: true },
            { word: 'c', typed: 'c', correct: true },
            { word: 'd', typed: 'd', correct: true },
          ],
        },
        { runId: 'run-1', wordCount: 4, lines: [[0], [1], [2], [3]] },
        FILE_IMPORT_CONFIG,
      )
      expect(lineBreaksArg(finishAndSave)).toEqual([2])
    })

    it('tatoeba time pattern: an in-flight word bumps persistedWordCount by 1, and the new terminal is still dropped', () => {
      const { finishAndSave } = run({
        lineBreaks: new Set([0, 2, 3]),
        words: ['a', 'b', 'c', 'd'],
        wordResults: [
          { word: 'a', typed: 'a', correct: true },
          { word: 'b', typed: 'b', correct: true },
        ],
        currentWordIndex: 2,
        currentInput: 'c', // in-flight, interrupted word — persistedWordCount = 2 + 1 = 3
      }, null, TATOEBA_TIME_CONFIG)
      // Bound is < 2: only 0 survives; 2 (the new terminal, persistedWordCount - 1)
      // and 3 (beyond it) are both dropped.
      expect(lineBreaksArg(finishAndSave)).toEqual([0])
    })
  })

  describe('monkeytype sources (words/time/quote) — snapshot fallback, never state.lineBreaks', () => {
    it('a stray non-empty state.lineBreaks is ignored under a non-real-line config (mode decides, not Set size)', () => {
      const { finishAndSave } = run(
        { lineBreaks: new Set([1]), words: ['a', 'b'] },
        null,
        DEFAULT_CONFIG, // mode: 'words'
      )
      expect(lineBreaksArg(finishAndSave)).toBeUndefined()
    })

    it('a stray non-empty state.lineBreaks does not block the snapshot fallback either', () => {
      const { finishAndSave } = run(
        {
          lineBreaks: new Set([1]),
          words: ['a', 'b', 'c', 'd'],
          wordResults: [
            { word: 'a', typed: 'a', correct: true },
            { word: 'b', typed: 'b', correct: true },
            { word: 'c', typed: 'c', correct: true },
            { word: 'd', typed: 'd', correct: true },
          ],
        },
        { runId: 'run-1', wordCount: 4, lines: [[0], [1], [2], [3]] },
        DEFAULT_CONFIG,
      )
      // Snapshot-derived (rows 0-2's own last index), NOT [1] from state.lineBreaks.
      expect(lineBreaksArg(finishAndSave)).toEqual([0, 1, 2])
    })

    it('matching runId+wordCount derives line-end indices (last row excluded)', () => {
      const { finishAndSave } = run(
        { lineBreaks: new Set(), runId: 'run-1', words: ['a', 'b', 'c', 'd'] },
        { runId: 'run-1', wordCount: 4, lines: [[0, 1], [2, 3]] },
      )
      // Only the first row's last index (1) — the final row (3) is excluded.
      expect(lineBreaksArg(finishAndSave)).toEqual([1])
    })

    it('a snapshot row landing exactly on the persisted-word boundary is dropped (terminal rule applies here too)', () => {
      const { finishAndSave } = run(
        {
          lineBreaks: new Set(),
          runId: 'run-1',
          words: ['a', 'b', 'c', 'd', 'e', 'f'],
          wordResults: [
            { word: 'a', typed: 'a', correct: true },
            { word: 'b', typed: 'b', correct: true },
            { word: 'c', typed: 'c', correct: true },
          ],
          currentWordIndex: 3,
          currentInput: 'd', // in-flight — persistedWordCount = 3 + 1 = 4
        },
        // wordCount matches the full (unfinished) state.words — a time-bounded
        // run that generated more text than it finished typing.
        { runId: 'run-1', wordCount: 6, lines: [[0, 1], [2, 3], [4, 5]] },
      )
      // Row ends (excluding the snapshot's own final row) are [1, 3]; the
      // strict persisted-boundary bound (< persistedWordCount - 1 = 3)
      // then drops 3 too, leaving only 1.
      expect(lineBreaksArg(finishAndSave)).toEqual([1])
    })

    it('mismatched runId falls back to undefined', () => {
      const { finishAndSave } = run(
        { lineBreaks: new Set(), runId: 'run-1', words: ['a', 'b', 'c', 'd'] },
        { runId: 'run-OTHER', wordCount: 4, lines: [[0, 1], [2, 3]] },
      )
      expect(lineBreaksArg(finishAndSave)).toBeUndefined()
    })

    it('mismatched wordCount falls back to undefined', () => {
      const { finishAndSave } = run(
        { lineBreaks: new Set(), runId: 'run-1', words: ['a', 'b', 'c', 'd'] },
        { runId: 'run-1', wordCount: 3, lines: [[0, 1], [2]] },
      )
      expect(lineBreaksArg(finishAndSave)).toBeUndefined()
    })

    it('null lines (unmeasured) falls back to undefined', () => {
      const { finishAndSave } = run(
        { lineBreaks: new Set(), runId: 'run-1', words: ['a', 'b', 'c', 'd'] },
        { runId: 'run-1', wordCount: 4, lines: null },
      )
      expect(lineBreaksArg(finishAndSave)).toBeUndefined()
    })

    it('no source at all (no snapshot) yields undefined', () => {
      const { finishAndSave } = run({ lineBreaks: new Set(), runId: 'run-1', words: ['a', 'b', 'c', 'd'] }, null)
      expect(lineBreaksArg(finishAndSave)).toBeUndefined()
    })
  })
})

// Plan-completion-timeline-view PR-B: `lastFinishedLog` surfaces whatever
// `runLog.finishAndSave` returned for the just-finished run — a direct
// passthrough (not re-derived), so the completion screen can render the
// shared timeline panel from it inline. Cleared in the same
// `status !== 'finished'` branch that resets `savedResultRef`.
describe('useTypingTestResultSave — lastFinishedLog (completion timeline PR-B)', () => {
  const FAKE_LOG: RunKeystrokeLog = {
    runId: 'run-1', uid: 'kb-1', startedAt: new Date(1000).toISOString(), durationMs: 500,
    mode: 'words', language: 'english', words: [],
  }

  function renderWithFinishAndSave(status: TypingTestState['status'], finishAndSaveReturn: RunKeystrokeLog | null) {
    const finishAndSave = vi.fn().mockReturnValue(finishAndSaveReturn)
    const runLog: UseRunLogRecorderReturn = {
      record: vi.fn(), noteRegistration: vi.fn(), noteCharContext: vi.fn(), finishAndSave,
      currentRunHoldStats: vi.fn().mockReturnValue({ holdSumMs: 0, holdSamples: 0 }), discardRun: vi.fn(),
    }
    const buildOptions = (s: TypingTestState['status']): UseTypingTestResultSaveOptions => ({
      typingTest: makeTypingTest({ status: s }, DEFAULT_CONFIG),
      onSaveTypingTestResult: vi.fn(),
      saveUnnamed: true,
      savedMemoryRef: { current: undefined } as RefObject<undefined>,
      onMemoryChangeRef: { current: undefined } as RefObject<undefined>,
      keyboardRef: { current: { uid: 'kb-1', vendorId: 1, productId: 1, productName: 'x' } } as UseTypingTestResultSaveOptions['keyboardRef'],
      flushAfterPendingEmits: vi.fn(),
      runLog,
    })
    const rendered = renderHook(
      ({ s }: { s: TypingTestState['status'] }) => useTypingTestResultSave(buildOptions(s)),
      { initialProps: { s: status } },
    )
    return { ...rendered, finishAndSave }
  }

  it('exposes the log finishAndSave returned once the run finishes', () => {
    const { result } = renderWithFinishAndSave('finished', FAKE_LOG)
    expect(result.current.lastFinishedLog).toBe(FAKE_LOG)
  })

  it('is null when finishAndSave returned null (no consent / no uid / nothing saveable)', () => {
    const { result } = renderWithFinishAndSave('finished', null)
    expect(result.current.lastFinishedLog).toBeNull()
  })

  it('clears lastFinishedLog once status leaves finished (Next Test / Restart)', () => {
    const { result, rerender } = renderWithFinishAndSave('finished', FAKE_LOG)
    expect(result.current.lastFinishedLog).toBe(FAKE_LOG)

    rerender({ s: 'running' })
    expect(result.current.lastFinishedLog).toBeNull()
  })

  it('starts null before any run has ever finished', () => {
    const { result } = renderWithFinishAndSave('waiting', FAKE_LOG)
    expect(result.current.lastFinishedLog).toBeNull()
  })
})

// Average key-hold duration: `resetMatrixPressTracking` drains the matrix
// ordering queue, THEN `currentRunHoldStats` is snapshotted, THEN
// `finishAndSave` runs — in that exact order (see
// use-typing-test-result-save.ts's own ordering comment above the
// `drained`/`startedAtMs` consts) — so a keystroke the drain synchronously
// appends to the recorder's buffer still makes it onto the saved
// TypingTestResult, the same as it makes it into the saved run log.
describe('useTypingTestResultSave — average key-hold duration wiring', () => {
  function renderWithHoldStats(holdStats: { holdSumMs: number; holdSamples: number }) {
    const callOrder: string[] = []
    const resetMatrixPressTracking = vi.fn(() => {
      callOrder.push('resetMatrixPressTracking')
      return Promise.resolve()
    })
    const currentRunHoldStats = vi.fn((runId: string, startedAtMs: number) => {
      callOrder.push('currentRunHoldStats')
      expect(runId).toBe('run-1')
      // 1000 is `makeState`'s default `startTime` — the value
      // `useTypingTestResultSave` must forward verbatim as `startedAtMs`.
      expect(startedAtMs).toBe(1000)
      return holdStats
    })
    const finishAndSave = vi.fn(() => {
      callOrder.push('finishAndSave')
      return null
    })
    const onSaveTypingTestResult = vi.fn()
    const runLog: UseRunLogRecorderReturn = {
      record: vi.fn(), noteRegistration: vi.fn(), noteCharContext: vi.fn(),
      finishAndSave, currentRunHoldStats, discardRun: vi.fn(),
    }
    const typingTest = { ...makeTypingTest({}, DEFAULT_CONFIG), resetMatrixPressTracking }
    const options: UseTypingTestResultSaveOptions = {
      typingTest,
      onSaveTypingTestResult,
      saveUnnamed: true,
      savedMemoryRef: { current: undefined } as RefObject<undefined>,
      onMemoryChangeRef: { current: undefined } as RefObject<undefined>,
      keyboardRef: { current: { uid: 'kb-1', vendorId: 1, productId: 1, productName: 'x' } } as UseTypingTestResultSaveOptions['keyboardRef'],
      flushAfterPendingEmits: vi.fn(),
      runLog,
    }
    renderHook(() => useTypingTestResultSave(options))
    return { onSaveTypingTestResult, currentRunHoldStats, resetMatrixPressTracking, callOrder }
  }

  it('drains the matrix queue, THEN reads the recorder\'s current-run hold stats, THEN finishAndSave — and stores the pair on the saved result', () => {
    const { onSaveTypingTestResult, currentRunHoldStats, callOrder } = renderWithHoldStats({ holdSumMs: 240, holdSamples: 3 })
    expect(currentRunHoldStats).toHaveBeenCalledWith('run-1', 1000)
    expect(callOrder).toEqual(['resetMatrixPressTracking', 'currentRunHoldStats', 'finishAndSave'])
    expect(onSaveTypingTestResult).toHaveBeenCalledTimes(1)
    const saved = onSaveTypingTestResult.mock.calls[0][0]
    expect(saved.holdSumMs).toBe(240)
    expect(saved.holdSamples).toBe(3)
  })

  it('stores neither field when nothing was observed this run (zero samples)', () => {
    const { onSaveTypingTestResult } = renderWithHoldStats({ holdSumMs: 0, holdSamples: 0 })
    const saved = onSaveTypingTestResult.mock.calls[0][0]
    expect(saved.holdSumMs).toBeUndefined()
    expect(saved.holdSamples).toBeUndefined()
  })

  it('includes a hold sample the drain synchronously appends to the buffer — reading currentRunHoldStats before the drain would miss it', () => {
    // Simulates resetMatrixPressTracking's real synchronous side effect: a
    // queued tap-hold press settles and reaches runLog.record synchronously
    // (MatrixAnalyticsQueue.drainAll's for-loop calls emit(), and
    // emitAnalyticsEvent calls runLog.record as its very first statement,
    // before any IPC await — see use-typing-analytics-sink.ts), appending
    // a new sample to the recorder's buffer before resetMatrixPressTracking
    // returns. currentRunHoldStats must see the buffer AFTER that append.
    const callOrder: string[] = []
    let holdStatsAfterDrain = { holdSumMs: 0, holdSamples: 0 }
    const resetMatrixPressTracking = vi.fn(() => {
      callOrder.push('resetMatrixPressTracking')
      holdStatsAfterDrain = { holdSumMs: 90, holdSamples: 1 }
      return Promise.resolve()
    })
    const currentRunHoldStats = vi.fn((runId: string, startedAtMs: number) => {
      callOrder.push('currentRunHoldStats')
      expect(runId).toBe('run-1')
      expect(startedAtMs).toBe(1000)
      return holdStatsAfterDrain
    })
    const finishAndSave = vi.fn(() => null)
    const onSaveTypingTestResult = vi.fn()
    const runLog: UseRunLogRecorderReturn = {
      record: vi.fn(), noteRegistration: vi.fn(), noteCharContext: vi.fn(),
      finishAndSave, currentRunHoldStats, discardRun: vi.fn(),
    }
    const typingTest = { ...makeTypingTest({}, DEFAULT_CONFIG), resetMatrixPressTracking }
    const options: UseTypingTestResultSaveOptions = {
      typingTest,
      onSaveTypingTestResult,
      saveUnnamed: true,
      savedMemoryRef: { current: undefined } as RefObject<undefined>,
      onMemoryChangeRef: { current: undefined } as RefObject<undefined>,
      keyboardRef: { current: { uid: 'kb-1', vendorId: 1, productId: 1, productName: 'x' } } as UseTypingTestResultSaveOptions['keyboardRef'],
      flushAfterPendingEmits: vi.fn(),
      runLog,
    }
    renderHook(() => useTypingTestResultSave(options))

    expect(callOrder).toEqual(['resetMatrixPressTracking', 'currentRunHoldStats'])
    expect(onSaveTypingTestResult).toHaveBeenCalledTimes(1)
    const saved = onSaveTypingTestResult.mock.calls[0][0]
    expect(saved.holdSumMs).toBe(90)
    expect(saved.holdSamples).toBe(1)
  })
})
