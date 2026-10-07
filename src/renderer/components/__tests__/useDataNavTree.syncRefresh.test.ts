// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useDataNavTree, resetDataNavCache } from '../data-modal/useDataNavTree'
import { dispatchSyncUnitApplied } from '../../hooks/use-sync-unit-applied'

const listStoredKeyboards = vi.fn()

beforeEach(() => {
  resetDataNavCache()
  listStoredKeyboards.mockReset()
  Object.defineProperty(window, 'vialAPI', {
    value: {
      ...window.vialAPI,
      listStoredKeyboards,
      typingAnalyticsListKeyboards: vi.fn().mockResolvedValue([]),
    },
    writable: true,
    configurable: true,
  })
})

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('useDataNavTree sync refresh', () => {
  it('renames the open keyboard page without resetting navigation', async () => {
    listStoredKeyboards.mockResolvedValueOnce([{ uid: 'u1', name: 'Old' }, { uid: 'u2', name: 'Other' }])
    const { result } = renderHook(() => useDataNavTree({ showHubTab: false, syncEnabled: false }))
    await waitFor(() => expect(result.current.storedKeyboards).toHaveLength(2))
    act(() => {
      result.current.toggleExpand('local-keyboards')
      result.current.setActivePath({ section: 'local', page: 'keyboard', uid: 'u1', name: 'Old' })
    })

    listStoredKeyboards.mockResolvedValueOnce([{ uid: 'u1', name: 'New' }, { uid: 'u2', name: 'Other' }])
    act(() => { dispatchSyncUnitApplied('meta/keyboard-names') })

    await waitFor(() => expect(result.current.activePath).toEqual({ section: 'local', page: 'keyboard', uid: 'u1', name: 'New' }))
    expect(result.current.isExpanded('local-keyboards')).toBe(true)
    expect(result.current.storedKeyboards.map((kb) => kb.name)).toEqual(['New', 'Other'])
  })

  it('re-reads the keyboard list when any keyboard\'s snapshots were merged', async () => {
    listStoredKeyboards.mockResolvedValueOnce([])
    const { result } = renderHook(() => useDataNavTree({ showHubTab: false, syncEnabled: false }))
    await waitFor(() => expect(listStoredKeyboards).toHaveBeenCalledTimes(1))

    listStoredKeyboards.mockResolvedValueOnce([{ uid: 'u3', name: 'Arrived' }])
    act(() => { dispatchSyncUnitApplied('keyboards/u3/snapshots') })
    await waitFor(() => expect(result.current.storedKeyboards).toEqual([{ uid: 'u3', name: 'Arrived' }]))

    act(() => { dispatchSyncUnitApplied('keyboards/u3/settings') })
    expect(listStoredKeyboards).toHaveBeenCalledTimes(2)
  })

  it('drops a keyboard list that arrives after a newer one', async () => {
    listStoredKeyboards.mockResolvedValueOnce([])
    const { result } = renderHook(() => useDataNavTree({ showHubTab: false, syncEnabled: false }))
    await waitFor(() => expect(listStoredKeyboards).toHaveBeenCalledTimes(1))

    const older = deferred<unknown>()
    const newer = deferred<unknown>()
    listStoredKeyboards.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    act(() => { dispatchSyncUnitApplied('meta/keyboard-names') })
    act(() => { dispatchSyncUnitApplied('meta/keyboard-names') })
    await act(async () => { newer.resolve([{ uid: 'u1', name: 'Newer' }]) })
    await act(async () => { older.resolve([{ uid: 'u1', name: 'Older' }]) })

    expect(result.current.storedKeyboards).toEqual([{ uid: 'u1', name: 'Newer' }])
  })

  it('a slow initial read does not overwrite a newer sync read', async () => {
    const initial = deferred<unknown>()
    listStoredKeyboards.mockReturnValueOnce(initial.promise)
    const { result } = renderHook(() => useDataNavTree({ showHubTab: false, syncEnabled: false }))
    await waitFor(() => expect(listStoredKeyboards).toHaveBeenCalledTimes(1))

    listStoredKeyboards.mockResolvedValueOnce([{ uid: 'u1', name: 'Newer' }])
    act(() => { dispatchSyncUnitApplied('meta/keyboard-names') })
    await waitFor(() => expect(result.current.storedKeyboards).toEqual([{ uid: 'u1', name: 'Newer' }]))
    await act(async () => { initial.resolve([{ uid: 'u1', name: 'Stale' }]) })

    expect(result.current.storedKeyboards).toEqual([{ uid: 'u1', name: 'Newer' }])
  })

  it('a slow post-download read does not overwrite a newer sync read', async () => {
    listStoredKeyboards.mockResolvedValueOnce([])
    const syncExecute = vi.fn().mockResolvedValue(undefined)
    ;(window.vialAPI as unknown as Record<string, unknown>).syncExecute = syncExecute
    const { result } = renderHook(() => useDataNavTree({ showHubTab: false, syncEnabled: false }))
    await waitFor(() => expect(listStoredKeyboards).toHaveBeenCalledTimes(1))

    const postDownload = deferred<unknown>()
    listStoredKeyboards.mockReturnValueOnce(postDownload.promise)
    let download!: Promise<void>
    act(() => { download = result.current.onSyncKeyboardSelect('u9', 'Remote') })
    await waitFor(() => expect(listStoredKeyboards).toHaveBeenCalledTimes(2))

    listStoredKeyboards.mockResolvedValueOnce([{ uid: 'u9', name: 'Newer' }])
    act(() => { dispatchSyncUnitApplied('keyboards/u9/snapshots') })
    await waitFor(() => expect(result.current.storedKeyboards).toEqual([{ uid: 'u9', name: 'Newer' }]))
    await act(async () => {
      postDownload.resolve([{ uid: 'u9', name: 'Stale' }])
      await download
    })

    expect(result.current.storedKeyboards).toEqual([{ uid: 'u9', name: 'Newer' }])
  })
})

