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
          deviceScopes: ['all'],
          wpm: { viewMode: 'timeOfDay' },
          layer: { baseLayer: 2 },
        },
      },
    })
    const { result } = renderHook(() => useAnalyzeFilters('uid-a'))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.filters.deviceScopes).toEqual(['all'])
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
      result.current.setDeviceScopes(['all'])
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
    expect(prefs.analyze?.filters?.deviceScopes).toEqual(['all'])
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

    act(() => { result.current.setDeviceScopes(['all']) })
    // Still inside the debounce window.
    rerender({ uid: 'uid-b' })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(setSpy).toHaveBeenCalledTimes(1)
    expect(setSpy.mock.calls[0][0]).toBe('uid-a')
    expect(setSpy.mock.calls[0][1].analyze?.filters?.deviceScopes).toEqual(['all'])
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
    act(() => { result.current.setDeviceScopes(['all']) })
    act(() => { vi.advanceTimersByTime(1000) })
    await flushMicrotasks()
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('round-trips a hash deviceScope through load → setter → flush', async () => {
    getSpy.mockResolvedValueOnce({
      _rev: 1,
      keyboardLayout: 'qwerty',
      autoAdvance: true,
      layerNames: [],
      analyze: {
        filters: {
          deviceScopes: [{ kind: 'hash', machineHash: 'abcd1234' }],
        },
      },
    })
    const { result } = renderHook(() => useAnalyzeFilters('uid-h'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.filters.deviceScopes).toEqual([
      { kind: 'hash', machineHash: 'abcd1234' },
    ])

    setSpy.mockClear()
    getSpy.mockClear().mockResolvedValue(null)
    act(() => {
      result.current.setDeviceScopes([{ kind: 'hash', machineHash: 'ffff0000' }])
    })
    act(() => { vi.advanceTimersByTime(300) })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(setSpy).toHaveBeenCalledTimes(1)
    expect(setSpy.mock.calls[0][1].analyze?.filters?.deviceScopes).toEqual([
      { kind: 'hash', machineHash: 'ffff0000' },
    ])
  })

  it('normalizes setter input by collapsing all+hash to all and capping at MAX_DEVICE_SCOPES', async () => {
    const { result } = renderHook(() => useAnalyzeFilters('uid-norm'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    setSpy.mockClear()

    act(() => {
      result.current.setDeviceScopes([
        'own',
        'all',
        { kind: 'hash', machineHash: 'abc' },
      ])
    })
    // 'all' is exclusive, so the normalizer collapses the array to ['all'].
    expect(result.current.filters.deviceScopes).toEqual(['all'])

    act(() => {
      result.current.setDeviceScopes([
        'own',
        { kind: 'hash', machineHash: 'a' },
        { kind: 'hash', machineHash: 'b' },
      ])
    })
    // Cap at MAX_DEVICE_SCOPES = 1 — only the first entry survives.
    expect(result.current.filters.deviceScopes).toEqual(['own'])

    act(() => { result.current.setDeviceScopes([]) })
    // Empty input falls back to ['own'] so the filter is never blank.
    expect(result.current.filters.deviceScopes).toEqual(['own'])
  })

  it('bootstraps a minimal PipetteSettings when pipetteSettingsGet returns null', async () => {
    getSpy.mockResolvedValue(null)
    const { result } = renderHook(() => useAnalyzeFilters('uid-new'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    setSpy.mockClear()

    act(() => { result.current.setDeviceScopes(['all']) })
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
    expect(prefs.analyze?.filters?.deviceScopes).toEqual(['all'])
  })

  it('persists pairIntervalThresholdMs through setBigrams', async () => {
    const { result } = renderHook(() => useAnalyzeFilters('uid-a'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    setSpy.mockClear()
    getSpy.mockClear().mockResolvedValue(null)

    act(() => { result.current.setBigrams({ pairIntervalThresholdMs: 200 }) })
    act(() => { vi.advanceTimersByTime(300) })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(setSpy).toHaveBeenCalledTimes(1)
    expect(setSpy.mock.calls[0][1].analyze?.filters?.bigrams?.pairIntervalThresholdMs).toBe(200)
    // Sibling defaults must survive the partial patch — otherwise the
    // first user that flips the threshold loses topLimit/slowLimit.
    expect(result.current.filters.bigrams.topLimit).toBe(DEFAULT_ANALYZE_FILTERS.bigrams.topLimit)
    expect(result.current.filters.bigrams.fingerLimit).toBe(DEFAULT_ANALYZE_FILTERS.bigrams.fingerLimit)
  })

  it('defaults filterDimension to app', async () => {
    const { result } = renderHook(() => useAnalyzeFilters('uid-a'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.filters.filterDimension).toBe('app')
  })

  it('zeroes the inactive dimension in effective filters but keeps raw selections', async () => {
    const { result } = renderHook(() => useAnalyzeFilters('uid-a'))
    await waitFor(() => expect(result.current.ready).toBe(true))

    act(() => {
      result.current.setAppScopes(['vscode'])
      result.current.setTypingTestScopes(['words (english)'])
    })

    // Default dimension 'app' → typingTest zeroed in effective, app kept.
    expect(result.current.filters.appScopes).toEqual(['vscode'])
    expect(result.current.filters.typingTestScopes).toEqual([])
    // Raw keeps both regardless of which dimension is active.
    expect(result.current.rawAppScopes).toEqual(['vscode'])
    expect(result.current.rawTypingTestScopes).toEqual(['words (english)'])

    act(() => { result.current.setFilterDimension('typingTest') })

    // Switching flips which dimension is zeroed; raw is untouched.
    expect(result.current.filters.appScopes).toEqual([])
    expect(result.current.filters.typingTestScopes).toEqual(['words (english)'])
    expect(result.current.rawAppScopes).toEqual(['vscode'])
    expect(result.current.rawTypingTestScopes).toEqual(['words (english)'])
  })

  it('applies runIdScopes only while the typingTest dimension is active', async () => {
    const { result } = renderHook(() => useAnalyzeFilters('uid-a'))
    await waitFor(() => expect(result.current.ready).toBe(true))

    act(() => {
      result.current.setTypingTestScopes(['words (english)'])
      result.current.setRunIdScopes(['run-1', 'run-2'])
    })

    // Default dimension 'app' → typingTest sub-filter (runId) is zeroed.
    expect(result.current.filters.runIdScopes).toEqual([])
    expect(result.current.rawRunIdScopes).toEqual(['run-1', 'run-2'])

    act(() => { result.current.setFilterDimension('typingTest') })
    // Now the typingTest dimension is active, so runId applies.
    expect(result.current.filters.runIdScopes).toEqual(['run-1', 'run-2'])
    expect(result.current.filters.typingTestScopes).toEqual(['words (english)'])
  })

  it('persists runIdScopes through setRunIdScopes', async () => {
    const { result } = renderHook(() => useAnalyzeFilters('uid-a'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    setSpy.mockClear()
    getSpy.mockClear().mockResolvedValue(null)

    act(() => { result.current.setRunIdScopes(['run-1']) })
    act(() => { vi.advanceTimersByTime(300) })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(setSpy).toHaveBeenCalledTimes(1)
    expect(setSpy.mock.calls[0][1].analyze?.filters?.runIdScopes).toEqual(['run-1'])
  })

  it('forces the app dimension off on the byApp tab (across-apps view)', async () => {
    const { result } = renderHook(() => useAnalyzeFilters('uid-a', 'A', 'byApp'))
    await waitFor(() => expect(result.current.ready).toBe(true))

    act(() => {
      result.current.setAppScopes(['vscode'])
      result.current.setTypingTestScopes(['quote (english)'])
    })

    // byApp respects the toggle, but the app dimension can't filter there
    // (it groups across apps), so appScopes is always zeroed. On the app
    // dimension nothing is applied; raw still carries the selection.
    act(() => { result.current.setFilterDimension('app') })
    expect(result.current.filters.appScopes).toEqual([])
    expect(result.current.filters.typingTestScopes).toEqual([])
    expect(result.current.rawAppScopes).toEqual(['vscode'])

    // Toggling to typingTest on byApp DOES apply the test filter.
    act(() => { result.current.setFilterDimension('typingTest') })
    expect(result.current.filters.appScopes).toEqual([])
    expect(result.current.filters.typingTestScopes).toEqual(['quote (english)'])
  })

  it('persists filterDimension through setFilterDimension', async () => {
    const { result } = renderHook(() => useAnalyzeFilters('uid-a'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    setSpy.mockClear()
    getSpy.mockClear().mockResolvedValue(null)

    act(() => { result.current.setFilterDimension('typingTest') })
    act(() => { vi.advanceTimersByTime(300) })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(setSpy).toHaveBeenCalledTimes(1)
    expect(setSpy.mock.calls[0][1].analyze?.filters?.filterDimension).toBe('typingTest')
  })

  it('restores a persisted filterDimension on mount', async () => {
    getSpy.mockResolvedValueOnce({
      _rev: 1,
      keyboardLayout: 'qwerty',
      autoAdvance: true,
      layerNames: [],
      analyze: {
        filters: {
          appScopes: ['vscode'],
          typingTestScopes: ['words (english)'],
          filterDimension: 'typingTest',
        },
      },
    })
    const { result } = renderHook(() => useAnalyzeFilters('uid-a'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.filters.filterDimension).toBe('typingTest')
    // Effective reflects the restored dimension immediately.
    expect(result.current.filters.appScopes).toEqual([])
    expect(result.current.filters.typingTestScopes).toEqual(['words (english)'])
  })

  it('restores a persisted pairIntervalThresholdMs on mount', async () => {
    getSpy.mockResolvedValueOnce({
      _rev: 1,
      keyboardLayout: 'qwerty',
      autoAdvance: true,
      layerNames: [],
      analyze: {
        filters: {
          bigrams: { pairIntervalThresholdMs: 175 },
        },
      },
    })
    const { result } = renderHook(() => useAnalyzeFilters('uid-a'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.filters.bigrams.pairIntervalThresholdMs).toBe(175)
    // Defaults still apply to fields the persisted shape didn't include.
    expect(result.current.filters.bigrams.topLimit).toBe(DEFAULT_ANALYZE_FILTERS.bigrams.topLimit)
  })
})
