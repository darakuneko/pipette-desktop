// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// Runs against both vialAPI implementations: a preload-like mock, and the
// Tauri shim's app config members over a mocked Tauri IPC.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { useAppConfig } from '../useAppConfig'
import { renderHookWithConfig } from './test-helpers'
import { DEFAULT_APP_CONFIG, type AppConfig } from '../../../shared/types/app-config'
import { appConfigApi } from '../../../tauri-shim/api/app-config'

interface BackendOptions {
  config?: AppConfig
  getAllFails?: boolean
  setFails?: boolean
}

interface Backend {
  name: string
  /** Puts a vialAPI with the app config members on window. */
  install: (options?: BackendOptions) => void
  /** The keys and values the backend was asked to store. */
  sets: () => [string, unknown][]
}

function installVialAPI(value: object): void {
  Object.defineProperty(window, 'vialAPI', { value, writable: true, configurable: true })
}

const preloadLikeMock: Backend = (() => {
  const set = vi.fn<(key: string, value: unknown) => Promise<void>>()
  return {
    name: 'preload-like mock',
    install: ({ config = DEFAULT_APP_CONFIG, getAllFails, setFails } = {}) => {
      set.mockReset()
      set.mockImplementation(() => (setFails ? Promise.reject(new Error('write fail')) : Promise.resolve()))
      installVialAPI({
        appConfigGetAll: () => (getAllFails ? Promise.reject(new Error('fail')) : Promise.resolve(config)),
        appConfigSet: set,
      })
    },
    sets: () => set.mock.calls,
  }
})()

const shimOverMockIPC: Backend = (() => {
  let sets: [string, unknown][] = []
  return {
    name: 'Tauri shim over mockIPC',
    install: ({ config = DEFAULT_APP_CONFIG, getAllFails, setFails } = {}) => {
      sets = []
      mockIPC((cmd, payload) => {
        if (cmd === 'app_config_get_all') {
          if (getAllFails) throw new Error('fail')
          return config
        }
        if (cmd === 'app_config_set') {
          const { key, value } = payload as { key: string; value: string }
          sets.push([key, JSON.parse(value)])
          if (setFails) throw new Error('write fail')
          return null
        }
        throw new Error(`unexpected command ${cmd}`)
      })
      installVialAPI({ ...appConfigApi })
    },
    sets: () => sets,
  }
})()

afterEach(() => {
  clearMocks()
})

describe.each([preloadLikeMock, shimOverMockIPC])('useAppConfig ($name)', (backend) => {
  it('loads config on mount', async () => {
    backend.install({ config: { ...DEFAULT_APP_CONFIG, theme: 'dark' } })
    const { result } = renderHookWithConfig(() => useAppConfig())

    // Initially loading
    expect(result.current.loading).toBe(true)

    await act(async () => {})

    expect(result.current.loading).toBe(false)
    expect(result.current.config.theme).toBe('dark')
  })

  it('returns defaults when IPC fails', async () => {
    backend.install({ getAllFails: true })

    const { result } = renderHookWithConfig(() => useAppConfig())
    await act(async () => {})

    expect(result.current.loading).toBe(false)
    expect(result.current.config).toEqual(DEFAULT_APP_CONFIG)
  })

  it('set updates state immediately and calls IPC', async () => {
    backend.install()
    const { result } = renderHookWithConfig(() => useAppConfig())
    await act(async () => {})

    act(() => {
      result.current.set('theme', 'dark')
    })

    expect(result.current.config.theme).toBe('dark')
    await act(async () => {})
    expect(backend.sets()).toEqual([['theme', 'dark']])
  })

  it('set handles IPC failure gracefully', async () => {
    backend.install({ setFails: true })

    const { result } = renderHookWithConfig(() => useAppConfig())
    await act(async () => {})

    // Should not throw
    act(() => {
      result.current.set('autoLockTime', 30)
    })
    await act(async () => {})

    expect(result.current.config.autoLockTime).toBe(30)
    expect(backend.sets()).toEqual([['autoLockTime', 30]])
  })
})

describe('useAppConfig', () => {
  it('throws when used outside provider', () => {
    expect(() => {
      renderHook(() => useAppConfig())
    }).toThrow('useAppConfig must be used within AppConfigProvider')
  })
})
