// SPDX-License-Identifier: GPL-2.0-or-later
//
// Source / target layout dropdowns for the Layout Comparison.
//
// Sits inside the Analyze pane's filter row alongside 期間 / per-tab
// filters. Returning a fragment of FILTER_LABEL pairs (`display:
// contents`) keeps the dropdowns on the same row as 期間 so the user
// can see range + comparison choices together; the subgrid above
// already aligns them under keyboard / device.

import { useTranslation } from 'react-i18next'
import { KEYBOARD_LAYOUTS } from '../../data/keyboard-layouts'
import { FILTER_LABEL, FILTER_SELECT } from './analyze-filter-styles'

interface Props {
  sourceLayoutId: string
  targetLayoutId: string | null
  onSourceChange: (id: string) => void
  onTargetChange: (id: string | null) => void
}

const NONE_VALUE = '__none__'

export function LayoutComparisonSelector({
  sourceLayoutId,
  targetLayoutId,
  onSourceChange,
  onTargetChange,
}: Props): JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <label className={FILTER_LABEL}>
        <span>{t('analyze.layoutComparison.sourceLabel')}</span>
        <select
          className={FILTER_SELECT}
          value={sourceLayoutId}
          onChange={(e) => onSourceChange(e.target.value)}
          data-testid="analyze-layout-comparison-source-select"
        >
          {KEYBOARD_LAYOUTS.map((layout) => (
            <option key={layout.id} value={layout.id}>
              {layout.name}
            </option>
          ))}
        </select>
      </label>
      <label className={FILTER_LABEL}>
        <span>{t('analyze.layoutComparison.targetLabel')}</span>
        <select
          className={FILTER_SELECT}
          value={targetLayoutId ?? NONE_VALUE}
          onChange={(e) => {
            const next = e.target.value
            onTargetChange(next === NONE_VALUE ? null : next)
          }}
          data-testid="analyze-layout-comparison-target-select"
        >
          <option value={NONE_VALUE}>
            {t('analyze.layoutComparison.noTargetOption')}
          </option>
          {KEYBOARD_LAYOUTS.filter((layout) => layout.id !== sourceLayoutId).map((layout) => (
            <option key={layout.id} value={layout.id}>
              {layout.name}
            </option>
          ))}
        </select>
      </label>
    </>
  )
}
