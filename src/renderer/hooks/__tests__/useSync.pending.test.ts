// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// useSync's pending status against both vialAPI implementations: a
// preload-like mock, and the Tauri shim's pending members over a mocked
// Tauri IPC. Both answer from the same spy, so the tests read the same for
// each.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import { useSync } from '../useSync'
import { renderHookWithConfig, setupAppConfigMock, vialAPIMock } from './test-helpers'
import { syncPendingApi } from '../../../tauri-shim/api/sync-pending'

let syncHasPendingChanges: Mock<() => Promise<boolean>>

interface Backend {
  name: string
  /** Puts a vialAPI whose pending members answer from the spy on window. */
  install: () => void
  /** A backend push of the pending status. */
  push: (pending: boolean) => Promise<void>
}

/** The members useSync calls besides the pending ones, signed out. */
const otherMembers = {
  syncAuthStatus: () => Promise.resolve({ authenticated: false }),
  syncPasswordStatus: () => Promise.resolve('noPasswordFile'),
  syncCheckPasswordExists: () => Promise.resolve(false),
  syncOnProgress: () => () => {},
}

function installVialAPI(members: object): void {
  setupAppConfigMock()
  Object.defineProperty(window, 'vialAPI', {
    value: { ...vialAPIMock(), ...otherMembers, ...members },
    writable: true,
    configurable: true,
  })
}

const preloadLikeMock: Backend = (() => {
  let pendingCallback: ((pending: boolean) => void) | undefined
  return {
    name: 'preload-like mock',
    install: () => {
      pendingCallback = undefined
      installVialAPI({
        syncHasPendingChanges,
        syncOnPendingChange: (callback: (pending: boolean) => void) => {
          pendingCallback = callback
          return () => {}
        },
      })
    },
    push: async (pending) => {
      act(() => {
        pendingCallback?.(pending)
      })
    },
  }
})()

const shimOverMockIPC: Backend = {
  name: 'Tauri shim over mockIPC',
  install: () => {
    mockIPC(
      (cmd) => {
        if (cmd === 'sync_has_pending_changes') return syncHasPendingChanges()
        throw new Error(`unexpected command ${cmd}`)
      },
      { shouldMockEvents: true },
    )
    installVialAPI({ ...syncPendingApi })
  },
  // The pending listen call finishes first, as it does before any event the
  // backend sends after the page subscribed.
  push: async (pending) => {
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve()
      await emit('sync:pending-status', pending)
    })
  },
}

beforeEach(() => {
  syncHasPendingChanges = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)
})

afterEach(() => {
  clearMocks()
})

describe.each([preloadLikeMock, shimOverMockIPC])('useSync pending status ($name)', (backend) => {
  beforeEach(() => {
    backend.install()
  })

  it('starts from the status the backend reports', async () => {
    syncHasPendingChanges.mockResolvedValue(true)
    const { result } = renderHookWithConfig(() => useSync())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(syncHasPendingChanges).toHaveBeenCalledOnce()
    expect(result.current.hasPendingChanges).toBe(true)
  })

  it('follows the status the backend pushes', async () => {
    const { result } = renderHookWithConfig(() => useSync())
    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.hasPendingChanges).toBe(false)

    await backend.push(true)
    expect(result.current.hasPendingChanges).toBe(true)

    await backend.push(false)
    expect(result.current.hasPendingChanges).toBe(false)
  })
})
