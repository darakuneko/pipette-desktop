// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { BTN_SECONDARY, BTN_DANGER_OUTLINE } from './settings-modal-shared'

export interface DisconnectConfirmButtonProps {
  confirming: boolean
  onRequestConfirm: () => void
  onCancelConfirm: () => void
  onConfirm: () => void
  disconnectLabelKey: string
  confirmLabelKey: string
  disconnectTestId: string
  confirmTestId: string
  cancelTestId: string
  warningKey?: string
  warningTestId?: string
}

export function DisconnectConfirmButton({
  confirming,
  onRequestConfirm,
  onCancelConfirm,
  onConfirm,
  disconnectLabelKey,
  confirmLabelKey,
  disconnectTestId,
  confirmTestId,
  cancelTestId,
  warningKey,
  warningTestId,
}: DisconnectConfirmButtonProps) {
  const { t } = useTranslation()

  if (confirming) {
    return (
      <div>
        <div className="flex items-center gap-2 justify-end">
          <button
            type="button"
            className={BTN_DANGER_OUTLINE}
            onClick={onConfirm}
            data-testid={confirmTestId}
          >
            {t(confirmLabelKey)}
          </button>
          <button
            type="button"
            className={BTN_SECONDARY}
            onClick={onCancelConfirm}
            data-testid={cancelTestId}
          >
            {t('common.cancel')}
          </button>
        </div>
        {warningKey && (
          <p className="mt-2 text-xs text-danger" data-testid={warningTestId}>
            {t(warningKey)}
          </p>
        )}
      </div>
    )
  }

  return (
    <button
      type="button"
      className={BTN_SECONDARY}
      onClick={onRequestConfirm}
      data-testid={disconnectTestId}
    >
      {t(disconnectLabelKey)}
    </button>
  )
}
