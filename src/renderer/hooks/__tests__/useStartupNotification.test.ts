// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// Runs against both vialAPI implementations (notification-backends.ts): a
// preload-like mock, and the Tauri shim's notification member over a
// mocked Tauri IPC. Both answer with the same spy.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from '@testing-library/react'
import { clearMocks } from '@tauri-apps/api/mocks'
import { useStartupNotification } from '../useStartupNotification'
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
    await act(async () => {})

    expect(result.current.visible).toBe(true)
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
  })

  it('hides modal when fetch fails', async () => {
    setupMocks({}, { success: false, error: 'Network error' })

    const { result } = renderHookWithConfig(() => useStartupNotification())
    await act(async () => {})

    expect(result.current.visible).toBe(false)
  })

  it('hides modal when no notifications', async () => {
    setupMocks({}, { success: true, notifications: [] })

    const { result } = renderHookWithConfig(() => useStartupNotification())
    await act(async () => {})

    expect(result.current.visible).toBe(false)
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
})
