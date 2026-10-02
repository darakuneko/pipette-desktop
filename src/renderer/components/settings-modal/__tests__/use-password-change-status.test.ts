// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { usePasswordChangeStatus, type UsePasswordChangeStatusOptions } from '../use-password-change-status'
import type { PasswordChangeStatus } from '../../../../shared/types/sync'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => `t(${fallback ?? key})`,
  }),
}))

const IN_PROGRESS: PasswordChangeStatus = { kind: 'inProgress', target: 'new', step: 'reencrypting', startedAt: 1 }
const LOCK = { startedAt: '2026-10-02T09:00:00.000Z', ownMachine: false }

const api = {
  syncPasswordChangeStatus: vi.fn(),
  syncPasswordChangeLockStatus: vi.fn(),
  syncPasswordChangeResume: vi.fn(),
  syncPasswordChangeRevert: vi.fn(),
  syncPasswordChangeAbandon: vi.fn(),
  syncPasswordChangeDeleteUndecryptable: vi.fn(),
  syncPasswordChangeReleaseLocks: vi.fn(),
}
Object.defineProperty(window, 'vialAPI', { value: api, writable: true })

const BASE: UsePasswordChangeStatusOptions = { authenticated: true, formBusy: false, progress: null, lastSyncResult: null }

function renderStatusHook(options: UsePasswordChangeStatusOptions = BASE) {
  return renderHook((props: UsePasswordChangeStatusOptions) => usePasswordChangeStatus(props), { initialProps: options })
}

