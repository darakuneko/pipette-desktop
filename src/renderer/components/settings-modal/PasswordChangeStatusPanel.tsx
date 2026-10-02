// SPDX-License-Identifier: GPL-2.0-or-later
// Shown in place of the sync password row while this machine has an
// unfinished sync password change: what it is doing, and the ways out
// (continue, turn around, abandon, delete files neither password opens).

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmResetRow } from '../data-modal/ConfirmResetRow'
import { UndecryptableFilesList } from '../data-modal/UndecryptableFilesList'
import { BTN_PRIMARY, BTN_SECONDARY } from './settings-modal-shared'
import type { PasswordChangeStatus } from '../../../shared/types/sync'

type Confirming = { kind: 'abandon' } | { kind: 'file'; fileId: string }

export interface PasswordChangeStatusPanelProps {
  status: Exclude<PasswordChangeStatus, { kind: 'none' }>
  running: boolean
  error: string | null
  onResume: () => Promise<boolean>
  onRevert: () => Promise<boolean>
  onAbandon: () => Promise<boolean>
  onDeleteFile: (fileId: string) => Promise<boolean>
}

export function PasswordChangeStatusPanel({
  status,
  running,
  error,
  onResume,
  onRevert,
  onAbandon,
  onDeleteFile,
}: PasswordChangeStatusPanelProps) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState<Confirming | null>(null)
  // A successful action usually ends the change, which unmounts this panel.
  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const confirmThen = async (action: () => Promise<boolean>) => {
    if ((await action()) && isMountedRef.current) setConfirming(null)
  }

  const inProgress = status.kind === 'inProgress' ? status : null
  const undecryptable = inProgress?.undecryptable ?? []

  return (
    <div className="space-y-2" data-testid="sync-password-change-panel">
      {running && (
        <div className="flex items-center gap-2 rounded border border-accent/50 bg-accent/10 p-2 text-xs text-accent" data-testid="sync-password-change-running" role="status">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden="true" />
          {t('sync.passwordChange.working')}
        </div>
      )}
      <div className="space-y-1 rounded border border-warning/30 bg-warning/10 px-2 py-1 text-xs text-warning" data-testid="sync-password-change-state">
        {status.kind === 'invalid' ? (
          <div>{t('sync.passwordChange.invalidState')}</div>
        ) : (
          <>
            <div data-testid="sync-password-change-direction">
              {t(status.target === 'new' ? 'sync.passwordChange.toNew' : 'sync.passwordChange.toOld')}
            </div>
            <div data-testid="sync-password-change-step">
              {t('sync.passwordChange.stepLabel', { step: t(`sync.passwordChange.step.${status.step}`) })}
            </div>
            {status.kind === 'keysUnavailable' && <div>{t('sync.passwordChange.keysUnavailable')}</div>}
            {inProgress?.lockLost && <div data-testid="sync-password-change-lock-lost">{t('sync.passwordChange.lockLost')}</div>}
          </>
        )}
      </div>
      {error && (
        <div className="text-xs text-danger" data-testid="sync-password-change-error">{error}</div>
      )}
      {status.kind !== 'invalid' && (
        <div className="flex gap-2">
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={() => void onResume()}
            disabled={running}
            data-testid="sync-password-change-resume"
          >
            {t('sync.passwordChange.resume')}
          </button>
          {inProgress?.step === 'reencrypting' && (
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={() => void onRevert()}
              disabled={running}
              data-testid="sync-password-change-revert"
            >
              {t(inProgress.target === 'new' ? 'sync.passwordChange.revertToOld' : 'sync.passwordChange.revertToNew')}
            </button>
          )}
        </div>
      )}
      {undecryptable.length > 0 && (
        <div className="space-y-1" data-testid="sync-password-change-undecryptable">
          <div className="text-sm text-content-muted">{t('sync.passwordChange.undecryptable')}</div>
          <UndecryptableFilesList
            files={undecryptable.map((file) => ({ id: file.id, label: file.name }))}
            confirmingId={confirming?.kind === 'file' ? confirming.fileId : null}
            busy={running}
            onTrigger={(fileId) => setConfirming({ kind: 'file', fileId })}
            onConfirm={(fileId) => void confirmThen(() => onDeleteFile(fileId))}
            onCancel={() => setConfirming(null)}
            testids={{
              row: 'sync-password-change-file-',
              trigger: 'sync-password-change-file-delete-',
              confirm: 'sync-password-change-file-confirm-',
              cancel: 'sync-password-change-file-cancel-',
            }}
          />
        </div>
      )}
      <ConfirmResetRow
        rowClassName="flex items-center justify-between gap-2 rounded border border-edge px-3 py-2"
        rowTestid="sync-password-change-abandon-row"
        labelClassName="text-sm text-content"
        label={t('sync.passwordChange.abandonLabel')}
        triggerLabel={t('sync.passwordChange.abandon')}
        confirmLabel={t('sync.passwordChange.confirmAbandon')}
        cancelLabel={t('common.cancel')}
        warning={t('sync.passwordChange.abandonWarning')}
        confirming={confirming?.kind === 'abandon'}
        busy={running}
        onTrigger={() => setConfirming({ kind: 'abandon' })}
        onConfirm={() => void confirmThen(onAbandon)}
        onCancel={() => setConfirming(null)}
        triggerTestid="sync-password-change-abandon"
        confirmTestid="sync-password-change-abandon-confirm"
        cancelTestid="sync-password-change-abandon-cancel"
      />
    </div>
  )
}
