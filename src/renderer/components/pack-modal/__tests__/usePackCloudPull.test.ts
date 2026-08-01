// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePackCloudPull } from '../usePackCloudPull'

const t = ((key: string) => key) as unknown as Parameters<typeof usePackCloudPull>[1]

describe('usePackCloudPull', () => {
  let setActionError: ReturnType<typeof vi.fn>
  let syncExecute: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActionError = vi.fn()
    syncExecute = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).vialAPI = { syncExecute }
  })

  it('clears the error and does not surface one when the pull completes', async () => {
    syncExecute.mockResolvedValue({ success: true, status: 'completed' })
    const { result } = renderHook(() => usePackCloudPull(setActionError, t, 'i18n.errorGeneric'))

    await act(async () => {
      await result.current.pull()
    })

    expect(setActionError).toHaveBeenCalledWith(null)
    expect(setActionError).not.toHaveBeenCalledWith(expect.stringContaining('pullError'))
    expect(setActionError.mock.calls.map((c) => c[0])).toEqual([null])
  })

  // M2: success stays true for a silent skip/partial (see
  // SyncOperationResult's doc) — the hook must branch on `status`, not
  // `success`, to surface these as errors instead of silently doing
  // nothing.
  it('surfaces a localized error when the pull is skipped (busy race)', async () => {
    syncExecute.mockResolvedValue({ success: true, status: 'skipped', skipReason: 'busy' })
    const { result } = renderHook(() => usePackCloudPull(setActionError, t, 'i18n.errorGeneric'))

    await act(async () => {
      await result.current.pull()
    })

    expect(setActionError).toHaveBeenLastCalledWith('sync.pullError.busy')
  })

  it('surfaces a localized error when the pull is skipped for a credential reason', async () => {
    syncExecute.mockResolvedValue({ success: true, status: 'skipped', skipReason: 'unauthenticated' })
    const { result } = renderHook(() => usePackCloudPull(setActionError, t, 'i18n.errorGeneric'))

    await act(async () => {
      await result.current.pull()
    })

    expect(setActionError).toHaveBeenLastCalledWith('sync.pullError.unauthenticated')
  })

  it('surfaces a localized error when the pull is partial', async () => {
    syncExecute.mockResolvedValue({ success: true, status: 'partial', error: '1 sync unit(s) failed' })
    const { result } = renderHook(() => usePackCloudPull(setActionError, t, 'i18n.errorGeneric'))

    await act(async () => {
      await result.current.pull()
    })

    expect(setActionError).toHaveBeenLastCalledWith('sync.pullError.partial')
  })

  it('falls back to the feature-specific generic error when syncExecute throws outright', async () => {
    syncExecute.mockRejectedValue(new Error('network down'))
    const { result } = renderHook(() => usePackCloudPull(setActionError, t, 'i18n.errorGeneric'))

    await act(async () => {
      await result.current.pull()
    })

    expect(setActionError).toHaveBeenLastCalledWith('network down')
  })

  it('tracks pulling state across the call', async () => {
    let resolvePull: (value: unknown) => void = () => {}
    syncExecute.mockReturnValue(new Promise((resolve) => { resolvePull = resolve }))
    const { result } = renderHook(() => usePackCloudPull(setActionError, t, 'i18n.errorGeneric'))

    let pullPromise: Promise<void>
    act(() => {
      pullPromise = result.current.pull()
    })
    expect(result.current.pulling).toBe(true)

    await act(async () => {
      resolvePull({ success: true, status: 'completed' })
      await pullPromise
    })
    expect(result.current.pulling).toBe(false)
  })
})
