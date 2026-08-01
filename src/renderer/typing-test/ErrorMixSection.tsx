// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { sumErrorClassGroups, type ErrorClassCounts } from './error-classify'
import { formatKspc } from '../../shared/kspc'
import { benchmarkPosition } from '../components/analyze/analyze-benchmark'
import {
  BENCHMARK_SUBSTITUTION_RATE_PCT,
  BENCHMARK_OMISSION_RATE_PCT,
  BENCHMARK_INSERTION_RATE_PCT,
  type BenchmarkStat,
} from '../../shared/typing-benchmarks'

interface Props {
  /** The active tab's full result set (see `MistakeRankingSection`'s prop
   *  doc — same `tabResults`, condition-scoped stays out of scope here
   *  for the same reason: an error-mix rate is meaningful mixed across
   *  every condition, unlike `AccuracyTrendSection`). */
  results: TypingTestResult[]
}

/** Static row spec: which totals field, which population benchmark, and
 *  which i18n key each row of the section uses. Module-level since none
 *  of it depends on props/state. */
const ERROR_MIX_ROWS: ReadonlyArray<{
  testId: string
  bench: BenchmarkStat
  i18nKey: string
  pick: (totals: ErrorClassCounts) => number
}> = [
  { testId: 'substitution', bench: BENCHMARK_SUBSTITUTION_RATE_PCT, i18nKey: 'editor.typingTest.history.errorMixSubstitutionRow', pick: (t) => t.substitutions },
  { testId: 'omission', bench: BENCHMARK_OMISSION_RATE_PCT, i18nKey: 'editor.typingTest.history.errorMixOmissionRow', pick: (t) => t.omissions },
  { testId: 'insertion', bench: BENCHMARK_INSERTION_RATE_PCT, i18nKey: 'editor.typingTest.history.errorMixInsertionRow', pick: (t) => t.insertions },
]

/** History's error-mix summary — char-weighted substitution/omission/
 *  insertion rates aggregated across every result in the active tab that
 *  recorded the 4-field error-class group, alongside the population mean
 *  for each (see `typing-benchmarks.ts`) as context text. Each row also
 *  appends a `benchmarkPosition` label (Far below/Below/Average/Above/Far
 *  above average) through a dedicated `analyze.benchmark.positionRate.*`
 *  key set rather than the existing `analyze.benchmark.position.*` one —
 *  that set's pack strings are speed-phrased (slow/fast, for WPM/KSPC/
 *  IKI-shaped stats) and would read backwards for an error rate, where
 *  "above average" is worse, not faster. Hidden entirely when the tab
 *  has no results at all; shows a subtle empty line when there are
 *  results but none of them qualify (e.g. a romaji-only tab, or every
 *  result predates error-class tracking). */
export function ErrorMixSection({ results }: Props) {
  const { t } = useTranslation()
  const totals = useMemo(() => sumErrorClassGroups(results), [results])

  if (results.length === 0) return null

  return (
    <div className="flex flex-col gap-2" data-testid="typing-test-error-mix">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-content-muted">
        {t('editor.typingTest.history.errorMixTitle')}
      </h3>
      {!totals ? (
        <p className="text-xs text-content-muted">
          {t('editor.typingTest.history.errorMixEmpty')}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {ERROR_MIX_ROWS.map(({ testId, bench, i18nKey, pick }) => {
            const pct = (pick(totals) / totals.targetChars) * 100
            const position = benchmarkPosition(pct, bench)
            return (
              <div key={testId} className="text-xs text-content-muted" data-testid={`error-mix-${testId}`}>
                {t(i18nKey, { pct: formatKspc(pct), avgPct: formatKspc(bench.mean) })}
                {position && ` · ${t(`analyze.benchmark.positionRate.${position.label}`)}`}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
