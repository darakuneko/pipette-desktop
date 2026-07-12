// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { FILTER_SELECT_CLASS } from '../components/editors/store-modal-shared'
import { resultConditionKey } from './comparison'
import { formatConditionLabel } from './condition-label'
import { AccuracyTrendChart } from './AccuracyTrendChart'

interface Props {
  /** The active tab's full result set (not the mode/text-filtered table
   *  rows), so the condition selector always lists every condition present
   *  in the tab regardless of the coarse filter dropdown above it. */
  results: TypingTestResult[]
}

/** Accuracy Trend — condition-scoped so mixing incomparable runs into one
 *  line is impossible. Hidden entirely when the active tab has nothing to
 *  group; the chart itself hides when the selected condition has fewer
 *  than 2 runs to plot. */
export function AccuracyTrendSection({ results }: Props) {
  const { t } = useTranslation()

  // Grouped on the same condition key used for baseline comparison in
  // comparison.ts, so mixing incomparable runs (different word count,
  // language, punctuation/numbers toggles) into one line is impossible.
  // `results` is newest-first (useDevicePrefs prepends new runs, and
  // WpmSparkline relies on the same invariant), so the first result seen
  // per key is already its most recent — Map insertion order therefore
  // matches "most recently used condition first" with no extra sort needed.
  const distinctConditions = useMemo(() => {
    const map = new Map<string, { label: string, results: TypingTestResult[] }>()
    for (const r of results) {
      const key = resultConditionKey(r)
      const entry = map.get(key)
      if (entry) entry.results.push(r)
      else map.set(key, { label: formatConditionLabel(r, t), results: [r] })
    }
    return Array.from(map, ([key, v]) => ({ key, ...v }))
  }, [results, t])

  // User's explicit pick, or the latest run's condition by default
  // (distinctConditions[0], since it's ordered most-recent-first). Falls
  // back the same way when the picked condition no longer has any results
  // (e.g. its rows were deleted).
  const [conditionFilter, setConditionFilter] = useState<string>('')
  const selectedCondition = (conditionFilter && distinctConditions.find((c) => c.key === conditionFilter))
    || distinctConditions[0]

  if (distinctConditions.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-content-muted">
          {t('editor.typingTest.history.accuracyTrendTitle')}
        </h3>
        <select
          data-testid="history-condition-filter"
          aria-label={t('editor.typingTest.history.conditionFilterLabel')}
          className={FILTER_SELECT_CLASS}
          value={selectedCondition?.key ?? ''}
          onChange={(e) => setConditionFilter(e.target.value)}
        >
          {distinctConditions.map((c) => (
            <option key={c.key} value={c.key}>{c.label}</option>
          ))}
        </select>
      </div>
      {selectedCondition && <AccuracyTrendChart results={selectedCondition.results} />}
    </div>
  )
}
