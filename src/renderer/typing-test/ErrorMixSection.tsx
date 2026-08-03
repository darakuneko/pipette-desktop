// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { sumErrorClassGroups, type ErrorClassCounts } from './error-classify'
import { formatKspc } from '../../shared/kspc'
import { benchmarkPosition, type BenchmarkPositionLabel } from '../components/analyze/analyze-benchmark'
import { Tooltip } from '../components/ui/Tooltip'
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
 *  which i18n label/desc/advice key each row of the section uses.
 *  Module-level since none of it depends on props/state. `descKey` +
 *  `adviceKey` back the row label's tooltip (what the error class means,
 *  then a concrete improvement tip) — kept as separate keys rather than
 *  one combined string so a future consumer could reuse just the
 *  definition without the advice half. */
const ERROR_MIX_ROWS: ReadonlyArray<{
  testId: string
  bench: BenchmarkStat
  labelKey: string
  descKey: string
  adviceKey: string
  pick: (totals: ErrorClassCounts) => number
}> = [
  {
    testId: 'substitution',
    bench: BENCHMARK_SUBSTITUTION_RATE_PCT,
    labelKey: 'editor.typingTest.history.errorMixLabelSubstitution',
    descKey: 'editor.typingTest.history.errorMixDescSubstitution',
    adviceKey: 'editor.typingTest.history.errorMixAdviceSubstitution',
    pick: (t) => t.substitutions,
  },
  {
    testId: 'omission',
    bench: BENCHMARK_OMISSION_RATE_PCT,
    labelKey: 'editor.typingTest.history.errorMixLabelOmission',
    descKey: 'editor.typingTest.history.errorMixDescOmission',
    adviceKey: 'editor.typingTest.history.errorMixAdviceOmission',
    pick: (t) => t.omissions,
  },
  {
    testId: 'insertion',
    bench: BENCHMARK_INSERTION_RATE_PCT,
    labelKey: 'editor.typingTest.history.errorMixLabelInsertion',
    descKey: 'editor.typingTest.history.errorMixDescInsertion',
    adviceKey: 'editor.typingTest.history.errorMixAdviceInsertion',
    pick: (t) => t.insertions,
  },
]

/** Fixed column widths (not `max-content`) so every row — each its own
 *  independent grid instance, same pattern as `FLAT_RANKING_GRID` in
 *  `key-heatmap-panels.tsx` — lands on identical column boundaries
 *  without needing a single shared grid parent. TYPE / YOU / POP. AVG
 *  are fixed-width so the decimals line up (`formatKspc` always emits
 *  exactly 2 decimal places, so a right-aligned fixed-width box flushes
 *  the "%" — and therefore every decimal digit before it — to the same
 *  x position across rows regardless of integer-digit count, e.g.
 *  3.45% vs 24.14%). The verdict pill column stays `auto` since a pill's
 *  own width already varies with its label ("Above avg" vs "Far above
 *  avg") — matching-width pills would need padding tricks that add
 *  nothing visually. */
const ERROR_MIX_GRID = { gridTemplateColumns: '6.5rem 4rem 4rem auto' }

/** Tone mapping for the verdict pill, keyed off `BenchmarkPositionLabel`
 *  (see `analyze-benchmark.ts`). Unlike that module's own labels — which
 *  are deliberately direction-neutral because a lower WPM/IKI isn't
 *  always worse — every row in THIS section is an error rate, where
 *  below average is unambiguously better and above average is
 *  unambiguously worse. That asymmetry is exactly why this mapping lives
 *  here instead of being a generic export off `analyze-benchmark.ts`. */
const ERROR_MIX_PILL_TONE: Record<BenchmarkPositionLabel, string> = {
  farBelow: 'bg-success/20 text-success',
  below: 'bg-success/20 text-success',
  average: 'bg-success/20 text-success',
  above: 'bg-warning/20 text-warning',
  farAbove: 'bg-danger/20 text-danger',
}

const ERROR_MIX_PILL_BASE = 'inline-flex items-center rounded px-2 py-0.5 text-xs font-medium'

/** History's error-mix summary — char-weighted substitution/omission/
 *  insertion rates aggregated across every result in the active tab that
 *  recorded the 4-field error-class group, alongside the population mean
 *  for each (see `typing-benchmarks.ts`) as context text. Each row also
 *  carries a `benchmarkPosition` verdict (Far below/Below/Average/Above/
 *  Far above average) rendered as a colored pill through a dedicated
 *  `analyze.benchmark.positionRateShort.*` key set rather than the
 *  existing `analyze.benchmark.positionRate.*` one — that set's strings
 *  are the full-sentence form used elsewhere and would overflow a pill's
 *  cramped width. Hidden entirely when the tab has no results at all;
 *  shows a subtle empty line when there are results but none of them
 *  qualify (e.g. a romaji-only tab, or every result predates error-class
 *  tracking). Every row always renders regardless of how extreme its
 *  rate is — there is no sample-size or magnitude threshold that hides a
 *  row, by deliberate product decision.
 *
 *  Each row is a 4-column CSS grid (`ERROR_MIX_GRID`: label / YOU /
 *  POP. AVG / verdict pill), preceded by a matching header row of column
 *  captions — replacing the previous 3-column "Label X% (pop. avg Y%) |
 *  Verdict" flat layout so YOU and POP. AVG line up in their own
 *  right-aligned columns instead of being fused into one string. The
 *  label itself carries a `Tooltip` (definition + improvement advice)
 *  since the row no longer has room to spell either out inline. */
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
          <div
            className="grid items-baseline gap-x-2 text-2xs font-semibold uppercase tracking-wider text-content-muted"
            style={ERROR_MIX_GRID}
            data-testid="error-mix-header"
          >
            <span data-testid="error-mix-header-type">{t('editor.typingTest.history.errorMixColumnType')}</span>
            <span className="text-right" data-testid="error-mix-header-you">{t('editor.typingTest.history.errorMixColumnYou')}</span>
            <span className="text-right" data-testid="error-mix-header-avg">{t('editor.typingTest.history.errorMixColumnPopAvg')}</span>
            <span />
          </div>
          {ERROR_MIX_ROWS.map(({ testId, bench, labelKey, descKey, adviceKey, pick }) => {
            const pct = (pick(totals) / totals.targetChars) * 100
            const position = benchmarkPosition(pct, bench)
            const tooltipContent = `${t(descKey)}\n\n${t(adviceKey)}`
            return (
              <div
                key={testId}
                className="grid items-center gap-x-2 text-xs"
                style={ERROR_MIX_GRID}
                data-testid={`error-mix-${testId}`}
              >
                <Tooltip content={tooltipContent} side="right" className="max-w-xs">
                  <span className="text-content-muted" data-testid={`error-mix-${testId}-label`}>
                    {t(labelKey)}
                  </span>
                </Tooltip>
                <span className="text-right tabular-nums text-content" data-testid={`error-mix-${testId}-value`}>
                  {formatKspc(pct)}%
                </span>
                <span className="text-right tabular-nums text-content-muted" data-testid={`error-mix-${testId}-avg`}>
                  {formatKspc(bench.mean)}%
                </span>
                <span data-testid={`error-mix-${testId}-verdict`}>
                  {position && (
                    <span
                      className={`${ERROR_MIX_PILL_BASE} ${ERROR_MIX_PILL_TONE[position.label]}`}
                      data-testid={`error-mix-${testId}-pill`}
                    >
                      {t(`analyze.benchmark.positionRateShort.${position.label}`)}
                    </span>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
