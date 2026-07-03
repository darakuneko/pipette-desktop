// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Covers the fetch/cancel/loading-flag contract extracted from
// AnalyzePane into `useAnalyzeScopeOptions` — device infos + snapshot
// summaries for a single uid, including the "reset synchronously on uid
// change" and "loaded stays false on error" semantics AnalyzePane's
// downstream fallback/overlay logic depends on.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type {
  TypingAnalyticsDeviceInfoBundle,
  TypingKeymapSnapshotSummary,
} from '../../../shared/types/typing-analytics'
import { useAnalyzeScopeOptions } from '../useAnalyzeScopeOptions'

const listDeviceInfosSpy = vi.fn<(uid: string) => Promise<TypingAnalyticsDeviceInfoBundle | null>>()
const listSnapshotsSpy = vi.fn<(uid: string) => Promise<TypingKeymapSnapshotSummary[]>>()

Object.defineProperty(window, 'vialAPI', {
  value: {
    typingAnalyticsListDeviceInfos: (uid: string) => listDeviceInfosSpy(uid),
    typingAnalyticsListKeymapSnapshots: (uid: string) => listSnapshotsSpy(uid),
  },
  writable: true,
})

const BUNDLE: TypingAnalyticsDeviceInfoBundle = {
  own: { machineHash: 'ownhash00000000', osPlatform: 'linux', osRelease: '6.8' },
  remotes: [{ machineHash: 'remotehash1234', osPlatform: 'darwin', osRelease: '23.6' }],
}

const SUMMARIES: TypingKeymapSnapshotSummary[] = [
  { uid: 'uid-a', machineHash: 'm1', productName: 'KB A', savedAt: 1000, layers: 1, matrix: { rows: 1, cols: 1 } },
]

