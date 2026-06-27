// SPDX-License-Identifier: GPL-2.0-or-later
// Segmented toggle that switches the Analyze filter row between its two
// mutually-exclusive minute-tag dimensions (App / TypingTest). Sits in
// the label column of a FILTER_LABEL cell, replacing the static label so
// the two filters share one grid slot instead of two.

import { useTranslation } from 'react-i18next'
import { FILTER_DIMENSIONS, type FilterDimension } from '../../../shared/types/analyze-filters'
import { SEGMENT_TOGGLE_ACTIVE, SEGMENT_TOGGLE_INACTIVE } from '../../constants/ui-tokens'

interface Props {
  value: FilterDimension
  onChange: (next: FilterDimension) => void
  testId?: string
}

const LABEL_KEY: Record<FilterDimension, string> = {
  app: 'analyze.filters.app',
  typingTest: 'analyze.filters.typingTest',
}

export function FilterDimensionToggle({ value, onChange, testId = 'analyze-filter-dimension' }: Props) {
  const { t } = useTranslation()
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-md border border-edge p-0.5"
      role="group"
      aria-label={t('analyze.filters.dimensionLabel')}
      data-testid={testId}
    >
      {FILTER_DIMENSIONS.map((dim) => {
        const active = value === dim
        return (
          <button
            key={dim}
            type="button"
            className={active ? SEGMENT_TOGGLE_ACTIVE : SEGMENT_TOGGLE_INACTIVE}
            aria-pressed={active}
            onClick={() => onChange(dim)}
            data-testid={`${testId}-${dim}`}
          >
            {t(LABEL_KEY[dim])}
          </button>
        )
      })}
    </div>
  )
}
