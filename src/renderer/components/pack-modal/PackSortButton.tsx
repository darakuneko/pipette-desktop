// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared "Name" sort toggle for the Installed tab toolbar (left end,
// opposite the Import button). Visual style mirrors the Import button
// exactly (same classes) so the two toolbar buttons read as a pair.
//
// `direction` (from `useNameSort`) describes the sort *last applied*
// (or about to be applied by the very first click) — `aria-pressed`
// here follows the same "describes current state" convention as the
// neighboring `PackTabButton`'s `aria-pressed={active}`.

import { useTranslation } from 'react-i18next'
import type { SortDirection } from './useNameSort'

export interface PackSortButtonProps {
  direction: SortDirection
  onClick: () => void
  disabled?: boolean
  testid: string
}

const ASC_INDICATOR = '▲'
const DESC_INDICATOR = '▼'

export function PackSortButton({ direction, onClick, disabled, testid }: PackSortButtonProps): JSX.Element {
  const { t } = useTranslation()
  const label = t('common.sortByName')
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={direction === 'desc'}
      aria-label={label}
      className="rounded border border-edge bg-surface px-3 py-1.5 text-sm font-medium text-content hover:bg-surface-hover disabled:opacity-50"
      data-testid={testid}
    >
      {label} {direction === 'asc' ? ASC_INDICATOR : DESC_INDICATOR}
    </button>
  )
}
