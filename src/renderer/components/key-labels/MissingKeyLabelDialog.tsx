// SPDX-License-Identifier: GPL-2.0-or-later
//
// Notice shown on keyboard connect when the saved keyboardLayout is no
// longer present in the local Key Label store (e.g. after the qwerty-only
// migration). The user can jump to Settings → Tools → Key Labels to
// download the missing label, or close and continue with the QWERTY
// fallback that `useDevicePrefs` already produces.

import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { ModalCloseButton } from '../editors/ModalCloseButton'

interface MissingKeyLabelDialogProps {
  open: boolean
  /** Layout id / display name that was missing from the local store. */
  missingName: string
  onClose: () => void
}

export function MissingKeyLabelDialog({
  open,
  missingName,
  onClose,
}: MissingKeyLabelDialogProps): JSX.Element | null {
  const { t } = useTranslation()
  useEscapeClose(onClose, open)

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      data-testid="missing-key-label-backdrop"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="missing-key-label-title"
        className="w-full max-w-xl rounded-lg bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="missing-key-label-dialog"
      >
        <div className="flex items-center justify-between mb-3">
          <h3 id="missing-key-label-title" className="text-base font-semibold text-content">
            {t('keyLabels.missingTitle')}
          </h3>
          <ModalCloseButton testid="missing-key-label-close" onClick={onClose} />
        </div>
        <p className="text-sm text-content mb-2">
          {t('keyLabels.missingMessage', { name: missingName })}
        </p>
        <p className="text-sm text-content-secondary mb-4">
          {t('keyLabels.missingHint', {
            name: missingName,
            settings: t('settings.title'),
            tools: t('settings.tabTools'),
            keyLabels: t('keyLabels.manageRow'),
          })}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-edge bg-surface px-3 py-1.5 text-sm font-medium text-content hover:bg-surface-hover"
            data-testid="missing-key-label-close-button"
          >
            {t('keyLabels.missingClose')}
          </button>
        </div>
      </div>
    </div>
  )
}
