// SPDX-License-Identifier: GPL-2.0-or-later

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
// Second consumer of the settings-modal 2-step confirm (fully prop-driven,
// so the domain name is the only oddity). If a third consumer appears,
// extract it to a generically named shared component instead.
import { DisconnectConfirmButton } from '../settings-modal/DisconnectConfirmButton'

export interface ViewMatrixPanelProps {
  onReset: () => void
  /** Exits View Matrix mode. The keycode picker (and with it the overlay
   *  panel's own Edit/Done button) is hidden for the duration of the mode,
   *  so this panel's toggle — rendered permanently in its ON ("Done")
   *  state while mounted — is the only way back to normal editing. */
  onToggle: () => void
}

/**
 * Replaces the layer selector panel while View Matrix mode is active — layer
 * switching is disabled for the duration of the mode (see
 * `useViewMatrixMode`), and the keycode picker area is hidden entirely, so
 * this panel becomes the mode's whole left pane: the mode label, the Edit
 * toggle that exits the mode, and a 2-step confirm (mirrors
 * `DisconnectConfirmButton`'s existing pattern) to clear the saved position
 * overrides and fall back to the physical Vial matrix.
 */
export function ViewMatrixPanel({ onReset, onToggle }: ViewMatrixPanelProps) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)

  return (
    <div
      className="flex w-44 shrink-0 flex-col gap-2 rounded-xl border border-edge bg-picker-bg p-3"
      data-testid="view-matrix-reset-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-content-secondary">{t('editor.viewMatrix.label')}</p>
        <button
          type="button"
          aria-pressed={true}
          className="rounded border border-edge px-2 py-1 text-xs text-content-secondary hover:bg-surface-dim"
          onClick={onToggle}
          data-testid="view-matrix-mode-toggle"
        >
          {t('editor.viewMatrix.done')}
        </button>
      </div>
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
