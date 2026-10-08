// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// The Analyze pane follows the keyboard it shows (`selectedUid`), which can
// differ from the connected one, when a sync merge rewrote its settings.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { PipetteSettings, TypingTestResult } from '../../../../shared/types/pipette-settings'
import { useAnalyzePanePrefs } from '../use-analyze-pane-prefs'
import { dispatchSyncUnitApplied } from '../../../hooks/use-sync-unit-applied'

const RESULT: TypingTestResult = {
  date: '2026-01-01T00:00:00.000Z', wpm: 80, accuracy: 99, wordCount: 50,
  correctChars: 400, incorrectChars: 4, durationSeconds: 60,
}

function settings(analyze: PipetteSettings['analyze'], typingTestResults: TypingTestResult[] = []): PipetteSettings {
  return { _rev: 1, keyboardLayout: 'qwerty', autoAdvance: true, layerNames: [], analyze, typingTestResults }
}

const getSpy = vi.fn<(uid: string) => Promise<PipetteSettings | null>>()
const patchSpy = vi.fn<(uid: string, partial: Partial<PipetteSettings>) => Promise<{ success: true }>>()

beforeEach(() => {
  getSpy.mockReset()
  patchSpy.mockReset().mockResolvedValue({ success: true })
  Object.defineProperty(window, 'vialAPI', {
    value: {
      pipetteSettingsGet: (uid: string) => getSpy(uid),
      pipetteSettingsPatch: (uid: string, partial: Partial<PipetteSettings>) => patchSpy(uid, partial),
    },
    writable: true,
    configurable: true,
  })
})

describe('useAnalyzePanePrefs sync reload', () => {
  it('re-reads the selected keyboard silently and ignores the connected one', async () => {
    getSpy.mockResolvedValueOnce(settings({ fingerAssignments: { '0,0': 'left-pinky' }, showBenchmark: true }))
    const { result } = renderHook(() => useAnalyzePanePrefs('selected'))
    await waitFor(() => expect(result.current.fingersLoading).toBe(false))
    expect(result.current.fingerAssignments).toEqual({ '0,0': 'left-pinky' })

    act(() => { dispatchSyncUnitApplied('keyboards/connected/settings') })
    expect(getSpy).toHaveBeenCalledTimes(1)

    const loadingStates: boolean[] = []
    getSpy.mockImplementationOnce(async () => {
      loadingStates.push(result.current.fingersLoading)
      return settings({ fingerAssignments: { '0,0': 'right-index' }, showBenchmark: false }, [RESULT])
    })
    act(() => { dispatchSyncUnitApplied('keyboards/selected/settings') })
    await waitFor(() => expect(result.current.showBenchmark).toBe(false))
    expect(getSpy).toHaveBeenLastCalledWith('selected')
    expect(result.current.fingerAssignments).toEqual({ '0,0': 'right-index' })
    expect(result.current.typingTestResults).toHaveLength(1)
    expect(loadingStates).toEqual([false])
    expect(result.current.fingersLoading).toBe(false)
  })

  it('keeps a just-saved toggle when a reload started before the save', async () => {
    getSpy.mockResolvedValueOnce(settings({ showBenchmark: true }))
    const { result } = renderHook(() => useAnalyzePanePrefs('kb'))
    await waitFor(() => expect(result.current.fingersLoading).toBe(false))

    let resolveStale!: (prefs: PipetteSettings) => void
    getSpy.mockReturnValueOnce(new Promise((res) => { resolveStale = res }))
    act(() => { dispatchSyncUnitApplied('keyboards/kb/settings') })
    getSpy.mockResolvedValueOnce(settings({ showBenchmark: false }))
    await act(async () => { await result.current.handleShowBenchmarkChange(false) })
    await act(async () => { resolveStale(settings({ showBenchmark: true })) })
    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(3))
    expect(result.current.showBenchmark).toBe(false)
  })

  it('keeps the result identity when a reload changed none of its fields', async () => {
    getSpy.mockResolvedValue(settings({ fingerAssignments: { '0,0': 'left-pinky' } }, [RESULT]))
    const { result } = renderHook(() => useAnalyzePanePrefs('kb'))
    await waitFor(() => expect(result.current.typingTestResults).toHaveLength(1))
    const { fingerAssignments, typingTestResults } = result.current

    act(() => { dispatchSyncUnitApplied('keyboards/kb/settings') })
    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(2))
    await act(async () => { await Promise.resolve() })
    expect(result.current.fingerAssignments).toBe(fingerAssignments)
    expect(result.current.typingTestResults).toBe(typingTestResults)
  })
})
