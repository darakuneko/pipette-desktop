// SPDX-License-Identifier: GPL-2.0-or-later
// Segmented toggle that switches the Analyze filter row between its two
// mutually-exclusive minute-tag dimensions (App / TypingTest). Sits in
// the label column of a FILTER_LABEL cell, replacing the static label so
// the two filters share one grid slot instead of two.

import { useTranslation } from 'react-i18next'
import { FILTER_DIMENSIONS, type FilterDimension } from '../../../shared/types/analyze-filters'
import { SegmentedToggle } from './SegmentedToggle'

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
    <SegmentedToggle
      options={FILTER_DIMENSIONS}
      value={value}
      onChange={onChange}
      labelFor={(dim) => t(LABEL_KEY[dim])}
      ariaLabel={t('analyze.filters.dimensionLabel')}
      testId={testId}
    />
  )
}
