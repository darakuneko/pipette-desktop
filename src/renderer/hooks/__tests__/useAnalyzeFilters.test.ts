// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Covers the debounce / flush contract of `useAnalyzeFilters` so the
// TypingAnalyticsView doesn't have to assert persistence via the
// chart mocks. Fake timers drive the 300 ms debounce so the tests
// stay fast and deterministic.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { PipetteSettings } from '../../../shared/types/pipette-settings'
import { useAnalyzeFilters, DEFAULT_ANALYZE_FILTERS } from '../useAnalyzeFilters'

interface MockPipetteAPI {
  pipetteSettingsGet: (uid: string) => Promise<PipetteSettings | null>
  pipetteSettingsSet: (uid: string, prefs: PipetteSettings) => Promise<{ success: true } | { success: false; error: string }>
}

const getSpy = vi.fn<MockPipetteAPI['pipetteSettingsGet']>()
const setSpy = vi.fn<MockPipetteAPI['pipetteSettingsSet']>()

Object.defineProperty(window, 'vialAPI', {
  value: {
    pipetteSettingsGet: (uid: string) => getSpy(uid),
    pipetteSettingsSet: (uid: string, prefs: PipetteSettings) => setSpy(uid, prefs),
  },
  writable: true,
})

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useAnalyzeFilters', () => {
  beforeEach(() => {
    getSpy.mockReset().mockResolvedValue(null)
    setSpy.mockReset().mockResolvedValue({ success: true as const })
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts ready when uid is null and never hits IPC', () => {
    const { result } = renderHook(() => useAnalyzeFilters(null))
    expect(result.current.ready).toBe(true)
    expect(result.current.filters).toEqual(DEFAULT_ANALYZE_FILTERS)
    expect(getSpy).not.toHaveBeenCalled()
  })

  it('loads persisted filters on mount and flips ready once resolved', async () => {
    getSpy.mockResolvedValueOnce({
      _rev: 1,
      keyboardLayout: 'qwerty',
      autoAdvance: true,
      layerNames: [],
      analyze: {
        filters: {
          deviceScope: 'all',
          wpm: { viewMode: 'timeOfDay' },
          layer: { baseLayer: 2 },
        },
      },
    })
    const { result } = renderHook(() => useAnalyzeFilters('uid-a'))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.filters.deviceScope).toBe('all')
    expect(result.current.filters.wpm.viewMode).toBe('timeOfDay')
    expect(result.current.filters.layer.baseLayer).toBe(2)
    // Un-specified slots keep their defaults rather than crashing
    // consumers that destructure fields like `heatmap.frequentUsedN`.
    expect(result.current.filters.heatmap.frequentUsedN).toBe(10)
  })

  it('debounces writes and only flushes once after 300 ms of quiet', async () => {
    const { result } = renderHook(() => useAnalyzeFilters('uid-a'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    setSpy.mockClear()
    getSpy.mockClear().mockResolvedValue(null)

    act(() => {
      result.current.setDeviceScope('all')
      result.current.setWpm({ viewMode: 'timeOfDay' })
      result.current.setLayer({ baseLayer: 3 })
    })

    // 299 ms: nothing should have flushed yet.
    act(() => { vi.advanceTimersByTime(299) })
    await flushMicrotasks()
    expect(setSpy).not.toHaveBeenCalled()

    act(() => { vi.advanceTimersByTime(1) })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(setSpy).toHaveBeenCalledTimes(1)
    const [uid, prefs] = setSpy.mock.calls[0]
    expect(uid).toBe('uid-a')
    expect(prefs.analyze?.filters?.deviceScope).toBe('all')
    expect(prefs.analyze?.filters?.wpm?.viewMode).toBe('timeOfDay')
    expect(prefs.analyze?.filters?.layer?.baseLayer).toBe(3)
  })

  it('flushes pending writes synchronously when the uid switches, targeting the previous keyboard', async () => {
    const { result, rerender } = renderHook(
      ({ uid }: { uid: string | null }) => useAnalyzeFilters(uid),
      { initialProps: { uid: 'uid-a' as string | null } },
    )
    await waitFor(() => expect(result.current.ready).toBe(true))
    setSpy.mockClear()
    getSpy.mockClear().mockResolvedValue(null)

    act(() => { result.current.setDeviceScope('all') })
    // Still inside the debounce window.
    rerender({ uid: 'uid-b' })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(setSpy).toHaveBeenCalledTimes(1)
    expect(setSpy.mock.calls[0][0]).toBe('uid-a')
    expect(setSpy.mock.calls[0][1].analyze?.filters?.deviceScope).toBe('all')
  })

  it('flushes pending writes on unmount', async () => {
    const { result, unmount } = renderHook(() => useAnalyzeFilters('uid-a'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    setSpy.mockClear()
    getSpy.mockClear().mockResolvedValue(null)

    act(() => { result.current.setHeatmap({ frequentUsedN: 50 }) })
    unmount()
    await flushMicrotasks()
    await flushMicrotasks()

    expect(setSpy).toHaveBeenCalledTimes(1)
    expect(setSpy.mock.calls[0][1].analyze?.filters?.heatmap?.frequentUsedN).toBe(50)
  })

  it('ignores setter calls when uid is null', async () => {
    const { result } = renderHook(() => useAnalyzeFilters(null))
    act(() => { result.current.setDeviceScope('all') })
    act(() => { vi.advanceTimersByTime(1000) })
    await flushMicrotasks()
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('bootstraps a minimal PipetteSettings when pipetteSettingsGet returns null', async () => {
    getSpy.mockResolvedValue(null)
    const { result } = renderHook(() => useAnalyzeFilters('uid-new'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    setSpy.mockClear()

    act(() => { result.current.setDeviceScope('all') })
    act(() => { vi.advanceTimersByTime(300) })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(setSpy).toHaveBeenCalledTimes(1)
    const prefs = setSpy.mock.calls[0][1]
    // Must still be a valid PipetteSettings — missing `_rev` or
    // `keyboardLayout` would trip the main-process validator.
    expect(prefs._rev).toBe(1)
    expect(prefs.keyboardLayout).toBe('qwerty')
    expect(prefs.autoAdvance).toBe(true)
    expect(prefs.analyze?.filters?.deviceScope).toBe('all')
  })
})
