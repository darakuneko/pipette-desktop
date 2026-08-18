// SPDX-License-Identifier: GPL-2.0-or-later
//
// Confirmation opened by the Security row's Lock button while REC (Typing
// Record) is armed. Locking while REC is armed would immediately re-trigger
// the unlock gate and reopen the inescapable UnlockDialog, so this modal
// disarms REC first and only then locks — see KeycodesOverlayPanel.

import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { ModalCloseButton } from './ModalCloseButton'
import { BTN_PRIMARY, BTN_SECONDARY } from '../../constants/ui-tokens'

interface LockRecOffConfirmModalProps {
  open: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function LockRecOffConfirmModal({
  open,
  onConfirm,
  onCancel,
}: LockRecOffConfirmModalProps): JSX.Element | null {
  const { t } = useTranslation()
  useEscapeClose(onCancel, open)

  if (!open) return null

  // Mounted via portal to document.body: the host panel
  // (KeymapPickerRegion's overlay wrapper) sits inside a container with a
  // Tailwind `translate-x-0` transform, which becomes the containing block
  // for `position: fixed` descendants, and the panel also toggles `inert`
  // while closed — either would break a plain in-tree fixed overlay.
  return createPortal(
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50"
      data-testid="lock-rec-confirm-backdrop"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="lock-rec-confirm-title"
        className="w-modal-md max-w-modal-vw rounded-lg bg-surface-alt p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="lock-rec-confirm-modal"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 id="lock-rec-confirm-title" className="text-lg font-semibold">
            {t('security.lockRecConfirmTitle')}
          </h3>
          <ModalCloseButton testid="lock-rec-confirm-close" onClick={onCancel} />
        </div>

        <p className="text-sm text-content" data-testid="lock-rec-confirm-body">
          {t('security.lockRecConfirmBody')}
        </p>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className={BTN_SECONDARY}
            onClick={onCancel}
            data-testid="lock-rec-confirm-cancel"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={onConfirm}
            data-testid="lock-rec-confirm-confirm"
          >
            {t('security.lock')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
