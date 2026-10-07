// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// List hooks re-read their entries when a sync merge rewrote the unit they
// show, keep the rows on screen while doing so, and drop stale responses.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { dispatchSyncUnitApplied } from '../use-sync-unit-applied'
import { useAnalyzeFilterStore } from '../useAnalyzeFilterStore'
import { useLayoutStore } from '../useLayoutStore'
import { useFavoriteStore } from '../useFavoriteStore'
import { useFavoriteManage } from '../useFavoriteManage'
import { useRunLogAvailability } from '../useRunLogAvailability'
import type { VilFile } from '../../../shared/types/protocol'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const analyzeList = vi.fn()
const snapshotList = vi.fn()
const favoriteList = vi.fn()
const runLogList = vi.fn()

beforeEach(() => {
  for (const fn of [analyzeList, snapshotList, favoriteList, runLogList]) fn.mockReset()
  Object.defineProperty(window, 'vialAPI', {
    value: {
      ...window.vialAPI,
      analyzeFilterStoreList: analyzeList,
      snapshotStoreList: snapshotList,
      favoriteStoreList: favoriteList,
      typingRunLogList: runLogList,
    },
    writable: true,
    configurable: true,
  })
})

function entry(id: string): { id: string; label: string; filename: string; savedAt: string } {
  return { id, label: id, filename: `${id}.json`, savedAt: '2026-01-01T00:00:00.000Z' }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function notify(unit: string): void {
  act(() => { dispatchSyncUnitApplied(unit) })
}

describe('useAnalyzeFilterStore', () => {
  it('re-reads on its unit without emptying the list first', async () => {
    analyzeList.mockResolvedValue({ success: true, entries: [entry('a')] })
    const lengths: number[] = []
    const { result } = renderHook(() => {
      const r = useAnalyzeFilterStore({ uid: 'u1' })
      lengths.push(r.entries.length)
      return r
    })
    await act(async () => { await result.current.refreshEntries() })
    expect(result.current.entries).toHaveLength(1)
    lengths.length = 0

    const pending = deferred<unknown>()
    analyzeList.mockReturnValueOnce(pending.promise)
    notify('keyboards/u1/analyze_filters')
    await act(async () => { pending.resolve({ success: true, entries: [entry('a'), entry('b')] }) })

    expect(result.current.entries).toHaveLength(2)
    expect(lengths).not.toContain(0)
  })

  it('ignores other keyboards and other units', async () => {
    analyzeList.mockResolvedValue({ success: true, entries: [] })
    renderHook(() => useAnalyzeFilterStore({ uid: 'u1' }))
    notify('keyboards/u2/analyze_filters')
    notify('keyboards/u1/snapshots')
    expect(analyzeList).not.toHaveBeenCalled()
  })

  it('clears the list on a keyboard switch and drops the previous keyboard\'s response', async () => {
    const slow = deferred<unknown>()
    analyzeList.mockReturnValueOnce(slow.promise)
    const { result, rerender } = renderHook(({ uid }) => useAnalyzeFilterStore({ uid }), { initialProps: { uid: 'u1' } })
    act(() => { void result.current.refreshEntries() })

    rerender({ uid: 'u2' })
    analyzeList.mockResolvedValueOnce({ success: true, entries: [entry('u2-entry')] })
    await act(async () => { await result.current.refreshEntries() })
    await act(async () => { slow.resolve({ success: true, entries: [entry('u1-entry')] }) })

    expect(result.current.entries.map((e) => e.id)).toEqual(['u2-entry'])
  })
})

describe('useLayoutStore', () => {
  const options = (deviceUid: string) => ({
    deviceUid,
    deviceName: 'Board',
    serialize: () => ({}) as VilFile,
    applyVilFile: async () => ({ ok: true }) as never,
    currentDefinition: null,
  })

  it('re-reads its keyboard\'s snapshots and ignores others', async () => {
    snapshotList.mockResolvedValue({ success: true, entries: [entry('s1')] })
    const { result } = renderHook(() => useLayoutStore(options('u1')))
    notify('keyboards/u2/snapshots')
    expect(snapshotList).not.toHaveBeenCalled()

    notify('keyboards/u1/snapshots')
    await waitFor(() => expect(result.current.entries).toHaveLength(1))
    expect(snapshotList).toHaveBeenCalledWith('u1')
  })

  it('drops a response that arrives after a newer one', async () => {
    const older = deferred<unknown>()
    const newer = deferred<unknown>()
    snapshotList.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const { result } = renderHook(() => useLayoutStore(options('u1')))
    notify('keyboards/u1/snapshots')
    notify('keyboards/u1/snapshots')
    await act(async () => { newer.resolve({ success: true, entries: [entry('new')] }) })
    await act(async () => { older.resolve({ success: true, entries: [entry('old')] }) })

    expect(result.current.entries.map((e) => e.id)).toEqual(['new'])
  })
})

describe('favorite lists', () => {
  it('useFavoriteStore re-reads only its own favorite type', async () => {
    favoriteList.mockResolvedValue({ success: true, entries: [entry('f1')] })
    const { result } = renderHook(() => useFavoriteStore({
      favoriteType: 'tapDance',
      serialize: () => ({}),
      apply: () => undefined,
      vialProtocol: 6,
    }))
    notify('favorites/macro')
    expect(favoriteList).not.toHaveBeenCalled()

    notify('favorites/tapDance')
    await waitFor(() => expect(result.current.entries).toHaveLength(1))
  })

  it('useFavoriteStore stays idle while disabled', () => {
    renderHook(() => useFavoriteStore({
      favoriteType: 'tapDance',
      serialize: () => ({}),
      apply: () => undefined,
      enabled: false,
      vialProtocol: 6,
    }))
    notify('favorites/tapDance')
    expect(favoriteList).not.toHaveBeenCalled()
  })

  it('useFavoriteManage re-reads only its own favorite type', async () => {
    favoriteList.mockResolvedValue({ success: true, entries: [entry('f1')] })
    const { result } = renderHook(() => useFavoriteManage('combo'))
    notify('favorites/tapDance')
    expect(favoriteList).not.toHaveBeenCalled()

    notify('favorites/combo')
    await waitFor(() => expect(result.current.entries).toHaveLength(1))
  })
})

describe('useRunLogAvailability', () => {
  it('re-fetches when its keyboard\'s run logs were merged', async () => {
    runLogList.mockResolvedValueOnce({ success: true, entries: [] })
    const { result } = renderHook(() => useRunLogAvailability('u1', 1))
    await waitFor(() => expect(runLogList).toHaveBeenCalledTimes(1))

    runLogList.mockResolvedValueOnce({ success: true, entries: [{ id: 'run-1' }] })
    notify('keyboards/u2/runs')
    notify('keyboards/u1/runs')

    await waitFor(() => expect(result.current.availableRunIds.has('run-1')).toBe(true))
    expect(runLogList).toHaveBeenCalledTimes(2)
  })
})
