import { useState, useEffect, useRef, useCallback } from 'react'
import { useAppConfig } from './useAppConfig'
import type { AppNotification } from '../../shared/types/notification'

interface StartupNotificationState {
  visible: boolean
  notifications: AppNotification[]
  dismiss: () => void
}

export function useStartupNotification(): StartupNotificationState {
  const appConfig = useAppConfig()
  const [visible, setVisible] = useState(false)
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (appConfig.loading || fetchedRef.current) return
    fetchedRef.current = true

    window.vialAPI.notificationFetch().then((result) => {
      if (!result.success || !result.notifications || result.notifications.length === 0) return

      const lastSeenTs = appConfig.config.lastNotificationSeen
        ? new Date(appConfig.config.lastNotificationSeen).getTime()
        : 0
      let filtered = result.notifications
      if (lastSeenTs > 0) {
        filtered = filtered.filter((n) => new Date(n.publishedAt).getTime() > lastSeenTs)
      }
      if (filtered.length === 0) return

      filtered.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      setNotifications(filtered)
      setVisible(true)
    }).catch(() => {
      // Network errors are non-critical
    })
  }, [appConfig.loading, appConfig.config.lastNotificationSeen])

  const dismiss = useCallback(() => {
    setVisible(false)
    if (notifications.length > 0) {
      appConfig.set('lastNotificationSeen', notifications[0].publishedAt)
    }
  }, [notifications, appConfig])

  return { visible, notifications, dismiss }
}
