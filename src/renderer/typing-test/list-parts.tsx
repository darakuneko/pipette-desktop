// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import { ICON_SM } from '../constants/ui-tokens'
import { optionButtonClass } from './TypingTestSettingsBar'

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

interface RomajiFilterToggleProps {
  active: boolean
  onToggle: () => void
}

/** Filter toggle shown alongside the search box / Import button on the
 *  MonkeyType, Tatoeba, and File Import tabs — narrows the list to
 *  romaji-badged (Romaji-input-capable) entries only. Not offered on the
 *  Aozora tab, whose catalog entries aren't judged for romaji capability
 *  the same way. Reuses the accent toggle idiom from TypingTestSettingsBar
 *  (also shared by RomajiSettingsModal). */
export function RomajiFilterToggle({ active, onToggle }: RomajiFilterToggleProps) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      data-testid="romaji-filter-toggle"
      aria-pressed={active}
      title={t('editor.typingTest.language.romajiFilter')}
      aria-label={t('editor.typingTest.language.romajiFilter')}
      onClick={onToggle}
      className={`${optionButtonClass(active, 'px-2.5')} shrink-0`}
    >
      {t('editor.typingTest.language.romajiBadge')}
    </button>
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
