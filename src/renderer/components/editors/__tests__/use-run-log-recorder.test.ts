// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// Focused unit coverage for `finishAndSave`'s return value
// (Plan-completion-timeline-view PR-B): it now returns the same
// `RunKeystrokeLog | null` that `RunLogRecorder.finish()` produced (and
// still hands to `typingRunLogSave`), so `useTypingTestResultSave` can
// surface it as `lastFinishedLog` for the completion screen's inline
// timeline panel — no IPC round-trip needed. The underlying join/finish
// logic itself is already exhaustively covered by
// `typing-test/__tests__/run-log-recorder.test.ts`; this file only
// exercises the hook's own new passthrough.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useRunLogRecorder } from '../use-run-log-recorder'
import { deserialize } from '../../../../shared/keycodes/keycodes'
import type { WordResult } from '../../../typing-test/run-state'

const KC_A = deserialize('KC_A')
const mockTypingRunLogSave = vi.fn<(uid: string, log: unknown) => Promise<{ success: boolean }>>()

beforeEach(() => {
  mockTypingRunLogSave.mockReset().mockResolvedValue({ success: true })
  window.vialAPI = {
    ...window.vialAPI,
    typingRunLogSave: mockTypingRunLogSave,
  } as typeof window.vialAPI
})

function renderRecorder(recordingConsentAccepted = true) {
  const typingTestLabelRef = { current: 'words (english)' as string | null }
  const { result } = renderHook(() => useRunLogRecorder({ recordingConsentAccepted, typingTestLabelRef }))
  return { result, typingTestLabelRef }
}

/** Drives one char-producing keystroke (registration + matrix + char)
 *  through the hook's own call shapes — mirrors how useTypingTest wires
 *  these three seams in useInputModes.ts. */
function driveOneKeystroke(result: ReturnType<typeof renderRecorder>['result'], runId: string, wordIndex: number): void {
  result.current.noteRegistration(runId, 0, 0, 1000, wordIndex, () => 'a', () => undefined, true)
  result.current.record({ typingTestLabel: 'words (english)', runId, windowFocused: true }, {
    kind: 'matrix', row: 0, col: 0, layer: 0, keycode: KC_A, ts: 1000,
  })
  result.current.record({ typingTestLabel: 'words (english)', runId, windowFocused: true }, {
    kind: 'char', key: 'a', ts: 1005,
  })
}

const wordResults: WordResult[] = [{ word: 'a', typed: 'a', correct: true }]

describe('useRunLogRecorder — finishAndSave return value', () => {
  it('returns null (and never saves) when there is no active keyboard uid', () => {
    const { result } = renderRecorder(true)
    driveOneKeystroke(result, 'run-1', 0)

    const log = result.current.finishAndSave(undefined, wordResults, {
      runId: 'run-1', startedAtMs: 1000, durationMs: 500, mode: 'words', language: 'english',
      charCorrelationUnavailable: false, romajiInput: false,
    })

    expect(log).toBeNull()
    expect(mockTypingRunLogSave).not.toHaveBeenCalled()
  })

  it('returns the finished log — the same object handed to typingRunLogSave — when a real run was recorded', () => {
    const { result } = renderRecorder(true)
    driveOneKeystroke(result, 'run-1', 0)

    const log = result.current.finishAndSave('kb-1', wordResults, {
      runId: 'run-1', startedAtMs: 1000, durationMs: 500, mode: 'words', language: 'english',
      charCorrelationUnavailable: false, romajiInput: false,
    })

    expect(log).not.toBeNull()
    expect(log?.runId).toBe('run-1')
    expect(log?.uid).toBe('kb-1')
    expect(mockTypingRunLogSave).toHaveBeenCalledTimes(1)
    expect(mockTypingRunLogSave).toHaveBeenCalledWith('kb-1', log)
  })

  it('returns null (and never saves) when nothing was ever buffered (e.g. consent was off throughout)', () => {
    const { result } = renderRecorder(false)
    // No noteRegistration/record calls succeed while consent is off — see
    // the module's own gate — so the buffer stays empty.

    const log = result.current.finishAndSave('kb-1', [], {
      runId: 'run-1', startedAtMs: 1000, durationMs: 500, mode: 'words', language: 'english',
      charCorrelationUnavailable: false, romajiInput: false,
    })

    expect(log).toBeNull()
    expect(mockTypingRunLogSave).not.toHaveBeenCalled()
  })

  it('returns null when meta.runId does not match the buffered run (stale buffer)', () => {
    const { result } = renderRecorder(true)
    driveOneKeystroke(result, 'run-1', 0)

    const log = result.current.finishAndSave('kb-1', wordResults, {
      runId: 'run-OTHER', startedAtMs: 1000, durationMs: 500, mode: 'words', language: 'english',
      charCorrelationUnavailable: false, romajiInput: false,
    })

    expect(log).toBeNull()
    expect(mockTypingRunLogSave).not.toHaveBeenCalled()
  })
})
