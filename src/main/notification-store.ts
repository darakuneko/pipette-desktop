import { net } from 'electron'
import { IpcChannels } from '../shared/ipc/channels'
import type { AppNotification, NotificationFetchResult } from '../shared/types/notification'
import { log } from './logger'
import { secureHandle } from './ipc-guard'

const NOTIFICATION_ENDPOINT = 'https://getnotifications-svtx62766a-uc.a.run.app'

interface FirestoreTimestamp {
  _seconds: number
  _nanoseconds: number
}

function isFirestoreTimestamp(value: unknown): value is FirestoreTimestamp {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return typeof obj._seconds === 'number' && typeof obj._nanoseconds === 'number'
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === 'string') return value
  if (isFirestoreTimestamp(value)) return new Date(value._seconds * 1000).toISOString()
  return new Date(0).toISOString()
}

interface RawNotification {
  title: string
  body: string
  type: string
  publishedAt: string | FirestoreTimestamp
}

function isValidNotification(item: unknown): item is RawNotification {
  if (typeof item !== 'object' || item === null) return false
  const obj = item as Record<string, unknown>
  return (
    typeof obj.title === 'string' &&
    typeof obj.body === 'string' &&
    typeof obj.type === 'string' &&
    (typeof obj.publishedAt === 'string' || isFirestoreTimestamp(obj.publishedAt))
  )
}

function normalizeNotification(raw: RawNotification): AppNotification {
  return {
    title: raw.title,
    body: raw.body,
    type: raw.type,
    publishedAt: normalizeTimestamp(raw.publishedAt),
  }
}

export async function fetchNotifications(): Promise<NotificationFetchResult> {
  try {
    const payload = {
      deviceId: 'all',
      type: 'notification',
      collection: 'pipette-notification',
      filters: [
        { field: 'publishedAt', op: '<=', value: Date.now() },
      ],
      orderBy: { field: 'publishedAt', direction: 'desc' },
      limit: 10,
    }

    const response = await net.fetch(NOTIFICATION_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      log('warn', `Notification fetch failed: HTTP ${response.status}`)
      return { success: false, error: `HTTP ${response.status}` }
    }
    const data = await response.json() as Record<string, unknown>
    const rawList = data.notifications
    if (!Array.isArray(rawList)) {
      log('warn', 'Notification fetch: response.notifications is not an array')
      return { success: false, error: 'Invalid response format' }
    }
    const notifications = rawList.filter(isValidNotification).map(normalizeNotification)
    return { success: true, notifications }
  } catch (err) {
    log('warn', `Notification fetch error: ${err}`)
    return { success: false, error: String(err) }
  }
}

export function setupNotificationStore(): void {
  secureHandle(IpcChannels.NOTIFICATION_FETCH, fetchNotifications)
}
