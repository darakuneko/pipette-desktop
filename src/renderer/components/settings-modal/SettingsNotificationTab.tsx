// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { formatDateShort } from '../editors/store-modal-shared'
import type { AppNotification } from '../../../shared/types/notification'

export interface SettingsNotificationTabProps {
  recentNotifications: AppNotification[]
  notificationLoading: boolean
}

export function SettingsNotificationTab({ recentNotifications, notificationLoading }: SettingsNotificationTabProps) {
  const { t } = useTranslation()

  return (
    <div className="pt-4" aria-live="polite" data-testid="notification-tab-content">
      {notificationLoading ? (
        <p className="text-sm text-content-muted">{t('common.loading')}</p>
      ) : recentNotifications.length === 0 ? (
        <p className="text-sm text-content-muted" data-testid="notification-empty">
          {t('notification.empty')}
        </p>
      ) : (
        <ul className="space-y-4">
          {recentNotifications.map((notification, index) => (
            <li key={`${notification.publishedAt}-${index}`} className="rounded-md border border-edge p-4">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-medium text-content">{notification.title}</span>
                <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent">
                  {t(`notification.type.${notification.type}`, { defaultValue: notification.type })}
                </span>
              </div>
              <p className="whitespace-pre-line text-sm text-content-secondary">
                {notification.body}
              </p>
              <time className="mt-2 block text-xs text-content-muted" dateTime={notification.publishedAt}>
                {formatDateShort(notification.publishedAt)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
