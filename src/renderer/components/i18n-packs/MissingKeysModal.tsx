// SPDX-License-Identifier: GPL-2.0-or-later
//
// Modal that lists the keys a language pack does not yet translate
// (relative to bundled English) and lets the user download a JSON
// template containing only those keys with the English fallback as
// the value. The user edits the template and re-imports it via the
// outer Languages modal. The list groups keys by their top-level
// segment (`common`, `keycodeTooltip`, …), each group collapsed until
// clicked.

import { useCallback, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ModalCloseButton } from '../editors/ModalCloseButton'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { buildSubsetFromKeys } from '../../../shared/i18n/coverage'
import { downloadJson } from '../../utils/download-json'
import { PACK_TOOLBAR_BTN } from '../../constants/ui-tokens'
import { DisclosureRow } from '../ui/DisclosureRow'

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

interface KeyGroup {
  name: string
  keys: string[]
}

/** Group dot-separated key paths by their first segment, keeping the
 *  order in which each group first appears. */
function groupByTopLevel(keys: readonly string[]): KeyGroup[] {
  const groups = new Map<string, string[]>()
  for (const key of keys) {
    const dot = key.indexOf('.')
    const name = dot < 0 ? key : key.slice(0, dot)
    const list = groups.get(name)
    if (list) list.push(key)
    else groups.set(name, [key])
  }
  return Array.from(groups, ([name, groupKeys]) => ({ name, keys: groupKeys }))
}

/** Mounted only while the modal is open, so every group starts
 *  collapsed each time the modal opens. */
function MissingKeyGroups({ missingKeys }: { missingKeys: readonly string[] }): JSX.Element {
  const { t } = useTranslation()
  const groups = useMemo(() => groupByTopLevel(missingKeys), [missingKeys])
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set())

  const toggle = useCallback((name: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  return (
    <div data-testid="missing-keys-modal-list">
      {groups.map(({ name, keys }) => {
        const open = openGroups.has(name)
        return (
          <div key={name}>
            <DisclosureRow
              label={t('i18n.missingKeys.group', { name, n: keys.length })}
              open={open}
              onToggle={() => toggle(name)}
            />
            {open && (
              <ul className="space-y-1 pb-1 pl-4 text-xs text-content">
                {keys.map((key) => (
                  <li key={key} className="font-mono break-all">{key}</li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
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
        className="w-modal-md max-w-modal-vw h-modal-70vh flex flex-col rounded-lg bg-surface shadow-xl"
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
            className={PACK_TOOLBAR_BTN}
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
            <MissingKeyGroups missingKeys={missingKeys} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
