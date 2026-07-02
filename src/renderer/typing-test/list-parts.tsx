// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import { ICON_SM } from '../constants/ui-tokens'

interface SectionHeaderProps {
  label: string
}

/** Sticky section header shared by the downloadable/imported list panes
 *  (LanguagePackTab's Downloaded/Available, AozoraCatalogTab's Imported/
 *  Available). */
export function SectionHeader({ label }: SectionHeaderProps) {
  return (
    <div className="sticky top-0 bg-surface px-4 py-2 text-xs font-medium uppercase text-content-muted">
      {label}
    </div>
  )
}

interface RowDeleteButtonProps {
  testId: string
  onClick: () => void
}

/** Trash-icon row button shared by every deletable list row (Aozora catalog,
 *  language pack, file import). */
export function RowDeleteButton({ testId, onClick }: RowDeleteButtonProps) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={t('common.delete')}
      className="shrink-0 rounded p-1 text-content-muted hover:text-danger"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      <Trash2 size={ICON_SM} aria-hidden="true" />
    </button>
  )
}