describe('useAnalyzeScopeOptions', () => {
  beforeEach(() => {
    listDeviceInfosSpy.mockReset().mockResolvedValue(BUNDLE)
    listSnapshotsSpy.mockReset().mockResolvedValue(SUMMARIES)
  })

  it('starts empty and unloaded when uid is null, without hitting IPC', () => {
    const { result } = renderHook(() => useAnalyzeScopeOptions(null))
    expect(result.current.deviceInfos).toEqual({ own: null, remotes: [], loaded: false, error: false })
    expect(result.current.snapshotSummaries).toEqual([])
    expect(result.current.summariesLoading).toBe(false)
    expect(listDeviceInfosSpy).not.toHaveBeenCalled()
    expect(listSnapshotsSpy).not.toHaveBeenCalled()
  })

  it('loads device infos and snapshot summaries for a uid', async () => {
    const { result } = renderHook(() => useAnalyzeScopeOptions('uid-a'))
    await waitFor(() => expect(result.current.deviceInfos.loaded).toBe(true))
    expect(result.current.deviceInfos.own).toEqual(BUNDLE.own)
    expect(result.current.deviceInfos.remotes).toEqual(BUNDLE.remotes)
    expect(result.current.deviceInfos.error).toBe(false)
    await waitFor(() => expect(result.current.summariesLoading).toBe(false))
    expect(result.current.snapshotSummaries).toEqual(SUMMARIES)
  })

  it('keeps loaded false and flips error true when the device-infos fetch rejects', async () => {
    listDeviceInfosSpy.mockRejectedValue(new Error('drive down'))
    const { result } = renderHook(() => useAnalyzeScopeOptions('uid-a'))
    await waitFor(() => expect(result.current.deviceInfos.error).toBe(true))
    expect(result.current.deviceInfos.loaded).toBe(false)
  })

  it('resets to empty on error and keeps summariesLoading consistent when the snapshot fetch rejects', async () => {
    listSnapshotsSpy.mockRejectedValue(new Error('drive down'))
    const { result } = renderHook(() => useAnalyzeScopeOptions('uid-a'))
    await waitFor(() => expect(result.current.summariesLoading).toBe(false))
    expect(result.current.snapshotSummaries).toEqual([])
  })

  it('resets synchronously to the empty/loading shape when the uid switches', async () => {
    const { result, rerender } = renderHook(
      ({ uid }: { uid: string | null }) => useAnalyzeScopeOptions(uid),
      { initialProps: { uid: 'uid-a' as string | null } },
    )
    await waitFor(() => expect(result.current.deviceInfos.loaded).toBe(true))
    await waitFor(() => expect(result.current.snapshotSummaries).toEqual(SUMMARIES))

    let resolveDevices: (v: TypingAnalyticsDeviceInfoBundle | null) => void = () => {}
    let resolveSnapshots: (v: TypingKeymapSnapshotSummary[]) => void = () => {}
    listDeviceInfosSpy.mockReturnValue(new Promise((r) => { resolveDevices = r }))
    listSnapshotsSpy.mockReturnValue(new Promise((r) => { resolveSnapshots = r }))

    act(() => { rerender({ uid: 'uid-b' }) })
    // Cleared immediately — no stale uid-a data lingers while uid-b's
    // fetch is in flight.
    expect(result.current.deviceInfos).toEqual({ own: null, remotes: [], loaded: false, error: false })
    expect(result.current.snapshotSummaries).toEqual([])
    expect(result.current.summariesLoading).toBe(true)

    await act(async () => {
      resolveDevices(BUNDLE)
      resolveSnapshots([])
      await Promise.resolve()
    })
    expect(listDeviceInfosSpy).toHaveBeenCalledWith('uid-b')
    expect(listSnapshotsSpy).toHaveBeenCalledWith('uid-b')
  })

  it('returns the empty/loading shape on the very first render after a uid switch (no effect lag)', async () => {
    // Regression: the clear used to happen in an effect, so a consumer's
    // effect in the same commit as the uid switch could still read the
    // PREVIOUS uid's summaries (e.g. AnalyzePane's auto-range-per-uid
    // effect marking the new uid as auto-ranged using the old list).
    // Record what every render actually returned so the pre-effect
    // window is observable.
    const seen: Array<{ uid: string | null; summariesLen: number; loading: boolean; devicesLoaded: boolean }> = []
    const { result, rerender } = renderHook(
      ({ uid }: { uid: string | null }) => {
        const r = useAnalyzeScopeOptions(uid)
        seen.push({
          uid,
          summariesLen: r.snapshotSummaries.length,
          loading: r.summariesLoading,
          devicesLoaded: r.deviceInfos.loaded,
        })
        return r
      },
      { initialProps: { uid: 'uid-a' as string | null } },
    )
    await waitFor(() => expect(result.current.snapshotSummaries).toEqual(SUMMARIES))
    await waitFor(() => expect(result.current.deviceInfos.loaded).toBe(true))

    // Keep uid-b's fetches pending so any stale leak would be visible.
    listDeviceInfosSpy.mockReturnValue(new Promise(() => {}))
    listSnapshotsSpy.mockReturnValue(new Promise(() => {}))
    act(() => { rerender({ uid: 'uid-b' }) })

    // EVERY render that saw uid-b — including the first one, before any
    // effect ran — must have reported empty + loading.
    const uidBRenders = seen.filter((s) => s.uid === 'uid-b')
    expect(uidBRenders.length).toBeGreaterThan(0)
    for (const s of uidBRenders) {
      expect(s.summariesLen).toBe(0)
      expect(s.loading).toBe(true)
      expect(s.devicesLoaded).toBe(false)
    }
  })

  it('clears everything and skips IPC when the uid switches to null', async () => {
    const { result, rerender } = renderHook(
      ({ uid }: { uid: string | null }) => useAnalyzeScopeOptions(uid),
      { initialProps: { uid: 'uid-a' as string | null } },
    )
    await waitFor(() => expect(result.current.deviceInfos.loaded).toBe(true))
    listDeviceInfosSpy.mockClear()
    listSnapshotsSpy.mockClear()

    rerender({ uid: null })
    expect(result.current.deviceInfos).toEqual({ own: null, remotes: [], loaded: false, error: false })
    expect(result.current.snapshotSummaries).toEqual([])
    expect(result.current.summariesLoading).toBe(false)
    expect(listDeviceInfosSpy).not.toHaveBeenCalled()
    expect(listSnapshotsSpy).not.toHaveBeenCalled()
  })
})
