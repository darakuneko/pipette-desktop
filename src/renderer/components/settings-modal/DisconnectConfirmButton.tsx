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
  /** Stacks the confirm-state buttons vertically (full width) instead of the
   *  default side-by-side layout. Needed by narrow hosts — e.g. `ViewMatrixPanel`'s
   *  11rem left pane — where side-by-side buttons wrap long i18n labels to
   *  three lines. Also widens the single trigger button to full width for the
   *  same reason. */
  stacked?: boolean
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
  stacked = false,
}: DisconnectConfirmButtonProps) {
  const { t } = useTranslation()
  const btnClass = (base: string): string => (stacked ? `${base} w-full` : base)

  if (confirming) {
    return (
      <div>
        <div className={stacked ? 'flex flex-col gap-2' : 'flex items-center gap-2 justify-end'}>
          <button
            type="button"
            className={btnClass(BTN_DANGER_OUTLINE)}
            onClick={onConfirm}
            data-testid={confirmTestId}
          >
            {t(confirmLabelKey)}
          </button>
          <button
            type="button"
            className={btnClass(BTN_SECONDARY)}
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
      className={btnClass(BTN_SECONDARY)}
      onClick={onRequestConfirm}
      data-testid={disconnectTestId}
    >
      {t(disconnectLabelKey)}
    </button>
  )
}
