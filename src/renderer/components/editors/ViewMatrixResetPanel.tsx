// SPDX-License-Identifier: GPL-2.0-or-later

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
// Second consumer of the settings-modal 2-step confirm (fully prop-driven,
// so the domain name is the only oddity). If a third consumer appears,
// extract it to a generically named shared component instead.
import { DisconnectConfirmButton } from '../settings-modal/DisconnectConfirmButton'

export interface ViewMatrixResetPanelProps {
  onReset: () => void
}

/**
 * Replaces the layer selector panel while View Matrix mode is active — layer
 * switching is disabled for the duration of the mode (see
 * `useViewMatrixMode`), so the same slot instead offers a 2-step confirm
 * (mirrors `DisconnectConfirmButton`'s existing pattern) to clear the saved
 * position overrides and fall back to the physical Vial matrix.
 */
export function ViewMatrixResetPanel({ onReset }: ViewMatrixResetPanelProps) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)

  return (
    <div
      className="flex w-44 shrink-0 flex-col gap-2 rounded-xl border border-edge bg-picker-bg p-3"
      data-testid="view-matrix-reset-panel"
    >
      <p className="text-xs text-content-secondary">{t('editor.viewMatrix.label')}</p>
      <DisconnectConfirmButton
        confirming={confirming}
        onRequestConfirm={() => setConfirming(true)}
        onCancelConfirm={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); onReset() }}
        disconnectLabelKey="editor.viewMatrix.reset"
        confirmLabelKey="common.confirmReset"
        disconnectTestId="view-matrix-reset-button"
        confirmTestId="view-matrix-reset-confirm-button"
        cancelTestId="view-matrix-reset-cancel-button"
      />
    </div>
  )
}
