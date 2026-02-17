import { useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ModalCloseButton } from './editors/ModalCloseButton'
import type { AppNotification } from '../../shared/types/notification'

interface NotificationModalProps {
  notifications: AppNotification[]
  onClose: () => void
}

export function NotificationModal({ notifications, onClose }: NotificationModalProps) {
  const { t } = useTranslation()

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="notification-modal-backdrop"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[90vw] max-h-[80vh] overflow-y-auto rounded-lg bg-surface-alt p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{t('notification.title')}</h3>
          <ModalCloseButton testid="notification-modal-close" onClick={onClose} />
        </div>
        <div className="space-y-4">
          {notifications.map((notification, index) => (
            <div key={`${notification.publishedAt}-${index}`} className="rounded-md border border-surface-dim p-4">
              <div className="mb-2 flex items-center gap-2">
                <span className="font-medium">{notification.title}</span>
                <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent">
                  {notification.type}
                </span>
              </div>
              <p className="whitespace-pre-line text-sm text-content-secondary">
                {notification.body}
              </p>
              <p className="mt-2 text-xs text-content-tertiary">
                {new Date(notification.publishedAt).toLocaleDateString()}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
