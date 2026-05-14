// SPDX-License-Identifier: GPL-2.0-or-later
//
// Modal that lists the keys a language pack does not yet translate
// (relative to bundled English) and lets the user download a JSON
// template containing only those keys with the English fallback as
// the value. The user edits the template and re-imports it via the
// outer Languages modal.

import { useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ModalCloseButton } from '../editors/ModalCloseButton'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { buildSubsetFromKeys } from '../../../shared/i18n/coverage'
import { downloadJson } from '../../utils/download-json'

export interface MissingKeysModalProps {
  open: boolean
  onClose: () => void
  /** Display name of the pack (used in the title and the export filename). */
  packName: string
  /** Sorted list of dot-separated key paths missing in the pack. */
  missingKeys: readonly string[]
  /** English pack body — values copied to the exported template so the
   * user has the canonical text to translate against. */
  base: unknown
}

export function MissingKeysModal({
  open,
  onClose,
  packName,
  missingKeys,
  base,
}: MissingKeysModalProps): JSX.Element | null {
  const { t } = useTranslation()
  useEscapeClose(onClose, open)

  const handleExport = useCallback(() => {
    const subset = buildSubsetFromKeys(base, missingKeys)
    // Tag the template's `name` so re-importing it does NOT auto-overwrite
    // the original pack via savePack's same-name overwrite path.
    const payload = { name: `${packName} (template)`, version: '0.0.0', ...subset }
    downloadJson(`${packName}-missing`, payload, { prefix: 'i18n-packs' })
  }, [base, missingKeys, packName])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50"
      data-testid="missing-keys-modal-backdrop"
      onClick={(e) => {
        // Stop the click bubbling into the parent Languages modal —
        // its own backdrop handler would otherwise close it too.
        e.stopPropagation()
        onClose()
      }}
    >
      <div
        className="w-modal-md max-w-[90vw] h-modal-70vh flex flex-col rounded-lg bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="missing-keys-modal"
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 className="text-base font-semibold text-content">
            {t('i18n.missingKeys.title')}: {packName}
          </h2>
          <ModalCloseButton testid="missing-keys-modal-close" onClick={onClose} />
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-edge px-4 py-2">
          <p className="flex-1 min-w-0 text-xs text-content-muted">
            {t('i18n.missingKeys.description')}
          </p>
          <button
            type="button"
            disabled={missingKeys.length === 0}
            onClick={handleExport}
            className="shrink-0 rounded border border-edge bg-surface px-3 py-1.5 text-sm font-medium text-content hover:bg-surface-hover disabled:opacity-50"
            data-testid="missing-keys-modal-export"
          >
            {t('keyLabels.actionExport')}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-2">
          {missingKeys.length === 0 ? (
            <p className="py-4 text-center text-sm text-content-muted" data-testid="missing-keys-modal-empty">
              {t('i18n.missingKeys.empty')}
            </p>
          ) : (
            <ul className="space-y-1 text-xs text-content" data-testid="missing-keys-modal-list">
              {missingKeys.map((key) => (
                <li key={key} className="font-mono break-all">{key}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
