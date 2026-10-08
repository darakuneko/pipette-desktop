// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// A sync merge of the shown keyboard's settings re-reads the pane's filters
// silently; an edit still waiting for (or in) its save keeps its values.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { PipetteSettings } from '../../../shared/types/pipette-settings'
import type { AnalyzeFilterSettings } from '../../../shared/types/analyze-filters'
import { useAnalyzeFilters } from '../useAnalyzeFilters'
import { dispatchSyncUnitApplied } from '../use-sync-unit-applied'

const getSpy = vi.fn<(uid: string) => Promise<PipetteSettings | null>>()
const patchSpy = vi.fn<(uid: string, partial: Partial<PipetteSettings>) => Promise<{ success: true }>>()

function settings(filters: AnalyzeFilterSettings, compareFilters?: AnalyzeFilterSettings): PipetteSettings {
  return { _rev: 1, keyboardLayout: 'qwerty', autoAdvance: true, layerNames: [], analyze: { filters, compareFilters } }
}

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
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
})

async function flushMicrotasks(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

describe('useAnalyzeFilters sync reload', () => {
  it('re-reads its own field for the shown keyboard without touching ready', async () => {
    getSpy.mockResolvedValueOnce(settings({ wpm: { viewMode: 'timeSeries' } }))
    const { result } = renderHook(() => useAnalyzeFilters('selected', 'B'))
    await waitFor(() => expect(result.current.ready).toBe(true))

    act(() => { dispatchSyncUnitApplied('keyboards/connected/settings') })
    expect(getSpy).toHaveBeenCalledTimes(1)

    const readyStates: boolean[] = []
    getSpy.mockImplementationOnce(async () => {
      readyStates.push(result.current.ready)
      return settings({ wpm: { viewMode: 'timeSeries' } }, { wpm: { viewMode: 'timeOfDay' } })
    })
    act(() => { dispatchSyncUnitApplied('keyboards/selected/settings') })
    await waitFor(() => expect(result.current.filters.wpm.viewMode).toBe('timeOfDay'))
    expect(getSpy).toHaveBeenLastCalledWith('selected')
    expect(readyStates).toEqual([true])
    expect(result.current.ready).toBe(true)
    // The reload is not saved back.
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(patchSpy).not.toHaveBeenCalled()
  })

  it('keeps the filters identity when the reload changed nothing', async () => {
    getSpy.mockResolvedValue(settings({ layer: { baseLayer: 2 } }))
    const { result } = renderHook(() => useAnalyzeFilters('kb'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    const before = result.current.filters

    act(() => { dispatchSyncUnitApplied('keyboards/kb/settings') })
    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(2))
    await flushMicrotasks()
    expect(result.current.filters).toBe(before)
  })

  it('reads a merge that lands during the debounce after the save, keeping the edit', async () => {
    getSpy.mockResolvedValueOnce(settings({ layer: { baseLayer: 0 } }))
    const { result } = renderHook(() => useAnalyzeFilters('kb'))
    await waitFor(() => expect(result.current.ready).toBe(true))

    act(() => { result.current.setLayer({ baseLayer: 3 }) })
    act(() => { dispatchSyncUnitApplied('keyboards/kb/settings') })
    await flushMicrotasks()
    expect(getSpy).toHaveBeenCalledTimes(1)
    expect(result.current.filters.layer.baseLayer).toBe(3)

    // The file after the save: this edit plus the other device's change
    // that the merge brought in.
    getSpy.mockResolvedValueOnce(settings({ layer: { baseLayer: 3 }, wpm: { viewMode: 'timeOfDay' } }))
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy.mock.calls[0][1].analyze?.filters?.layer?.baseLayer).toBe(3)
    await waitFor(() => expect(result.current.filters.wpm.viewMode).toBe('timeOfDay'))
    expect(getSpy).toHaveBeenCalledTimes(2)
    expect(result.current.filters.layer.baseLayer).toBe(3)
  })

  it('drops a reload an edit overlapped', async () => {
    getSpy.mockResolvedValueOnce(settings({ layer: { baseLayer: 0 } }))
    const { result } = renderHook(() => useAnalyzeFilters('kb'))
    await waitFor(() => expect(result.current.ready).toBe(true))

    let resolveStale!: (prefs: PipetteSettings) => void
    getSpy.mockReturnValueOnce(new Promise((res) => { resolveStale = res }))
    act(() => { dispatchSyncUnitApplied('keyboards/kb/settings') })
    act(() => { result.current.setLayer({ baseLayer: 4 }) })
    // The save fires while the reload is still pending.
    getSpy.mockResolvedValueOnce(settings({ layer: { baseLayer: 4 } }))
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(patchSpy).toHaveBeenCalledTimes(1)
    await act(async () => { resolveStale(settings({ layer: { baseLayer: 1 } })) })
    await flushMicrotasks()
    expect(result.current.filters.layer.baseLayer).toBe(4)
  })

  it('lets a merge during the keyboard\'s load replace that load', async () => {
    let resolveLoad!: (prefs: PipetteSettings) => void
    getSpy.mockReturnValueOnce(new Promise((res) => { resolveLoad = res }))
    getSpy.mockResolvedValueOnce(settings({ wpm: { viewMode: 'timeOfDay' } }))
    const { result } = renderHook(() => useAnalyzeFilters('kb'))
    expect(result.current.ready).toBe(false)
    act(() => { dispatchSyncUnitApplied('keyboards/kb/settings') })
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.filters.wpm.viewMode).toBe('timeOfDay')

    await act(async () => { resolveLoad(settings({ wpm: { viewMode: 'timeSeries' } })) })
    expect(result.current.filters.wpm.viewMode).toBe('timeOfDay')
    expect(getSpy).toHaveBeenCalledTimes(2)
  })

  it('does not save a staged patch when the keyboard goes away before its load', async () => {
    getSpy.mockResolvedValueOnce(settings({}))
    const { result, rerender } = renderHook(({ uid }: { uid: string | null }) => useAnalyzeFilters(uid), {
      initialProps: { uid: 'a' as string | null },
    })
    await waitFor(() => expect(result.current.ready).toBe(true))

    let resolveX!: (prefs: PipetteSettings) => void
    getSpy.mockReturnValueOnce(new Promise((res) => { resolveX = res }))
    act(() => { result.current.applyBatchForUid('x', { deviceScopes: ['all'] }) })
    rerender({ uid: 'x' })
    rerender({ uid: null })
    await act(async () => { vi.advanceTimersByTime(400) })
    await act(async () => { resolveX(settings({ layer: { baseLayer: 2 } })) })
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(patchSpy).not.toHaveBeenCalled()
    expect(result.current.filters.deviceScopes).toEqual(['own'])
  })
})
