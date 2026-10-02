// SPDX-License-Identifier: GPL-2.0-or-later
// Shown when a password-change lock on Google Drive pauses syncing and this
// machine has no change of its own. Releasing the lock is the only way out
// when the machine holding it never comes back, so it asks twice.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmResetRow } from '../data-modal/ConfirmResetRow'
import { formatDate } from '../editors/store-modal-shared'
import type { PasswordChangeLockStatus } from '../../../shared/types/sync'

export interface PasswordChangeLockBannerProps {
  lockStatus: PasswordChangeLockStatus
  running: boolean
  error: string | null
  onRelease: () => Promise<boolean>
}

export function PasswordChangeLockBanner({ lockStatus, running, error, onRelease }: PasswordChangeLockBannerProps) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  // A successful release removes the lock, which unmounts this banner.
  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const handleConfirm = async () => {
    if ((await onRelease()) && isMountedRef.current) setConfirming(false)
  }

  return (
    <div className="mb-4 space-y-2" data-testid="sync-password-change-lock">
      <div className="space-y-1 rounded border border-warning/30 bg-warning/10 px-2 py-1 text-xs text-warning">
        <div data-testid="sync-password-change-lock-message">
          {t(lockStatus.ownMachine ? 'sync.passwordChange.ownLockLeft' : 'sync.passwordChange.blockedByOtherDevice')}
        </div>
        {lockStatus.startedAt && (
          <div data-testid="sync-password-change-lock-started">
            {t('sync.passwordChange.lockStartedAt', { time: formatDate(lockStatus.startedAt) })}
          </div>
        )}
      </div>
      <ConfirmResetRow
        rowClassName="flex items-center justify-between gap-2 rounded border border-edge px-3 py-2"
        rowTestid="sync-password-change-release-row"
        labelClassName="text-sm text-content"
        label={t('sync.passwordChange.releaseLockLabel')}
        triggerLabel={t('sync.passwordChange.releaseLock')}
        confirmLabel={t('sync.passwordChange.confirmRelease')}
        cancelLabel={t('common.cancel')}
        warning={t('sync.passwordChange.releaseWarning')}
        confirming={confirming}
        busy={running}
        onTrigger={() => setConfirming(true)}
        onConfirm={() => void handleConfirm()}
        onCancel={() => setConfirming(false)}
        triggerTestid="sync-password-change-release"
        confirmTestid="sync-password-change-release-confirm"
        cancelTestid="sync-password-change-release-cancel"
      />
      {error && (
        <div className="text-xs text-danger" data-testid="sync-password-change-lock-error">{error}</div>
      )}
    </div>
  )
}
