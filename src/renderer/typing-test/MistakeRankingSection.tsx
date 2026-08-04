// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { MissedTable } from './mistake-summary'
import { useAggregatedMissedDetails } from './use-mistake-ranking-details'

interface Props {
  /** The active tab's full result set (see `AccuracyTrendSection`'s prop
   *  doc — same `tabResults`, condition-scoped stays out of scope here
   *  since a mistake ranking is meaningful across every condition mixed
   *  together, unlike the accuracy trend line). */
  results: TypingTestResult[]
  /** Active keyboard's uid — same value `TypingTestHistory`/
   *  `HistoryResultsPanel` already thread for the timeline column.
   *  Required to fetch any run log at all; undefined disables per-key
   *  detail fetching outright (the rows still render, bars all-gray/
   *  unknown-split — see `MissedTable`'s own `barFillSplit` doc comment). */
  uid?: string
  /** runIds known to have a saved keystroke log (`useRunLogAvailability`,
   *  owned by `HistoryToggle`) — see `useAggregatedMissedDetails`'s own
   *  doc comment for how this scopes which logs actually get fetched. */
  availableRunIds?: ReadonlySet<string>
}

/** Sums each result's `mistakes` tally (key = canonical romaji unit or
 *  verbatim target char, see `TypingTestResult.mistakes`) across the whole
 *  set. Sorting happens inside `MissedTable` itself
 *  (`allSortedMistakeEntries`) — every entry renders, reachable via the
 *  row list's own internal scroll rather than a top-N cap — this only
 *  builds the raw totals record `MissedTable` expects, the same shape a
 *  single run's own `TypingTestResult.mistakes` already has. */
function aggregateMistakeTotals(results: TypingTestResult[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const r of results) {
    if (!r.mistakes) continue
    for (const [key, count] of Object.entries(r.mistakes)) {
      totals[key] = (totals[key] ?? 0) + count
    }
  }
  return totals
}

/** Most-missed-characters ranking — aggregates `mistakes` across every
 *  result in the active tab (condition filter doesn't apply here, unlike
 *  `AccuracyTrendSection`; a mistake tally is still meaningful mixed
 *  across conditions) into the SAME per-key bar-graph row list
 *  `KeystrokeTimelinePanel` uses for a single run (`MissedTable`) — see
 *  `useAggregatedMissedDetails` for how each bar's red/gray split and
 *  hover-tooltip figures are populated by merging `buildMissedDetails`
 *  across every run log available for this tab's results. Hidden entirely when the
 *  tab has no results at all; shows a subtle "no mistakes" line when
 *  there are results but none of them recorded any mistakes (kept as
 *  this component's own concern, not `MissedTable`'s — this section's
 *  empty state is worded around "results in this tab", which only this
 *  caller knows about). */
export function MistakeRankingSection({ results, uid, availableRunIds }: Props) {
  const { t } = useTranslation()

  const totals = useMemo(() => aggregateMistakeTotals(results), [results])
  const hasAnyMistakes = Object.keys(totals).length > 0
  const details = useAggregatedMissedDetails(uid, results, availableRunIds)

  if (results.length === 0) return null

  if (!hasAnyMistakes) {
    return (
      <div className="flex flex-col gap-2" data-testid="typing-test-mistake-ranking">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-content-muted">
          {t('editor.typingTest.history.mistakeRankingTitle')}
        </h3>
        <p className="text-xs text-content-muted">
          {t('editor.typingTest.history.mistakeRankingEmpty')}
        </p>
      </div>
    )
  }

  return (
    <MissedTable
      mistakes={totals}
      details={details}
      titleKey="editor.typingTest.history.mistakeRankingTitle"
      testId="typing-test-mistake-ranking"
    />
  )
}
