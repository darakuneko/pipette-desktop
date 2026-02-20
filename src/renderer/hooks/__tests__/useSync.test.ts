// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { waitFor, act } from '@testing-library/react'
import { useSync } from '../useSync'
import { setupAppConfigMock, renderHookWithConfig } from './test-helpers'
import { DEFAULT_APP_CONFIG } from '../../../shared/types/app-config'

const RETRY_DELAY_MS = 2000

const mockVialAPI = {
  syncAuthStatus: vi.fn().mockResolvedValue({ authenticated: false }),
  syncHasPassword: vi.fn().mockResolvedValue(false),
  syncHasPendingChanges: vi.fn().mockResolvedValue(false),
  syncAuthStart: vi.fn().mockResolvedValue({ success: true }),
  syncAuthSignOut: vi.fn().mockResolvedValue({ success: true }),
  syncSetPassword: vi.fn().mockResolvedValue({ success: true }),
  syncResetTargets: vi.fn().mockResolvedValue({ success: true }),
  syncCheckPasswordExists: vi.fn().mockResolvedValue(false),
  syncValidatePassword: vi.fn().mockResolvedValue({ score: 4, feedback: [] }),
  syncExecute: vi.fn().mockResolvedValue({ success: true }),
  syncOnProgress: vi.fn().mockReturnValue(() => {}),
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

  it('calls syncExecute on syncNow', async () => {
    const { result } = renderHookWithConfig(() => useSync())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    await act(async () => {
      await result.current.syncNow('download')
    })

    expect(mockVialAPI.syncExecute).toHaveBeenCalledWith('download', undefined)
  })

  describe('remote password check', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('checks remote password on mount when authenticated', async () => {
      mockVialAPI.syncAuthStatus.mockResolvedValueOnce({ authenticated: true })
      mockVialAPI.syncCheckPasswordExists.mockResolvedValueOnce(true)

      const { result } = renderHookWithConfig(() => useSync())

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      await waitFor(() => {
        expect(result.current.hasRemotePassword).toBe(true)
      })

      expect(result.current.checkingRemotePassword).toBe(false)
      expect(result.current.syncUnavailable).toBe(false)
    })

    it('does not check remote password when not authenticated', async () => {
      mockVialAPI.syncAuthStatus.mockResolvedValueOnce({ authenticated: false })

      const { result } = renderHookWithConfig(() => useSync())

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      expect(result.current.hasRemotePassword).toBeNull()
      expect(mockVialAPI.syncCheckPasswordExists).not.toHaveBeenCalled()
    })

    it('retries on failure and sets syncUnavailable after max retries', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })

      mockVialAPI.syncAuthStatus.mockResolvedValueOnce({ authenticated: true })
      mockVialAPI.syncCheckPasswordExists
        .mockRejectedValueOnce(new Error('network error'))
        .mockRejectedValueOnce(new Error('network error'))
        .mockRejectedValueOnce(new Error('network error'))

      const { result } = renderHookWithConfig(() => useSync())

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      // First attempt fails immediately, retry delay starts
      // Advance past first retry delay
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
      // Second attempt fails, retry delay starts
      // Advance past second retry delay
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
      // Third attempt fails, no more retries

      await waitFor(() => {
        expect(result.current.syncUnavailable).toBe(true)
      })

      expect(result.current.hasRemotePassword).toBeNull()
      expect(result.current.checkingRemotePassword).toBe(false)
    })

    it('succeeds on retry after initial failure', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })

      mockVialAPI.syncAuthStatus.mockResolvedValueOnce({ authenticated: true })
      mockVialAPI.syncCheckPasswordExists
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce(true)

      const { result } = renderHookWithConfig(() => useSync())

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      // First attempt fails, advance past retry delay
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)

      await waitFor(() => {
        expect(result.current.hasRemotePassword).toBe(true)
      })

      expect(result.current.syncUnavailable).toBe(false)
      expect(result.current.checkingRemotePassword).toBe(false)
    })

    it('resets remote password state on sign out', async () => {
      mockVialAPI.syncAuthStatus.mockResolvedValueOnce({ authenticated: true })
      mockVialAPI.syncCheckPasswordExists.mockResolvedValueOnce(true)

      const { result } = renderHookWithConfig(() => useSync())

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      await waitFor(() => {
        expect(result.current.hasRemotePassword).toBe(true)
      })

      await act(async () => {
        await result.current.signOut()
      })

      expect(result.current.hasRemotePassword).toBeNull()
    })

    it('retryRemoteCheck clears syncUnavailable and re-triggers check', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })

      mockVialAPI.syncAuthStatus.mockResolvedValue({ authenticated: true })
      mockVialAPI.syncCheckPasswordExists
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce(true)

      const { result } = renderHookWithConfig(() => useSync())

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)

      await waitFor(() => {
        expect(result.current.syncUnavailable).toBe(true)
      })

      // Retry should clear unavailable and trigger a new check
      act(() => {
        result.current.retryRemoteCheck()
      })

      await waitFor(() => {
        expect(result.current.hasRemotePassword).toBe(true)
      })

      expect(result.current.syncUnavailable).toBe(false)

      vi.useRealTimers()
    })

    it('clears syncUnavailable when syncing progress event arrives', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })

      mockVialAPI.syncAuthStatus.mockResolvedValue({ authenticated: true })
      mockVialAPI.syncCheckPasswordExists
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))

      let progressCb: (p: unknown) => void = () => {}
      mockVialAPI.syncOnProgress.mockImplementation((cb: (p: unknown) => void) => {
        progressCb = cb
        return () => {}
      })

      const { result } = renderHookWithConfig(() => useSync())

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS)

      await waitFor(() => {
        expect(result.current.syncUnavailable).toBe(true)
      })

      // Simulate backend polling success
      act(() => {
        progressCb({ status: 'syncing', direction: 'download' })
      })

      expect(result.current.syncUnavailable).toBe(false)

      vi.useRealTimers()
    })
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
      { progressStatus: 'partial', expected: 'partial' },
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

    it('returns partial from lastSyncResult when authenticated', async () => {
      captureProgressCallback()
      mockAuthenticatedState()
      const { result } = await mountAndWait()

      act(() => {
        progressCallback({
          direction: 'upload',
          status: 'partial',
          failedUnits: ['favorites/tapDance'],
        })
      })

      expect(result.current.syncStatus).toBe('partial')
      expect(result.current.lastSyncResult?.status).toBe('partial')
      expect(result.current.lastSyncResult?.failedUnits).toEqual(['favorites/tapDance'])
    })
  })
})
