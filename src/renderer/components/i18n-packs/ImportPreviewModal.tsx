// SPDX-License-Identifier: GPL-2.0-or-later
//
// Two-step import flow surfaced after the user picks a `.json` from
// the file dialog. The first step (this modal) validates the body
// against `validatePack`, computes coverage against `english.json`,
// and only enables Save when no errors / dangerous keys remain.
// Save persists the pack via I18N_PACK_IMPORT_APPLY and registers
// the resulting bundle with i18next.
//
// The modal renders through its own portal so background clicks on
// the parent LanguagePacksModal cannot bubble in and dismiss it.
// Only the close button, Cancel, Save, and Escape may close it.

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { BTN_SECONDARY } from '../settings-modal/settings-modal-shared'
import { ModalCloseButton } from '../editors/ModalCloseButton'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { useI18nPackStore } from '../../hooks/useI18nPackStore'
import { validatePack } from '../../../shared/i18n/validate'
import { computeCoverage } from '../../../shared/i18n/coverage'
import { ENGLISH_PACK_BODY } from '../../i18n/coverage-cache'
import type { I18nPackMeta } from '../../../shared/types/i18n-store'

const APP_VERSION = (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? '0.0.0'

export interface ImportPreviewModalProps {
  raw: unknown
  onCancel: () => void
  /** Receives the freshly-saved meta when Save succeeds. Hub Browse
   * uses it to stamp the hubPostId without a follow-up list lookup. */
  onApplied: (meta?: I18nPackMeta) => void
}

export function ImportPreviewModal({ raw, onCancel, onApplied }: ImportPreviewModalProps): JSX.Element {
  const { t } = useTranslation()
  const store = useI18nPackStore()
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEscapeClose(onCancel, !busy)

  const validation = useMemo(() => validatePack(raw, { maxFileSizeBytes: 256 * 1024 }), [raw])
  const coverage = useMemo(() => {
    if (!validation.ok) return null
    return computeCoverage(raw, ENGLISH_PACK_BODY)
  }, [raw, validation.ok])

  const headerName = validation.header?.name ?? '-'
  const headerVersion = validation.header?.version ?? '-'
  const dangerCount = validation.dangerousKeys.length
  const errorCount = validation.errors.length
  const canApply = validation.ok && dangerCount === 0 && errorCount === 0 && !busy

  const handleApply = async (): Promise<void> => {
    if (!canApply) return
    setBusy(true)
    setSubmitError(null)
    const result = await store.applyImport(raw, {
      enabled: true,
      appVersionAtImport: APP_VERSION,
    })
    setBusy(false)
    if (result.success) {
      onApplied(result.meta)
    } else {
      setSubmitError(result.error ?? t('i18n.errorGeneric'))
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/50"
      data-testid="import-preview-modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        // React portals re-bubble events through the parent component
        // tree, so without stopPropagation the parent
        // LanguagePacksModal's backdrop handler would also dismiss the
        // Language modal. Closing only this dialog matches the close
        // button's behaviour.
        e.stopPropagation()
        if (!busy) onCancel()
      }}
    >
      <div
        className="w-[520px] max-h-[80vh] overflow-y-auto rounded-lg border border-edge bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
        data-testid="import-preview-modal"
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 className="text-lg font-semibold text-content">{t('i18n.preview.title')}</h2>
          <ModalCloseButton testid="import-preview-modal-close" onClick={onCancel} />
        </div>
        <div className="space-y-3 px-4 py-3 text-sm text-content">
          <div className="grid grid-cols-[140px_1fr] gap-y-1.5 gap-x-3">
            <div className="text-content-muted">{t('i18n.preview.name')}</div>
            <div className="text-content" data-testid="preview-name">{headerName}</div>
            <div className="text-content-muted">{t('i18n.preview.version')}</div>
            <div className="text-content" data-testid="preview-version">{headerVersion}</div>
            {coverage && (
              <>
                <div className="text-content-muted">{t('i18n.preview.coverage')}</div>
                <div className="text-content" data-testid="preview-coverage">
                  {`${String(Math.round(coverage.coverageRatio * 100))}% (${String(coverage.coveredKeys)} / ${String(coverage.totalKeys)})`}
                </div>
                <div className="text-content-muted">{t('i18n.preview.missingKeys')}</div>
                <div className="text-content" data-testid="preview-missing-count">
                  {coverage.missingKeys.length === 0
                    ? '0'
                    : `${String(coverage.totalKeys - coverage.coveredKeys)} (${t('i18n.preview.missingKeysHint')})`}
                </div>
              </>
            )}
            <div className="text-content-muted">{t('i18n.preview.dangerousKeys')}</div>
            <div className="text-content" data-testid="preview-dangerous-keys">
              {dangerCount === 0 ? t('i18n.preview.dangerousKeysNone') : t('i18n.preview.dangerousKeysFound', { count: dangerCount })}
            </div>
          </div>
          {errorCount > 0 && (
            <ul className="rounded border border-danger/50 bg-danger/10 p-2 text-xs text-danger" data-testid="preview-errors">
              {validation.errors.slice(0, 5).map((err) => (
                <li key={err}>{err}</li>
              ))}
              {validation.errors.length > 5 && (
                <li>{t('i18n.preview.moreErrors', { count: validation.errors.length - 5 })}</li>
              )}
            </ul>
          )}
          {dangerCount > 0 && (
            <div className="rounded border border-danger/50 bg-danger/10 p-2 text-xs text-danger" data-testid="preview-dangerous-warning">
              {t('i18n.preview.dangerousWarning')}
            </div>
          )}
          {submitError && (
            <div className="rounded border border-danger/50 bg-danger/10 p-2 text-xs text-danger" data-testid="preview-submit-error">
              {submitError}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-edge px-4 py-3">
          <button
            type="button"
            className={BTN_SECONDARY}
            onClick={onCancel}
            disabled={busy}
            data-testid="import-preview-cancel"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="rounded bg-accent px-3 py-1 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            onClick={() => { void handleApply() }}
            disabled={!canApply}
            data-testid="import-preview-apply"
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
