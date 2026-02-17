import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockHandlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mockHandlers.set(channel, handler)
    }),
  },
  net: {
    fetch: vi.fn(),
  },
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
}))

vi.mock('../ipc-guard', () => ({
  secureHandle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    mockHandlers.set(channel, handler)
  }),
}))

import { net } from 'electron'
import { fetchNotifications, setupNotificationStore } from '../notification-store'

const mockFetch = vi.mocked(net.fetch)

function wrapResponse(notifications: unknown[]): { notifications: unknown[] } {
  return { notifications }
}

describe('fetchNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHandlers.clear()
  })

  it('sends POST request with query payload', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(wrapResponse([])),
    })

    await fetchNotifications()

    expect(mockFetch).toHaveBeenCalledWith(
      'https://getnotifications-svtx62766a-uc.a.run.app',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.collection).toBe('pipette-notification')
    expect(body.orderBy).toEqual({ field: 'publishedAt', direction: 'desc' })
    expect(body.limit).toBe(10)
  })

  it('returns notifications on successful fetch', async () => {
    const notifications = [
      { title: 'Update', body: 'New version', type: 'Info', publishedAt: '2025-01-01T00:00:00Z' },
      { title: 'Maintenance', body: 'Scheduled', type: 'Warning', publishedAt: '2025-01-02T00:00:00Z' },
    ]
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(wrapResponse(notifications)),
    })

    const result = await fetchNotifications()
    expect(result.success).toBe(true)
    expect(result.notifications).toEqual(notifications)
  })

  it('converts Firestore Timestamp to ISO string', async () => {
    const notifications = [
      { title: 'TS', body: 'Body', type: 'Info', publishedAt: { _seconds: 1735689600, _nanoseconds: 0 } },
    ]
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(wrapResponse(notifications)),
    })

    const result = await fetchNotifications()
    expect(result.success).toBe(true)
    expect(result.notifications).toHaveLength(1)
    expect(result.notifications![0].publishedAt).toBe(new Date(1735689600 * 1000).toISOString())
  })

  it('returns empty array for empty response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(wrapResponse([])),
    })

    const result = await fetchNotifications()
    expect(result.success).toBe(true)
    expect(result.notifications).toEqual([])
  })

  it('returns failure on HTTP error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    })

    const result = await fetchNotifications()
    expect(result.success).toBe(false)
    expect(result.error).toBe('HTTP 500')
  })

  it('returns failure on network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network failure'))

    const result = await fetchNotifications()
    expect(result.success).toBe(false)
    expect(result.error).toContain('Network failure')
  })

  it('filters out invalid notification objects', async () => {
    const data = [
      { title: 'Valid', body: 'Body', type: 'Info', publishedAt: '2025-01-01T00:00:00Z' },
      { title: 'Missing body' },
      null,
      'not an object',
      { title: 123, body: 'Body', type: 'Info', publishedAt: '2025-01-01T00:00:00Z' },
    ]
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(wrapResponse(data)),
    })

    const result = await fetchNotifications()
    expect(result.success).toBe(true)
    expect(result.notifications).toHaveLength(1)
    expect(result.notifications![0].title).toBe('Valid')
  })

  it('returns failure when response.notifications is not an array', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: 'not wrapped' }),
    })

    const result = await fetchNotifications()
    expect(result.success).toBe(false)
    expect(result.error).toBe('Invalid response format')
  })

  it('accepts Firestore Timestamp in validation', async () => {
    const data = [
      { title: 'TS', body: 'Body', type: 'Info', publishedAt: { _seconds: 1700000000, _nanoseconds: 500 } },
      { title: 'Str', body: 'Body', type: 'Info', publishedAt: '2025-01-01T00:00:00Z' },
      { title: 'Bad', body: 'Body', type: 'Info', publishedAt: 12345 },
    ]
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(wrapResponse(data)),
    })

    const result = await fetchNotifications()
    expect(result.success).toBe(true)
    expect(result.notifications).toHaveLength(2)
  })
})

describe('setupNotificationStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHandlers.clear()
  })

  it('registers IPC handler for notification:fetch', () => {
    setupNotificationStore()
    expect(mockHandlers.has('notification:fetch')).toBe(true)
  })

  it('IPC handler returns fetch result', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(wrapResponse([])),
    })

    setupNotificationStore()
    const handler = mockHandlers.get('notification:fetch')!
    const result = await handler()
    expect(result).toEqual({ success: true, notifications: [] })
  })
})
