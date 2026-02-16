// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { waitFor, act } from '@testing-library/react'
import { useSync } from '../useSync'
import { setupAppConfigMock, renderHookWithConfig } from './test-helpers'
import { DEFAULT_APP_CONFIG } from '../../../shared/types/app-config'

const mockVialAPI = {
  syncAuthStatus: vi.fn().mockResolvedValue({ authenticated: false }),
  syncHasPassword: vi.fn().mockResolvedValue(false),
  syncHasPendingChanges: vi.fn().mockResolvedValue(false),
  syncAuthStart: vi.fn().mockResolvedValue({ success: true }),
  syncAuthSignOut: vi.fn().mockResolvedValue({ success: true }),
  syncSetPassword: vi.fn().mockResolvedValue({ success: true }),
  syncResetPassword: vi.fn().mockResolvedValue({ success: true }),
  syncResetTargets: vi.fn().mockResolvedValue({ success: true }),
  syncValidatePassword: vi.fn().mockResolvedValue({ score: 4, feedback: [] }),
  syncExecute: vi.fn().mockResolvedValue({ success: true }),
  syncOnProgress: vi.fn().mockReturnValue(() => {}),
  syncCancelPending: vi.fn().mockResolvedValue({ success: true }),
  syncOnPendingChange: vi.fn().mockReturnValue(() => {}),
}

beforeEach(() => {
  vi.clearAllMocks()
  const mocks = setupAppConfigMock()
  Object.defineProperty(window, 'vialAPI', {
    value: {
      ...((window as Record<string, unknown>).vialAPI as Record<string, unknown>),
      ...mockVialAPI,
    },
    writable: true,
    configurable: true,
  })
  return () => {
    mocks.mockAppConfigGetAll.mockReset()
    mocks.mockAppConfigSet.mockReset()
  }
})

