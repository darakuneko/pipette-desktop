// SPDX-License-Identifier: GPL-2.0-or-later
// Hand-usage classes (Left / Right / Alternation / Repetition) quadrant
// for the Analyze Bigrams tab. Split out of BigramsChart.tsx — see that
// file for the surrounding grid and the shared `classesAggregate` memo
// computed once and passed down to both `BigramClassesCoverage` and
// `BigramClassesTable`.

import { useTranslation } from 'react-i18next'
import {
  CLASSIFIED_CLASSES,
  type BigramClassAggregate,
  type BigramClassTotal,
  type ClassifiedBigramClass,
} from './analyze-bigram-classes'
import { BIGRAM_MIN_COUNT } from './analyze-typing-profile'
import { avgIkiFromHist } from './analyze-bigram-heatmap'
import { EMPTY_STAT_VALUE } from './analyze-constants'
import { fmtMs } from './analyze-format'
import { EmptyQuadrant } from './bigrams-quadrant-ui'

interface BigramClassesQuadrantProps {
  /** Classes aggregate computed once by the parent `BigramsChart` and
   * shared with the sibling quadrant below — see the "1 calculation, 2
   * consumers" note at the call site. */
  aggregate: BigramClassAggregate
  hasSnapshot: boolean
}

/** Coverage line rendered in the classes quadrant's notice slot —
 * "N% of pairs classified" — so a low value (heavy `unknown` bucket)
 * is visible instead of the 4-class table silently under-representing
 * the period. Hidden while there's no snapshot since the table already
 * explains that state. */
function BigramClassesCoverage({ aggregate, hasSnapshot }: BigramClassesQuadrantProps): JSX.Element | null {
  const { t } = useTranslation()
  if (!hasSnapshot || aggregate.totalCount === 0) return null
  const percent = Math.round(((aggregate.totalCount - aggregate.unknownCount) / aggregate.totalCount) * 100)
  return (
    <div className="text-xs text-content-muted" data-testid="analyze-bigrams-classes-coverage">
      {t('analyze.bigrams.classes.coverage', { percent })}
    </div>
  )
}

/** Per-class avgIki, `null` (renders "—") whenever the class's sample
 * falls below `BIGRAM_MIN_COUNT` — the same floor the Typing Profile
 * card uses to suppress its Hand balance / SFB labels on thin data. */
function classAvgOrNull(total: BigramClassTotal): number | null {
  if (total.count < BIGRAM_MIN_COUNT) return null
  return avgIkiFromHist(total.hist)
}

/** Signed `+N ms` / `-N ms` delta, `'—'` when either side is `null`.
 * Positive means alternating hands was faster than staying on the
 * class's hand — the CHI 2018 headline result. */
function fmtDelta(value: number | null): string {
  if (value === null) return EMPTY_STAT_VALUE
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : ''}${rounded} ms`
}

/** Left / Right / Alternation / Repetition IKI quadrant — the
 * CHI 2018 Table 3 hand-usage classes. Each row's average comes from
 * `avgIkiFromHist` on that class's own folded histogram (never a mean
 * of two other classes' averages), and ΔLeft / ΔRight compare each
 * same-hand class directly against Alternation. */
function BigramClassesTable({ aggregate, hasSnapshot }: BigramClassesQuadrantProps): JSX.Element {
  const { t } = useTranslation()

  if (!hasSnapshot) {
    return (
      <EmptyQuadrant
        text={t('analyze.bigrams.classes.noSnapshot')}
        testId="analyze-bigrams-classes-no-snapshot"
      />
    )
  }

  const avgByClass: Record<ClassifiedBigramClass, number | null> = {
    left: classAvgOrNull(aggregate.totals.left),
    right: classAvgOrNull(aggregate.totals.right),
    alternation: classAvgOrNull(aggregate.totals.alternation),
    repetition: classAvgOrNull(aggregate.totals.repetition),
  }
  const deltaLeft = avgByClass.left !== null && avgByClass.alternation !== null
    ? avgByClass.left - avgByClass.alternation
    : null
  const deltaRight = avgByClass.right !== null && avgByClass.alternation !== null
    ? avgByClass.right - avgByClass.alternation
    : null

  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="analyze-bigrams-classes-table">
      <table className="w-full text-xs">
        <thead className="text-content-muted">
          <tr>
            <th className="px-2 py-1 text-left font-medium">{t('analyze.bigrams.column.class')}</th>
            <th className="px-2 py-1 text-right font-medium">{t('analyze.bigrams.column.avgIki')}</th>
            <th className="px-2 py-1 text-right font-medium">{t('analyze.bigrams.column.count')}</th>
          </tr>
        </thead>
        <tbody>
          {CLASSIFIED_CLASSES.map((cls) => (
            <tr key={cls} className="border-t border-surface-dim">
              <td className="px-2 py-1">{t(`analyze.bigrams.classes.className.${cls}`)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{fmtMs(avgByClass[cls])}</td>
              <td className="px-2 py-1 text-right tabular-nums">{aggregate.totals[cls].count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div
        className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-content-muted"
        data-testid="analyze-bigrams-classes-delta"
        title={t('analyze.bigrams.classes.deltaTooltip')}
      >
        <span>{t('analyze.bigrams.classes.deltaLeft')}: {fmtDelta(deltaLeft)}</span>
        <span>{t('analyze.bigrams.classes.deltaRight')}: {fmtDelta(deltaRight)}</span>
      </div>
    </div>
  )
}

export type { BigramClassesQuadrantProps }
export { BigramClassesCoverage, classAvgOrNull, fmtDelta, BigramClassesTable }
