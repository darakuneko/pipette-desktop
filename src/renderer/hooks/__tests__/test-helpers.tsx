// SPDX-License-Identifier: GPL-2.0-or-later

import { createElement, type ReactNode } from 'react'
import { renderHook, type RenderHookOptions } from '@testing-library/react'
import { AppConfigProvider } from '../useAppConfig'
import { DEFAULT_APP_CONFIG, type AppConfig } from '../../../shared/types/app-config'
import { vi } from 'vitest'

const mockAppConfigGetAll = vi.fn<() => Promise<AppConfig>>()
const mockAppConfigSet = vi.fn<(key: string, value: unknown) => Promise<void>>()

export function setupAppConfigMock(overrides: Partial<AppConfig> = {}): {
  mockAppConfigGetAll: typeof mockAppConfigGetAll
  mockAppConfigSet: typeof mockAppConfigSet
} {
  const config = { ...DEFAULT_APP_CONFIG, ...overrides }
  mockAppConfigGetAll.mockResolvedValue(config)
  mockAppConfigSet.mockResolvedValue(undefined)

  const existing = (window as Record<string, unknown>).vialAPI as Record<string, unknown> | undefined
  Object.defineProperty(window, 'vialAPI', {
    value: {
      ...existing,
      appConfigGetAll: mockAppConfigGetAll,
      appConfigSet: mockAppConfigSet,
    },
    writable: true,
    configurable: true,
  })

  return { mockAppConfigGetAll, mockAppConfigSet }
}

function createWrapper(extraWrapper?: React.ComponentType<{ children: ReactNode }>) {
  return function Wrapper({ children }: { children: ReactNode }): ReactNode {
    const inner = extraWrapper
      ? createElement(extraWrapper, null, children)
      : children
    return createElement(AppConfigProvider, null, inner)
  }
}

export function renderHookWithConfig<TResult>(
  hook: () => TResult,
  options?: Omit<RenderHookOptions<unknown>, 'wrapper'>,
): ReturnType<typeof renderHook<TResult, unknown>> {
  return renderHook(hook, {
    ...options,
    wrapper: createWrapper(),
  })
}
