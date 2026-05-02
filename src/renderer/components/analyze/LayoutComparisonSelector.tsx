// SPDX-License-Identifier: GPL-2.0-or-later
//
// Source / target layout dropdowns for the Layout Comparison.
//
// Sits inside the Analyze pane's filter row alongside 期間 / per-tab
// filters. Returning a fragment of FILTER_LABEL pairs (`display:
// contents`) keeps the dropdowns on the same row as 期間 so the user
// can see range + comparison choices together; the subgrid above
// already aligns them under keyboard / device.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { KEYBOARD_LAYOUTS } from '../../data/keyboard-layouts'
import { useKeyLabels } from '../../hooks/useKeyLabels'
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
  const keyLabels = useKeyLabels()
  /**
   * Layout options for source / target. QWERTY is materialised as a
   * Key Label store entry by `ensureQwertyEntry`, so iterating
   * `metas` first preserves the user-controlled drag order from the
   * Key Labels modal. `KEYBOARD_LAYOUTS` only serves as a safety net
   * for the brief window before `metas` has loaded.
   */
  const layoutOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: { id: string; name: string }[] = []
    for (const meta of keyLabels.metas) {
      if (seen.has(meta.id)) continue
      seen.add(meta.id)
      out.push({ id: meta.id, name: meta.name })
    }
    for (const def of KEYBOARD_LAYOUTS) {
      if (seen.has(def.id)) continue
      seen.add(def.id)
      out.push({ id: def.id, name: def.name })
    }
    if (sourceLayoutId && !seen.has(sourceLayoutId)) {
      out.push({ id: sourceLayoutId, name: sourceLayoutId })
    }
    return out
  }, [keyLabels.metas, sourceLayoutId])
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
          {layoutOptions.map((layout) => (
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
          {layoutOptions.filter((layout) => layout.id !== sourceLayoutId).map((layout) => (
            <option key={layout.id} value={layout.id}>
              {layout.name}
            </option>
          ))}
        </select>
      </label>
    </>
  )
}
