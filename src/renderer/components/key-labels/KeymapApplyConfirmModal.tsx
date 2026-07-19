// SPDX-License-Identifier: GPL-2.0-or-later
//
// Confirmation shown when the footer's Key Label select switches to a
// pack whose map has been validated as a pure QWERTY-keycode permutation
// (see `buildKeymapRewriteTable` in shared/keymap/keymap-apply.ts). The
// user can additionally rewrite the actual keymap instead of only
// changing the display labels.

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
  /** Switch the display label only, keeping the keymap unchanged (today's behavior). */
  onDisplayOnly: () => void
  /** Close without changing the selection. */
  onCancel: () => void
}

export function KeymapApplyConfirmModal({
  open,
  labelName,
  onApply,
  onDisplayOnly,
  onCancel,
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

        <p className="text-sm text-content">{t('keyLabels.keymapApply.message')}</p>
        <p className="mt-2 text-sm text-content-secondary">{t('keyLabels.keymapApply.rewriteNote', { name: labelName })}</p>
        <p className="mt-2 text-sm text-content-secondary">{t('keyLabels.keymapApply.undoNote')}</p>
        <p
          className="mt-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-content-secondary"
          data-testid="keymap-apply-confirm-save-recommendation"
        >
          {t('keyLabels.keymapApply.saveRecommendation')}
        </p>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className={BTN_SECONDARY}
            onClick={onCancel}
            data-testid="keymap-apply-confirm-cancel"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={BTN_SECONDARY}
            onClick={onDisplayOnly}
            data-testid="keymap-apply-confirm-display-only"
          >
            {t('keyLabels.keymapApply.displayOnly')}
          </button>
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={onApply}
            data-testid="keymap-apply-confirm-apply"
          >
            {t('keyLabels.keymapApply.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