describe('usePasswordChangeStatus', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    api.syncPasswordChangeStatus.mockResolvedValue({ kind: 'none' })
    api.syncPasswordChangeLockStatus.mockResolvedValue(null)
    for (const fn of [api.syncPasswordChangeResume, api.syncPasswordChangeRevert, api.syncPasswordChangeAbandon, api.syncPasswordChangeReleaseLocks]) {
      fn.mockResolvedValue({ success: true })
    }
    api.syncPasswordChangeDeleteUndecryptable.mockResolvedValue({ success: true, deleted: ['f1'], skipped: [] })
  })

  it('fetches the change status on mount', async () => {
    api.syncPasswordChangeStatus.mockResolvedValue(IN_PROGRESS)
    const { result } = renderStatusHook()
    await waitFor(() => expect(result.current.status).toEqual(IN_PROGRESS))
    expect(api.syncPasswordChangeLockStatus).not.toHaveBeenCalled()
    expect(result.current.lockStatus).toBeNull()
  })

  it('looks up the Drive lock only without a local change and when signed in', async () => {
    api.syncPasswordChangeLockStatus.mockResolvedValue(LOCK)
    const { result } = renderStatusHook()
    await waitFor(() => expect(result.current.lockStatus).toEqual(LOCK))

    api.syncPasswordChangeLockStatus.mockClear()
    renderStatusHook({ ...BASE, authenticated: false })
    await waitFor(() => expect(api.syncPasswordChangeStatus).toHaveBeenCalledTimes(2))
    expect(api.syncPasswordChangeLockStatus).not.toHaveBeenCalled()
  })

  it('treats a failing lock lookup as no lock', async () => {
    api.syncPasswordChangeLockStatus.mockRejectedValue(new Error('offline'))
    const { result } = renderStatusHook()
    await waitFor(() => expect(api.syncPasswordChangeLockStatus).toHaveBeenCalled())
    expect(result.current.lockStatus).toBeNull()
    expect(result.current.status).toEqual({ kind: 'none' })
  })

  it('waits while the password form is busy and refetches once it is done', async () => {
    const { rerender } = renderStatusHook({ ...BASE, formBusy: true })
    await act(async () => {})
    expect(api.syncPasswordChangeStatus).not.toHaveBeenCalled()

    rerender({ ...BASE, formBusy: false })
    await waitFor(() => expect(api.syncPasswordChangeStatus).toHaveBeenCalledTimes(1))
  })

  it('refetches status and lock whenever a sync finishes', async () => {
    const { rerender } = renderStatusHook()
    await waitFor(() => expect(api.syncPasswordChangeLockStatus).toHaveBeenCalledTimes(1))

    rerender({ ...BASE, lastSyncResult: { status: 'success', timestamp: 1 } })
    await waitFor(() => expect(api.syncPasswordChangeLockStatus).toHaveBeenCalledTimes(2))
    expect(api.syncPasswordChangeStatus).toHaveBeenCalledTimes(2)
  })

  it('refetches only the local status for a password-change progress message', async () => {
    api.syncPasswordChangeLockStatus.mockResolvedValue(LOCK)
    const { result, rerender } = renderStatusHook()
    await waitFor(() => expect(result.current.lockStatus).toEqual(LOCK))

    rerender({ ...BASE, progress: { direction: 'upload', status: 'syncing', message: 'sync.unrelated' } })
    await act(async () => {})
    expect(api.syncPasswordChangeStatus).toHaveBeenCalledTimes(1)

    rerender({ ...BASE, progress: { direction: 'upload', status: 'error', message: 'sync.passwordChange.blockedByOtherDevice' } })
    await waitFor(() => expect(api.syncPasswordChangeStatus).toHaveBeenCalledTimes(2))
    expect(api.syncPasswordChangeLockStatus).toHaveBeenCalledTimes(1)
    expect(result.current.lockStatus).toEqual(LOCK)
  })

  it('a status-only refetch that finds a local change hides the lock', async () => {
    api.syncPasswordChangeLockStatus.mockResolvedValue(LOCK)
    const { result, rerender } = renderStatusHook()
    await waitFor(() => expect(result.current.lockStatus).toEqual(LOCK))

    api.syncPasswordChangeStatus.mockResolvedValue(IN_PROGRESS)
    rerender({ ...BASE, progress: { direction: 'upload', status: 'error', message: 'sync.passwordChange.lockLost' } })
    await waitFor(() => expect(result.current.status).toEqual(IN_PROGRESS))
    expect(result.current.lockStatus).toBeNull()
  })

  it('a lock lookup that finishes after a newer status found a local change is dropped', async () => {
    let finishLock: (value: unknown) => void = () => {}
    api.syncPasswordChangeLockStatus.mockReturnValueOnce(new Promise((resolve) => { finishLock = resolve }))
    const { result, rerender } = renderStatusHook()
    await waitFor(() => expect(api.syncPasswordChangeLockStatus).toHaveBeenCalledTimes(1))

    api.syncPasswordChangeStatus.mockResolvedValue(IN_PROGRESS)
    rerender({ ...BASE, progress: { direction: 'upload', status: 'error', message: 'sync.passwordChange.lockLost' } })
    await waitFor(() => expect(result.current.status).toEqual(IN_PROGRESS))

    await act(async () => {
      finishLock(LOCK)
    })
    expect(result.current.lockStatus).toBeNull()
  })

  it('a stale status response neither overwrites a newer status nor brings the lock back', async () => {
    let finishFirstStatus: (value: unknown) => void = () => {}
    api.syncPasswordChangeStatus.mockReturnValueOnce(new Promise((resolve) => { finishFirstStatus = resolve }))
    api.syncPasswordChangeStatus.mockResolvedValue(IN_PROGRESS)
    api.syncPasswordChangeLockStatus.mockResolvedValue(LOCK)
    const { result, rerender } = renderStatusHook()

    rerender({ ...BASE, progress: { direction: 'upload', status: 'error', message: 'sync.passwordChange.lockLost' } })
    await waitFor(() => expect(result.current.status).toEqual(IN_PROGRESS))

    await act(async () => {
      finishFirstStatus({ kind: 'none' })
    })
    expect(result.current.status).toEqual(IN_PROGRESS)
    expect(result.current.lockStatus).toBeNull()
  })

  it('an action refreshes with the sign-in state at its end, not at its start', async () => {
    let finish: (value: { success: boolean }) => void = () => {}
    api.syncPasswordChangeReleaseLocks.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const { result, rerender } = renderStatusHook()
    await waitFor(() => expect(api.syncPasswordChangeLockStatus).toHaveBeenCalledTimes(1))

    let pending: Promise<boolean> = Promise.resolve(true)
    act(() => {
      pending = result.current.releaseLocks()
    })
    rerender({ ...BASE, authenticated: false })
    await act(async () => {
      finish({ success: true })
      await pending
    })
    expect(api.syncPasswordChangeLockStatus).toHaveBeenCalledTimes(1)
    expect(result.current.lockStatus).toBeNull()
  })

  it('does not update state after unmount', async () => {
    let finish: (value: { success: boolean }) => void = () => {}
    api.syncPasswordChangeResume.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result, unmount } = renderStatusHook()
    let pending: Promise<boolean> = Promise.resolve(true)
    act(() => {
      pending = result.current.resume()
    })
    unmount()
    await act(async () => {
      finish({ success: false })
      await pending
    })
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it.each([
    ['resume', 'syncPasswordChangeResume'],
    ['revert', 'syncPasswordChangeRevert'],
    ['abandon', 'syncPasswordChangeAbandon'],
    ['releaseLocks', 'syncPasswordChangeReleaseLocks'],
  ] as const)('%s calls its IPC and refetches the status', async (action, ipc) => {
    const { result } = renderStatusHook()
    await waitFor(() => expect(api.syncPasswordChangeStatus).toHaveBeenCalledTimes(1))

    let ok = false
    await act(async () => {
      ok = await result.current[action]()
    })
    expect(ok).toBe(true)
    expect(api[ipc]).toHaveBeenCalledTimes(1)
    expect(api.syncPasswordChangeStatus).toHaveBeenCalledTimes(2)
    expect(result.current.running).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('shows a returned error key translated, with the key as fallback', async () => {
    api.syncPasswordChangeResume.mockResolvedValue({ success: false, error: 'sync.passwordChange.locked' })
    const { result } = renderStatusHook()
    let ok = true
    await act(async () => {
      ok = await result.current.resume()
    })
    expect(ok).toBe(false)
    expect(result.current.error).toBe('t(sync.passwordChange.locked)')
  })

  it('shows a generic error when the IPC throws', async () => {
    api.syncPasswordChangeAbandon.mockRejectedValue(new Error('boom'))
    const { result } = renderStatusHook()
    await act(async () => {
      await result.current.abandon()
    })
    expect(result.current.error).toBe('t(statusBar.sync.error)')
    expect(result.current.running).toBe(false)
  })

  it('reports running while an action is in flight', async () => {
    let finish: (value: { success: boolean }) => void = () => {}
    api.syncPasswordChangeResume.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const { result } = renderStatusHook()
    let pending: Promise<boolean> = Promise.resolve(true)
    act(() => {
      pending = result.current.resume()
    })
    await waitFor(() => expect(result.current.running).toBe(true))
    await act(async () => {
      finish({ success: true })
      await pending
    })
    expect(result.current.running).toBe(false)
  })

  it('deletes one undecryptable file', async () => {
    const { result } = renderStatusHook()
    let ok = false
    await act(async () => {
      ok = await result.current.deleteUndecryptable('f1')
    })
    expect(ok).toBe(true)
    expect(api.syncPasswordChangeDeleteUndecryptable).toHaveBeenCalledWith(['f1'])
  })

  it('reports a file main left alone because a password opens it', async () => {
    api.syncPasswordChangeDeleteUndecryptable.mockResolvedValue({ success: true, deleted: [], skipped: ['f1'] })
    const { result } = renderStatusHook()
    let ok = true
    await act(async () => {
      ok = await result.current.deleteUndecryptable('f1')
    })
    expect(ok).toBe(false)
    expect(result.current.error).toBe('t(sync.passwordChange.deleteSkipped)')
  })
})
