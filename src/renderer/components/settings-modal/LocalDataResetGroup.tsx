// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { BTN_SECONDARY, BTN_DANGER_OUTLINE } from './settings-modal-shared'
import type { LocalResetTargets, StoredKeyboardInfo } from '../../../shared/types/sync'

export interface LocalDataResetGroupProps {
  storedKeyboards: StoredKeyboardInfo[]
  selectedKeyboardUids: Set<string>
  onToggleKeyboard: (uid: string, checked: boolean) => void
  localTargets: LocalResetTargets
  onToggleTarget: (key: string, checked: boolean) => void
  disabled: boolean
  confirming: boolean
  onRequestConfirm: () => void
  onCancelConfirm: () => void
  onConfirm: () => void
  busy: boolean
  confirmDisabled: boolean
}

export function LocalDataResetGroup({
  storedKeyboards,
  selectedKeyboardUids,
  onToggleKeyboard,
  localTargets,
  onToggleTarget,
  disabled,
  confirming,
  onRequestConfirm,
  onCancelConfirm,
  onConfirm,
  busy,
  confirmDisabled,
}: LocalDataResetGroupProps) {
  const { t } = useTranslation()
  const anySelected = selectedKeyboardUids.size > 0 || localTargets.favorites || localTargets.appSettings

  return (
    <div className="space-y-2">
      {/* Keyboard Data — individual keyboards */}
      {storedKeyboards.length > 0 && (
        <div>
          <span className="text-sm text-content-muted">{t('sync.resetTarget.keyboardData')}</span>
          <div className="ml-4 mt-1 space-y-1">
            {storedKeyboards.map((kb) => (
              <label key={kb.uid} className="flex items-center gap-2 text-sm text-content" data-testid={`local-target-keyboard-${kb.uid}`}>
                <input
                  type="checkbox"
                  checked={selectedKeyboardUids.has(kb.uid)}
                  onChange={(e) => onToggleKeyboard(kb.uid, e.target.checked)}
                  disabled={disabled}
                  className="accent-danger"
                />
                {kb.name}
              </label>
            ))}
          </div>
        </div>
      )}
      {/* Favorites & App Settings */}
      <label className="flex items-center gap-2 text-sm text-content" data-testid="local-target-favorites">
        <input
          type="checkbox"
          checked={localTargets.favorites}
          onChange={(e) => onToggleTarget('favorites', e.target.checked)}
          disabled={disabled}
          className="accent-danger"
        />
        {t('sync.resetTarget.favorites')}
      </label>
      <label className="flex items-center gap-2 text-sm text-content" data-testid="local-target-appSettings">
        <input
          type="checkbox"
          checked={localTargets.appSettings}
          onChange={(e) => onToggleTarget('appSettings', e.target.checked)}
          disabled={disabled}
          className="accent-danger"
        />
        {t('sync.resetTarget.appSettings')}
      </label>
      {/* Delete button */}
      <div className="flex items-center justify-end">
        <button
          type="button"
          className={BTN_DANGER_OUTLINE}
          onClick={onRequestConfirm}
          disabled={disabled || !anySelected}
          data-testid="reset-local-data"
        >
          {t('sync.deleteSelected')}
        </button>
      </div>
      {confirming && (
        <div className="space-y-2">
          <div
            className="rounded border border-danger/50 bg-danger/10 p-2 text-xs text-danger"
            data-testid="reset-local-data-warning"
          >
            {t('sync.resetLocalTargetsConfirm')}
          </div>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={onCancelConfirm}
              disabled={busy}
              data-testid="reset-local-data-cancel"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="rounded bg-danger px-3 py-1 text-sm font-medium text-white hover:bg-danger/90 disabled:opacity-50"
              onClick={onConfirm}
              disabled={confirmDisabled || !anySelected}
              data-testid="reset-local-data-confirm"
            >
              {t('sync.deleteSelected')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
