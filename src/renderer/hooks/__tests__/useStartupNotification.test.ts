// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// Runs against both vialAPI implementations (notification-backends.ts): a
// plain mock, and the Tauri shim's notification member over a
// mocked Tauri IPC. Both answer with the same spy.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { act, render } from '@testing-library/react'
import { clearMocks } from '@tauri-apps/api/mocks'
import { useStartupNotification } from '../useStartupNotification'
import { AppConfigProvider, useAppConfig } from '../useAppConfig'
import { setupAppConfigMock, renderHookWithConfig, vialAPIMock } from './test-helpers'
import { notificationBackends, type NotificationBackend } from './notification-backends'
import type { NotificationFetchResult } from '../../../shared/types/notification'

const mockNotificationFetch = vi.fn<() => Promise<NotificationFetchResult>>()

let backend: NotificationBackend

function setupMocks(
  configOverrides: Record<string, unknown> = {},
  fetchResult?: NotificationFetchResult,
) {
  const mocks = setupAppConfigMock(configOverrides)
  mockNotificationFetch.mockResolvedValue(
    fetchResult ?? { success: true, notifications: [] },
  )
  backend.install(vialAPIMock())
  return mocks
}

afterEach(() => {
  clearMocks()
})

describe.each(notificationBackends(() => mockNotificationFetch()))('useStartupNotification ($name)', (current) => {
  beforeEach(() => {
    vi.clearAllMocks()
    backend = current
  })

  it('shows all notifications when lastNotificationSeen is not set', async () => {
    const notifications = [
      { title: 'A', body: 'Body A', type: 'Info', publishedAt: '2025-01-02T00:00:00Z' },
      { title: 'B', body: 'Body B', type: 'Info', publishedAt: '2025-01-01T00:00:00Z' },
    ]
    setupMocks({}, { success: true, notifications })

    const { result } = renderHookWithConfig(() => useStartupNotification())
    expect(result.current.settled).toBe(false)
    await act(async () => {})

    expect(result.current.visible).toBe(true)
    expect(result.current.settled).toBe(true)
    expect(result.current.notifications).toHaveLength(2)
  })

  it('shows only new notifications when lastNotificationSeen is set', async () => {
    const notifications = [
      { title: 'New', body: 'Body', type: 'Info', publishedAt: '2025-01-03T00:00:00Z' },
      { title: 'Old', body: 'Body', type: 'Info', publishedAt: '2025-01-01T00:00:00Z' },
    ]
    setupMocks(
      { lastNotificationSeen: '2025-01-02T00:00:00Z' },
      { success: true, notifications },
    )

    const { result } = renderHookWithConfig(() => useStartupNotification())
    await act(async () => {})

    expect(result.current.visible).toBe(true)
    expect(result.current.notifications).toHaveLength(1)
    expect(result.current.notifications[0].title).toBe('New')
  })

  it('hides modal when all notifications are old', async () => {
    const notifications = [
      { title: 'Old', body: 'Body', type: 'Info', publishedAt: '2025-01-01T00:00:00Z' },
    ]
    setupMocks(
      { lastNotificationSeen: '2025-01-02T00:00:00Z' },
      { success: true, notifications },
    )

    const { result } = renderHookWithConfig(() => useStartupNotification())
    await act(async () => {})

    expect(result.current.visible).toBe(false)
    expect(result.current.settled).toBe(true)
  })

  it('shows all notifications when lastNotificationSeen is malformed', async () => {
    const notifications = [
      { title: 'A', body: 'Body', type: 'Info', publishedAt: '2025-01-02T00:00:00Z' },
    ]
    setupMocks(
      { lastNotificationSeen: 'not-a-date' },
      { success: true, notifications },
    )

    const { result } = renderHookWithConfig(() => useStartupNotification())
    await act(async () => {})

    expect(result.current.visible).toBe(true)
    expect(result.current.notifications).toHaveLength(1)
  })

  it('hides modal when the fetch rejects', async () => {
    setupMocks()
    mockNotificationFetch.mockRejectedValue(new Error('Network error'))

    const { result } = renderHookWithConfig(() => useStartupNotification())
    await act(async () => {})

    expect(result.current.visible).toBe(false)
    expect(result.current.settled).toBe(true)
  })

  it('hides modal when fetch fails', async () => {
    setupMocks({}, { success: false, error: 'Network error' })

    const { result } = renderHookWithConfig(() => useStartupNotification())
    await act(async () => {})

    expect(result.current.visible).toBe(false)
    expect(result.current.settled).toBe(true)
  })

  it('hides modal when no notifications', async () => {
    setupMocks({}, { success: true, notifications: [] })

    const { result } = renderHookWithConfig(() => useStartupNotification())
    await act(async () => {})

    expect(result.current.visible).toBe(false)
    expect(result.current.settled).toBe(true)
  })

  it('dismiss hides modal and saves lastNotificationSeen', async () => {
    const notifications = [
      { title: 'Latest', body: 'Body', type: 'Info', publishedAt: '2025-01-03T00:00:00Z' },
      { title: 'Older', body: 'Body', type: 'Info', publishedAt: '2025-01-01T00:00:00Z' },
    ]
    const { mockAppConfigSet } = setupMocks({}, { success: true, notifications })

    const { result } = renderHookWithConfig(() => useStartupNotification())
    await act(async () => {})

    expect(result.current.visible).toBe(true)

    act(() => {
      result.current.dismiss()
    })

    expect(result.current.visible).toBe(false)
    expect(mockAppConfigSet).toHaveBeenCalledWith('lastNotificationSeen', '2025-01-03T00:00:00Z')
  })

  it('sorts notifications by publishedAt descending', async () => {
    const notifications = [
      { title: 'Middle', body: 'Body', type: 'Info', publishedAt: '2025-01-02T00:00:00Z' },
      { title: 'Latest', body: 'Body', type: 'Info', publishedAt: '2025-01-03T00:00:00Z' },
      { title: 'Oldest', body: 'Body', type: 'Info', publishedAt: '2025-01-01T00:00:00Z' },
    ]
    setupMocks({}, { success: true, notifications })

    const { result } = renderHookWithConfig(() => useStartupNotification())
    await act(async () => {})

    expect(result.current.notifications[0].title).toBe('Latest')
    expect(result.current.notifications[1].title).toBe('Middle')
    expect(result.current.notifications[2].title).toBe('Oldest')
  })

  it('settles and shows the notices under StrictMode, which runs the effect twice on mount', async () => {
    const notifications = [{ title: 'A', body: 'Body', type: 'Info', publishedAt: '2025-01-02T00:00:00Z' }]
    setupMocks({}, { success: true, notifications })
    let seen: ReturnType<typeof useStartupNotification> | null = null
    function Probe() {
      seen = useStartupNotification()
      return null
    }
    // Mounted once the config has loaded, so the first effect run starts
    // the fetch and StrictMode cuts it off.
    function Gate() {
      return useAppConfig().loading ? null : createElement(Probe)
    }
    render(createElement(AppConfigProvider, null, createElement(Gate)), { reactStrictMode: true })
    await act(async () => {})
    await act(async () => {})

    expect(seen).not.toBeNull()
    expect(seen!.settled).toBe(true)
    expect(seen!.visible).toBe(true)
  })

  it('does not fetch again once the fetch has finished', async () => {
    const notifications = [{ title: 'A', body: 'Body', type: 'Info', publishedAt: '2025-01-02T00:00:00Z' }]
    setupMocks({}, { success: true, notifications })

    const { result } = renderHookWithConfig(() => useStartupNotification())
    await act(async () => {})
    act(() => result.current.dismiss())
    await act(async () => {})

    expect(mockNotificationFetch).toHaveBeenCalledTimes(1)
    expect(result.current.visible).toBe(false)
    expect(result.current.settled).toBe(true)
  })
})