describe('useSync', () => {
  it('loads initial state on mount', async () => {
    const { result } = renderHookWithConfig(() => useSync())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(mockVialAPI.syncAuthStatus).toHaveBeenCalledOnce()
    expect(mockVialAPI.syncHasPassword).toHaveBeenCalledOnce()
    expect(mockVialAPI.syncHasPendingChanges).toHaveBeenCalledOnce()
    expect(result.current.config).toEqual(DEFAULT_APP_CONFIG)
    expect(result.current.authStatus).toEqual({ authenticated: false })
    expect(result.current.hasPassword).toBe(false)
    expect(result.current.hasPendingChanges).toBe(false)
  })

  it('fetches initial hasPendingChanges value', async () => {
    mockVialAPI.syncHasPendingChanges.mockResolvedValueOnce(true)
    const { result } = renderHookWithConfig(() => useSync())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.hasPendingChanges).toBe(true)
  })

  it('updates hasPendingChanges via syncOnPendingChange listener', async () => {
    let pendingCallback: (pending: boolean) => void = () => {}
    mockVialAPI.syncOnPendingChange.mockImplementation((cb: (pending: boolean) => void) => {
      pendingCallback = cb
      return () => {}
    })

    const { result } = renderHookWithConfig(() => useSync())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.hasPendingChanges).toBe(false)

    act(() => {
      pendingCallback(true)
    })

    expect(result.current.hasPendingChanges).toBe(true)

    act(() => {
      pendingCallback(false)
    })

    expect(result.current.hasPendingChanges).toBe(false)
  })

  it('registers progress callback on mount', async () => {
    renderHookWithConfig(() => useSync())

    await waitFor(() => {
      expect(mockVialAPI.syncOnProgress).toHaveBeenCalledOnce()
    })
  })

  it('registers pending change callback on mount', async () => {
    renderHookWithConfig(() => useSync())

    await waitFor(() => {
      expect(mockVialAPI.syncOnPendingChange).toHaveBeenCalledOnce()
    })
  })

  it('calls syncAuthStart and refreshes on startAuth', async () => {
    const { result } = renderHookWithConfig(() => useSync())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.startAuth()
    })

    expect(mockVialAPI.syncAuthStart).toHaveBeenCalledOnce()
    // refreshStatus is called again after successful auth
    expect(mockVialAPI.syncAuthStatus).toHaveBeenCalledTimes(2)
  })

  it('calls syncAuthSignOut and refreshes on signOut', async () => {
    const { result } = renderHookWithConfig(() => useSync())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.signOut()
    })

    expect(mockVialAPI.syncAuthSignOut).toHaveBeenCalledOnce()
    expect(mockVialAPI.syncAuthStatus).toHaveBeenCalledTimes(2)
  })

  it('setConfig updates config via appConfig', async () => {
    const { result } = renderHookWithConfig(() => useSync())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    act(() => {
      result.current.setConfig({ autoSync: true })
    })

    expect(result.current.config.autoSync).toBe(true)
  })

  it('sets hasPassword to true on successful setPassword', async () => {
    const { result } = renderHookWithConfig(() => useSync())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      const res = await result.current.setPassword('strongpass123!')
      expect(res.success).toBe(true)
    })

    expect(result.current.hasPassword).toBe(true)
  })

  it('throws on startAuth when syncAuthStart returns failure', async () => {
    mockVialAPI.syncAuthStart.mockResolvedValueOnce({ success: false, error: 'OAuth error' })
    const { result } = renderHookWithConfig(() => useSync())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await expect(
      act(async () => {
        await result.current.startAuth()
      }),
    ).rejects.toThrow('OAuth error')

    // refreshStatus should NOT be called again (no second round of fetches)
    expect(mockVialAPI.syncAuthStatus).toHaveBeenCalledTimes(1)
  })

  it('sets lastSyncResult on success progress event', async () => {
    let progressCallback: (p: unknown) => void = () => {}
    mockVialAPI.syncOnProgress.mockImplementation((cb: (p: unknown) => void) => {
      progressCallback = cb
      return () => {}
    })

    const { result } = renderHookWithConfig(() => useSync())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    act(() => {
      progressCallback({ direction: 'upload', status: 'success', message: 'Sync complete' })
    })

    expect(result.current.lastSyncResult).toMatchObject({
      status: 'success',
      message: 'Sync complete',
    })
    expect(result.current.lastSyncResult?.timestamp).toBeGreaterThan(0)
  })

  it('sets lastSyncResult on error progress event', async () => {
    let progressCallback: (p: unknown) => void = () => {}
    mockVialAPI.syncOnProgress.mockImplementation((cb: (p: unknown) => void) => {
      progressCallback = cb
      return () => {}
    })

    const { result } = renderHookWithConfig(() => useSync())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    act(() => {
      progressCallback({ direction: 'download', status: 'error', message: 'Drive API 403' })
    })

    expect(result.current.lastSyncResult).toMatchObject({
      status: 'error',
      message: 'Drive API 403',
    })
  })

  it('clears lastSyncResult on sign-out', async () => {
    let progressCallback: (p: unknown) => void = () => {}
    mockVialAPI.syncOnProgress.mockImplementation((cb: (p: unknown) => void) => {
      progressCallback = cb
      return () => {}
    })

    const { result } = renderHookWithConfig(() => useSync())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    act(() => {
      progressCallback({ direction: 'upload', status: 'success', message: 'Sync complete' })
    })

    expect(result.current.lastSyncResult).not.toBeNull()

    await act(async () => {
      await result.current.signOut()
    })

    expect(result.current.lastSyncResult).toBeNull()
  })

  it('calls syncCancelPending on cancelPending', async () => {
    const { result } = renderHookWithConfig(() => useSync())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.cancelPending()
    })

    expect(mockVialAPI.syncCancelPending).toHaveBeenCalledOnce()
  })

  it('calls syncExecute on syncNow', async () => {
    const { result } = renderHookWithConfig(() => useSync())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.syncNow('download')
    })

    expect(mockVialAPI.syncExecute).toHaveBeenCalledWith('download')
  })

  describe('syncStatus', () => {
    let progressCallback: (p: unknown) => void

    function captureProgressCallback(): void {
      progressCallback = () => {}
      mockVialAPI.syncOnProgress.mockImplementation((cb: (p: unknown) => void) => {
        progressCallback = cb
        return () => {}
      })
    }

    function mockAuthenticatedState(overrides: {
      autoSync?: boolean
      pending?: boolean
    } = {}): void {
      if (overrides.autoSync !== undefined) {
        setupAppConfigMock({ autoSync: overrides.autoSync })
        Object.defineProperty(window, 'vialAPI', {
          value: {
            ...((window as Record<string, unknown>).vialAPI as Record<string, unknown>),
            ...mockVialAPI,
          },
          writable: true,
          configurable: true,
        })
      }
      mockVialAPI.syncAuthStatus.mockResolvedValueOnce({ authenticated: true })
      mockVialAPI.syncHasPassword.mockResolvedValueOnce(true)
      if (overrides.pending !== undefined) {
        mockVialAPI.syncHasPendingChanges.mockResolvedValueOnce(overrides.pending)
      }
    }

    async function mountAndWait(): Promise<ReturnType<typeof renderHookWithConfig<ReturnType<typeof useSync>>>> {
      const hook = renderHookWithConfig(() => useSync())
      await waitFor(() => {
        expect(hook.result.current.loading).toBe(false)
      })
      return hook
    }

    it('returns none by default (not authenticated)', async () => {
      const { result } = await mountAndWait()
      expect(result.current.syncStatus).toBe('none')
    })

    it.each([
      { progressStatus: 'syncing', expected: 'syncing' },
      { progressStatus: 'success', expected: 'synced' },
      { progressStatus: 'error', expected: 'error' },
    ])('returns $expected from progress $progressStatus even with autoSync off', async ({ progressStatus, expected }) => {
      captureProgressCallback()
      const { result } = await mountAndWait()

      act(() => {
        progressCallback({ direction: 'download', status: progressStatus })
      })

      expect(result.current.syncStatus).toBe(expected)
    })

    it('returns pending when autoSync on with pending changes', async () => {
      mockAuthenticatedState({ autoSync: true, pending: true })
      const { result } = await mountAndWait()
      expect(result.current.syncStatus).toBe('pending')
    })

    it('returns none when autoSync off with pending changes (no progress)', async () => {
      mockAuthenticatedState({ autoSync: false, pending: true })
      const { result } = await mountAndWait()
      expect(result.current.syncStatus).toBe('none')
    })

    it('returns synced from lastSyncResult when authenticated', async () => {
      captureProgressCallback()
      mockAuthenticatedState()
      const { result } = await mountAndWait()

      act(() => {
        progressCallback({ direction: 'upload', status: 'success' })
      })

      expect(result.current.syncStatus).toBe('synced')
    })
  })
})
