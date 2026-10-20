import { useState, useEffect, useRef, useCallback } from 'react'
import { useAppConfig } from './useAppConfig'
import type { AppNotification } from '../../shared/types/notification'

interface StartupNotificationState {
  visible: boolean
  /** True once the startup fetch has finished, whatever it found: the
   *  update check (useUpdateCheck) waits for it so the two modals never
   *  show at once. */
  settled: boolean
  notifications: AppNotification[]
  dismiss: () => void
}

export function useStartupNotification(): StartupNotificationState {
  const appConfig = useAppConfig()
  const [visible, setVisible] = useState(false)
  const [settled, setSettled] = useState(false)
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (appConfig.loading || fetchedRef.current) return
    fetchedRef.current = true

    let cancelled = false
    let finished = false
    window.vialAPI.notificationFetch().then((result) => {
      if (cancelled) return
      if (!result.success || !result.notifications || result.notifications.length === 0) return

      const parsed = appConfig.config.lastNotificationSeen
        ? new Date(appConfig.config.lastNotificationSeen).getTime()
        : 0
      const lastSeenTs = Number.isNaN(parsed) ? 0 : parsed
      const filtered = result.notifications
        .filter((n) => new Date(n.publishedAt).getTime() > lastSeenTs)
        .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      if (filtered.length === 0) return

      setNotifications(filtered)
      setVisible(true)
    }).catch(() => {
      // Network errors are non-critical
    }).finally(() => {
      finished = true
      if (!cancelled) setSettled(true)
    })
    // A fetch cut off before it finished (StrictMode's mount, unmount and
    // mount again in development) is made again by the next run; a
    // finished one is not repeated.
    return () => {
      cancelled = true
      if (!finished) fetchedRef.current = false
    }
  }, [appConfig.loading, appConfig.config.lastNotificationSeen])

  const dismiss = useCallback(() => {
    setVisible(false)
    if (notifications.length > 0) {
      appConfig.set('lastNotificationSeen', notifications[0].publishedAt)
    }
  }, [notifications, appConfig])

  return { visible, settled, notifications, dismiss }
}
