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

/** "Romaji" badge chip appended after a language/text name wherever a
 *  romaji-input-capable entry is listed (LanguagePackTab's monkeytype/
 *  tatoeba rows, the file-import list, the Aozora catalog's imported rows).
 *  Reuses the accent label-chip idiom from FavoriteStoreModal's type badge. */
export function RomajiBadge() {
  const { t } = useTranslation()
  return (
    <span className="shrink-0 rounded bg-accent/20 px-2 py-0.5 text-xs text-accent">
      {t('editor.typingTest.language.romajiBadge')}
    </span>
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
