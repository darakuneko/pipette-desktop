// SPDX-License-Identifier: GPL-2.0-or-later
//
// Source / target layout dropdowns for the Layout Optimizer view.

import { useTranslation } from 'react-i18next'
import { KEYBOARD_LAYOUTS } from '../../data/keyboard-layouts'
import { FILTER_SELECT } from './analyze-filter-styles'

interface Props {
  sourceLayoutId: string
  targetLayoutId: string | null
  onSourceChange: (id: string) => void
  onTargetChange: (id: string | null) => void
}

const NONE_VALUE = '__none__'

export function LayoutOptimizerSelector({
  sourceLayoutId,
  targetLayoutId,
  onSourceChange,
  onTargetChange,
}: Props): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center gap-3 text-[12px]" data-testid="analyze-layout-optimizer-selector">
      <label className="flex items-center gap-2">
        <span className="text-content-secondary">
          {t('analyze.layoutOptimizer.sourceLabel')}
        </span>
        <select
          className={FILTER_SELECT}
          value={sourceLayoutId}
          onChange={(e) => onSourceChange(e.target.value)}
          data-testid="analyze-layout-optimizer-source-select"
        >
          {KEYBOARD_LAYOUTS.map((layout) => (
            <option key={layout.id} value={layout.id}>
              {layout.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="text-content-secondary">
          {t('analyze.layoutOptimizer.targetLabel')}
        </span>
        <select
          className={FILTER_SELECT}
          value={targetLayoutId ?? NONE_VALUE}
          onChange={(e) => {
            const next = e.target.value
            onTargetChange(next === NONE_VALUE ? null : next)
          }}
          data-testid="analyze-layout-optimizer-target-select"
        >
          <option value={NONE_VALUE}>
            {t('analyze.layoutOptimizer.noTargetOption')}
          </option>
          {KEYBOARD_LAYOUTS.filter((layout) => layout.id !== sourceLayoutId).map((layout) => (
            <option key={layout.id} value={layout.id}>
              {layout.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
