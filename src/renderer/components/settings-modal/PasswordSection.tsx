// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { scoreColor, BTN_PRIMARY, BTN_SECONDARY, type PasswordMode } from './settings-modal-shared'
import type { UseSyncReturn } from '../../hooks/useSync'

export interface PasswordSectionProps {
  sync: UseSyncReturn
  password: string
  passwordScore: number | null
  passwordFeedback: string[]
  passwordError: string | null
  passwordMode: PasswordMode
  /** The stored password no longer opens the password-check on Google Drive. */
  passwordMismatch: boolean
  busy: boolean
  onPasswordChange: (value: string) => void
  onSetPassword: () => void
  onStartChange: () => void
  onCancelChange: () => void
  onStartReenter: () => void
}

export function PasswordSection({
  sync,
  password,
  passwordScore,
  passwordFeedback,
  passwordError,
  passwordMode,
  passwordMismatch,
  busy,
  onPasswordChange,
  onSetPassword,
  onStartChange,
  onCancelChange,
  onStartReenter,
}: PasswordSectionProps) {
  const { t } = useTranslation()
  const changingPassword = passwordMode === 'change'
  const reenteringPassword = passwordMode === 'reenter'

  if (sync.checkingRemotePassword) {
    return (
      <div className="flex items-center gap-2 rounded border border-accent/50 bg-accent/10 p-2 text-xs text-accent" data-testid="sync-checking-remote" role="status">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden="true" />
        {t('sync.checkingRemotePassword')}
      </div>
    )
  }

  if (sync.hasPassword && passwordMode === 'idle') {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm text-accent" data-testid="sync-password-set">
            {t('sync.passwordSet')}
          </span>
          <button
            type="button"
            className={BTN_SECONDARY}
            onClick={onStartChange}
            disabled={busy || !sync.authStatus.authenticated || sync.syncUnavailable}
            data-testid="sync-password-change-btn"
          >
            {t('sync.changePassword')}
          </button>
        </div>
        {passwordMismatch && (
          <div className="space-y-2" data-testid="sync-password-mismatch">
            <div className="rounded border border-warning/30 bg-warning/10 p-2 text-xs text-warning" data-testid="sync-password-mismatch-warning">
              {t('sync.reenterPasswordWarning')}
            </div>
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={onStartReenter}
              disabled={busy || !sync.authStatus.authenticated || sync.syncUnavailable}
              data-testid="sync-password-reenter-btn"
            >
              {t('sync.reenterPassword')}
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {busy && (
        <div className="flex items-center gap-2 rounded border border-accent/50 bg-accent/10 p-2 text-xs text-accent" data-testid="sync-password-busy" role="status">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden="true" />
          {t(changingPassword ? 'sync.changingPassword' : 'sync.settingPassword')}
        </div>
      )}
      {!busy && changingPassword && (
        <div className="rounded border border-accent/50 bg-accent/10 p-2 text-xs text-accent" data-testid="sync-change-password-info">
          {t('sync.changePasswordInfo')}
        </div>
      )}
      {!busy && changingPassword && (
        <div className="rounded border border-warning/30 bg-warning/10 p-2 text-xs text-warning" data-testid="sync-change-password-close-others">
          {t('sync.passwordChange.closeOtherPcs')}
        </div>
      )}
      {!busy && (reenteringPassword || (!changingPassword && sync.hasRemotePassword === true)) && (
        <div className="rounded border border-accent/50 bg-accent/10 p-2 text-xs text-accent" data-testid="sync-existing-password-hint">
          {t('sync.existingPasswordHint')}
        </div>
      )}
      <input
        type="password"
        className="w-full rounded border border-edge bg-surface px-3 py-2 text-sm text-content focus:border-accent focus:outline-none disabled:opacity-50"
        placeholder={t('sync.passwordPlaceholder')}
        value={password}
        onChange={(e) => onPasswordChange(e.target.value)}
        disabled={busy || sync.syncUnavailable}
        data-testid="sync-password-input"
      />
      {passwordScore !== null && !busy && !reenteringPassword && (
        <div className="space-y-1">
          <div className="flex gap-1">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className={`h-1.5 flex-1 rounded ${i <= passwordScore ? scoreColor(passwordScore) : 'bg-surface-dim'}`}
              />
            ))}
          </div>
          {passwordFeedback.map((fb, i) => (
            <div key={i} className="text-xs text-content-muted">
              {fb}
            </div>
          ))}
        </div>
      )}
      {passwordError && (
        <div className="text-xs text-danger" data-testid="sync-password-error">{passwordError}</div>
      )}
      {!busy && (
        <div className="flex gap-2">
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={onSetPassword}
            disabled={!password || (!reenteringPassword && passwordScore !== null && passwordScore < 4) || sync.syncUnavailable}
            data-testid="sync-password-save"
          >
            {t('sync.setPassword')}
          </button>
          {passwordMode !== 'idle' && (
            <button
              type="button"
              className="rounded border border-edge px-4 py-2 text-sm text-content-secondary hover:bg-surface-dim"
              onClick={onCancelChange}
              data-testid="sync-password-reset-cancel"
            >
              {t('common.cancel')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
