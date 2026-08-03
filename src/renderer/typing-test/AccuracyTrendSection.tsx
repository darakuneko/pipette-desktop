// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { resultConditionKey } from './comparison'
import { formatConditionLabel } from './condition-label'
import { AccuracyTrendChart } from './AccuracyTrendChart'

export interface DistinctCondition {
  key: string
  label: string
  results: TypingTestResult[]
}

/** Group `results` by condition key (see `resultConditionKey`), so mixing
 *  incomparable runs (different word count, language, punctuation/numbers
 *  toggles) into one line/selection is impossible. `results` is
 *  newest-first (useDevicePrefs prepends new runs), so the first result
 *  seen per key is already its most recent — Map insertion order therefore
 *  matches "most recently used condition first" with no extra sort needed.
 *
 *  Exported so TypingTestHistory can build the condition `<select>` (now
 *  hoisted into the header's right-end group) from the same grouping this
 *  section uses to resolve the picked key into its chart's result set —
 *  a single source of truth for the grouping, called from two places. */
export function deriveDistinctConditions(results: TypingTestResult[], t: TFunction): DistinctCondition[] {
  const map = new Map<string, DistinctCondition>()
  for (const r of results) {
    const key = resultConditionKey(r)
    const entry = map.get(key)
    if (entry) entry.results.push(r)
    else map.set(key, { key, label: formatConditionLabel(r, t), results: [r] })
  }
  return Array.from(map.values())
}

interface Props {
  /** The active tab's full result set (not the mode/text-filtered table
   *  rows), so the condition selector always lists every condition present
   *  in the tab regardless of the coarse filter dropdown above it. */
  results: TypingTestResult[]
  /** Controlled selection — owned by TypingTestHistory (which also renders
   *  the `<select>` itself, in the header's right-end group, not here) so
   *  the condition picker can live outside this section's DOM subtree while
   *  this component still resolves it against `results` to pick the
   *  chart's series. Already-resolved against `deriveDistinctConditions`
   *  by the parent (falls back to the latest condition when the picked key
   *  no longer has any results), so this component trusts it directly. */
  selectedCondition: string
}

/** Accuracy Trend — condition-scoped so mixing incomparable runs into one
 *  line is impossible. Hidden entirely when the active tab has nothing to
 *  group; the chart itself hides when the selected condition has fewer
 *  than 2 runs to plot. The condition `<select>` itself is NOT rendered
 *  here — TypingTestHistory renders it in the header's right-end group
 *  (next to the source select) since the header redesign collapsed the
 *  modal to a single tab row with all selects at the right end; this
 *  section keeps only the "ACCURACY TREND" heading + chart. */
export function AccuracyTrendSection({ results, selectedCondition }: Props) {
  const { t } = useTranslation()

  const distinctConditions = useMemo(() => deriveDistinctConditions(results, t), [results, t])
  const selected = distinctConditions.find((c) => c.key === selectedCondition) ?? distinctConditions[0]

  if (distinctConditions.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-content-muted">
        {t('editor.typingTest.history.accuracyTrendTitle')}
      </h3>
      {selected && <AccuracyTrendChart results={selected.results} />}
    </div>
  )
}
