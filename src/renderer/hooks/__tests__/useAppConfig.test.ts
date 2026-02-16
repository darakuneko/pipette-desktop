// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAppConfig } from '../useAppConfig'
import { setupAppConfigMock, renderHookWithConfig } from './test-helpers'
import { DEFAULT_APP_CONFIG } from '../../../shared/types/app-config'

describe('useAppConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads config on mount', async () => {
    setupAppConfigMock({ theme: 'dark' })
    const { result } = renderHookWithConfig(() => useAppConfig())

    // Initially loading
    expect(result.current.loading).toBe(true)

    await act(async () => {})

    expect(result.current.loading).toBe(false)
    expect(result.current.config.theme).toBe('dark')
  })

  it('returns defaults when IPC fails', async () => {
    const mockGet = vi.fn().mockRejectedValue(new Error('fail'))
    Object.defineProperty(window, 'vialAPI', {
      value: {
        appConfigGetAll: mockGet,
        appConfigSet: vi.fn(),
      },
      writable: true,
      configurable: true,
    })

    const { result } = renderHookWithConfig(() => useAppConfig())
    await act(async () => {})

    expect(result.current.loading).toBe(false)
    expect(result.current.config).toEqual(DEFAULT_APP_CONFIG)
  })

  it('set updates state immediately and calls IPC', async () => {
    const { mockAppConfigSet } = setupAppConfigMock()
    const { result } = renderHookWithConfig(() => useAppConfig())
    await act(async () => {})

    act(() => {
      result.current.set('theme', 'dark')
    })

    expect(result.current.config.theme).toBe('dark')
    expect(mockAppConfigSet).toHaveBeenCalledWith('theme', 'dark')
  })

  it('set handles IPC failure gracefully', async () => {
    const mockSet = vi.fn().mockRejectedValue(new Error('write fail'))
    setupAppConfigMock()
    Object.defineProperty(window, 'vialAPI', {
      value: {
        ...((window as Record<string, unknown>).vialAPI as Record<string, unknown>),
        appConfigSet: mockSet,
      },
      writable: true,
      configurable: true,
    })

    const { result } = renderHookWithConfig(() => useAppConfig())
    await act(async () => {})

    // Should not throw
    act(() => {
      result.current.set('panelSide', 'right')
    })

    expect(result.current.config.panelSide).toBe('right')
  })

  it('throws when used outside provider', () => {
    expect(() => {
      renderHook(() => useAppConfig())
    }).toThrow('useAppConfig must be used within AppConfigProvider')
  })
})
