// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingTestResult } from '../../shared/types/pipette-settings'

interface Props {
  /** The active tab's full result set (see `AccuracyTrendSection`'s prop
   *  doc — same `tabResults`, condition-scoped stays out of scope here
   *  since a mistake ranking is meaningful across every condition mixed
   *  together, unlike the accuracy trend line). */
  results: TypingTestResult[]
}

interface MistakeRankEntry {
  key: string
  count: number
}

const MAX_MISTAKE_RANKING_ENTRIES = 15

/** Sums each result's `mistakes` tally (key = canonical romaji unit or
 *  verbatim target char, see `TypingTestResult.mistakes`) across the whole
 *  set, then sorts by count DESC / key ASC (matches the completion
 *  screen's `mistakeEntries` ordering in `TypingTestView.tsx` so the two
 *  views read the same way) and caps to the top N. */
function aggregateMistakes(results: TypingTestResult[]): MistakeRankEntry[] {
  const totals = new Map<string, number>()
  for (const r of results) {
    if (!r.mistakes) continue
    for (const [key, count] of Object.entries(r.mistakes)) {
      totals.set(key, (totals.get(key) ?? 0) + count)
    }
  }
  return Array.from(totals, ([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, MAX_MISTAKE_RANKING_ENTRIES)
}

/** Most-missed-characters ranking — aggregates `mistakes` across every
 *  result in the active tab (condition filter doesn't apply here, unlike
 *  `AccuracyTrendSection`; a mistake tally is still meaningful mixed
 *  across conditions). Hidden entirely when the tab has no results at
 *  all; shows a subtle "no mistakes" line when there are results but
 *  none of them recorded any mistakes. */
export function MistakeRankingSection({ results }: Props) {
  const { t } = useTranslation()

  const ranked = useMemo(() => aggregateMistakes(results), [results])
  const maxCount = ranked[0]?.count ?? 0

  if (results.length === 0) return null

  return (
    <div className="flex flex-col gap-2" data-testid="typing-test-mistake-ranking">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-content-muted">
        {t('editor.typingTest.history.mistakeRankingTitle')}
      </h3>
      {ranked.length === 0 ? (
        <p className="text-xs text-content-muted">
          {t('editor.typingTest.history.mistakeRankingEmpty')}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {ranked.map(({ key, count }) => (
            <div key={key} className="flex items-center gap-2 text-xs" data-testid={`mistake-rank-${key}`}>
              <span className="w-12 shrink-0 truncate font-mono text-content">{key}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded bg-surface-dim">
                <div
                  className="h-full rounded bg-accent"
                  style={{ width: maxCount > 0 ? `${(count / maxCount) * 100}%` : '0%' }}
                />
              </div>
              <span className="w-6 shrink-0 text-right font-mono text-content-muted">{count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
