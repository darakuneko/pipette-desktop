// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useSyncFormatStatus } from '../use-sync-format-status'
import type { SyncFormatStatus } from '../../../shared/types/sync'

const NEWER: SyncFormatStatus = { required: 2, supported: 1, updateRequired: true }
const OK: SyncFormatStatus = { required: 1, supported: 1, updateRequired: false }

let pushStatus: ((status: SyncFormatStatus | null) => void) | null = null
const unsubscribe = vi.fn()
const syncFormatStatus = vi.fn<() => Promise<SyncFormatStatus | null>>()

beforeEach(() => {
  vi.clearAllMocks()
  pushStatus = null
  syncFormatStatus.mockResolvedValue(null)
  Object.defineProperty(window, 'vialAPI', {
    value: {
      syncFormatStatus,
      syncOnFormatStatusChanged: (cb: (status: SyncFormatStatus | null) => void) => {
        pushStatus = cb
        return unsubscribe
      },
    },
    writable: true,
    configurable: true,
  })
})

describe('useSyncFormatStatus', () => {
  it('fetches the status once on mount and shows the banner when an update is required', async () => {
    syncFormatStatus.mockResolvedValue(NEWER)

    const { result } = renderHook(() => useSyncFormatStatus())

    await waitFor(() => expect(result.current.visible).toBe(true))
    expect(syncFormatStatus).toHaveBeenCalledTimes(1)
  })

  it('stays hidden when Drive needs nothing newer', async () => {
    syncFormatStatus.mockResolvedValue(OK)

    const { result } = renderHook(() => useSyncFormatStatus())

    await waitFor(() => expect(syncFormatStatus).toHaveBeenCalledTimes(1))
    expect(result.current.visible).toBe(false)
  })

  it('follows pushed changes without fetching again', async () => {
    const { result } = renderHook(() => useSyncFormatStatus())
    await waitFor(() => expect(syncFormatStatus).toHaveBeenCalledTimes(1))

    act(() => pushStatus?.(NEWER))
    expect(result.current.visible).toBe(true)

    act(() => pushStatus?.(null))
    expect(result.current.visible).toBe(false)

    expect(syncFormatStatus).toHaveBeenCalledTimes(1)
  })

  it('a push wins over the initial fetch answering late', async () => {
    let resolveFetch!: (s: SyncFormatStatus | null) => void
    syncFormatStatus.mockReturnValueOnce(new Promise((r) => { resolveFetch = r }))
    const { result } = renderHook(() => useSyncFormatStatus())

    act(() => pushStatus?.(NEWER))
    await act(async () => resolveFetch(null))

    expect(result.current.visible).toBe(true)
  })

  it('dismiss hides the banner and it stays hidden after later pushes', async () => {
    syncFormatStatus.mockResolvedValue(NEWER)
    const { result } = renderHook(() => useSyncFormatStatus())
    await waitFor(() => expect(result.current.visible).toBe(true))

    act(() => result.current.dismiss())
    expect(result.current.visible).toBe(false)

    act(() => pushStatus?.(NEWER))
    expect(result.current.visible).toBe(false)
  })

  it('a failed fetch leaves the banner hidden', async () => {
    syncFormatStatus.mockRejectedValue(new Error('ipc'))

    const { result } = renderHook(() => useSyncFormatStatus())

    await waitFor(() => expect(syncFormatStatus).toHaveBeenCalledTimes(1))
    expect(result.current.visible).toBe(false)
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useSyncFormatStatus())

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
