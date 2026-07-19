// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared Export / Delete→Confirm-Cancel strip used by the Language
// Packs, Theme Packs, and Key Labels installed rows.
//
// Callers own the outer wrapper so Language Packs can still slot its
// built-in (non-deletable) row's Export + invisible-Delete-spacer
// branch alongside this component inside the same wrapper.

import { useTranslation } from 'react-i18next'

export interface PackDeleteActionsProps {
  id: string
  /** e.g. `theme-packs` / `language-packs` — matches the row's other testids. */
  testidPrefix: string
  busy: boolean
  confirming: boolean
  /** Theme Packs uses `common.delete`, Language Packs uses `keyLabels.actionDelete`. */
  deleteLabel: string
  onExport: () => void
  onAskDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
}

const LINK_CLASS = 'text-xs font-medium hover:underline disabled:opacity-50'

export function PackDeleteActions({
  id,
  testidPrefix,
  busy,
  confirming,
  deleteLabel,
  onExport,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: PackDeleteActionsProps): JSX.Element {
  const { t } = useTranslation()

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={(e) => { e.stopPropagation(); onConfirmDelete() }}
          className={`${LINK_CLASS} text-danger`}
          data-testid={`${testidPrefix}-confirm-delete-${id}`}
        >
          {t('common.confirmDelete')}
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCancelDelete() }}
          className={`${LINK_CLASS} text-content-muted`}
          data-testid={`${testidPrefix}-cancel-delete-${id}`}
        >
          {t('common.cancel')}
        </button>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={`${LINK_CLASS} text-content-muted`}
        onClick={(e) => { e.stopPropagation(); onExport() }}
        disabled={busy}
        data-testid={`${testidPrefix}-export-${id}`}
      >
        {t('keyLabels.actionExport')}
      </button>
      <button
        type="button"
        className={`${LINK_CLASS} text-danger`}
        onClick={(e) => { e.stopPropagation(); onAskDelete() }}
        disabled={busy}
        data-testid={`${testidPrefix}-delete-${id}`}
      >
        {deleteLabel}
      </button>
    </span>
  )
}
