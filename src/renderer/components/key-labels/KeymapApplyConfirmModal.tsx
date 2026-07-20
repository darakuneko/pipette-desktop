// SPDX-License-Identifier: GPL-2.0-or-later
//
// Confirmation opened by the simulation tab's Apply button (Plan-qwerty-
// select-no-rewrite v7 — シミュレーションタブ方式) once the active Key Label
// pack's map has been validated as a pure QWERTY-keycode permutation (see
// `buildKeymapRewriteTable` in shared/keymap/keymap-apply.ts). Rewrite is
// the only affirmative action left here — simulated viewing is the tabs'
// job now, not a modal button, so this is a plain Cancel / Rewrite choice.

import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { ModalCloseButton } from '../editors/ModalCloseButton'
import { BTN_PRIMARY, BTN_SECONDARY } from '../../constants/ui-tokens'

interface KeymapApplyConfirmModalProps {
  open: boolean
  /** Display name of the Key Label pack being switched to. */
  labelName: string
  /** Rewrite the keymap and switch the display label. */
  onApply: () => void
  /** Close without changing the selection. */
  onCancel: () => void
  /** True while a Confirm apply is in flight (`useKeymapApplyPrompt`'s
   *  `isApplying`). Disables both footer buttons so a double-click on
   *  Apply can't fire a second rewrite while the first is still awaiting
   *  `onApplyKeymapRewrite` — the hook itself also guards against this
   *  (its own no-op re-entrancy check), this is the visible half. */
  busy?: boolean
}

export function KeymapApplyConfirmModal({
  open,
  labelName,
  onApply,
  onCancel,
  busy = false,
}: KeymapApplyConfirmModalProps): JSX.Element | null {
  const { t } = useTranslation()
  useEscapeClose(onCancel, open)

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50"
      data-testid="keymap-apply-confirm-backdrop"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="keymap-apply-confirm-title"
        className="w-modal-md max-w-modal-vw rounded-lg bg-surface-alt p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="keymap-apply-confirm-modal"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 id="keymap-apply-confirm-title" className="text-lg font-semibold">
            {t('keyLabels.keymapApply.title', { name: labelName })}
          </h3>
          <ModalCloseButton testid="keymap-apply-confirm-close" onClick={onCancel} />
        </div>

        <p className="text-sm text-content" data-testid="keymap-apply-confirm-save-recommendation">
          {t('keyLabels.keymapApply.saveRecommendation')}
        </p>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className={BTN_SECONDARY}
            onClick={onCancel}
            disabled={busy}
            data-testid="keymap-apply-confirm-cancel"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={onApply}
            disabled={busy}
            data-testid="keymap-apply-confirm-apply"
          >
            {t('keyLabels.keymapApply.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
