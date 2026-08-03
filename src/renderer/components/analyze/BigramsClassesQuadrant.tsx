// SPDX-License-Identifier: GPL-2.0-or-later
// Bigram pattern quadrant for the Analyze Bigrams tab: hand usage
// (Left / Right / Alternation / Repetition) and word position
// (Initiation / In-word), rendered as two row groups of one table.
// Split out of BigramsChart.tsx — see that file for the surrounding
// grid and for the two aggregate memos, each computed once there and
// passed down rather than recomputed per consumer.

import { useTranslation } from 'react-i18next'
import {
  CLASSIFIED_CLASSES,
  classAvgOrNull,
  type BigramClassAggregate,
  type ClassifiedBigramClass,
} from './analyze-bigram-classes'
import type { WordPositionAggregate } from './analyze-bigram-word-position'
import { EMPTY_STAT_VALUE } from './analyze-constants'
import { fmtMs } from './analyze-format'
import { Tooltip } from '../ui/Tooltip'

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

/** Signed `+N ms` / `-N ms` delta, `'—'` when either side is `null`.
 * Positive means the first-named class was slower — e.g. ΔLeft
 * (Left − Alternation) positive means alternating hands was faster
 * than staying on the left hand, the CHI 2018 headline result; ΔInitiation
 * (Initiation − In-word) positive means starting a word was slower
 * than continuing one. */
function fmtDelta(value: number | null): string {
  if (value === null) return EMPTY_STAT_VALUE
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : ''}${rounded} ms`
}

interface BigramClassesTableProps extends BigramClassesQuadrantProps {
  /** Word-position aggregate computed once by the parent `BigramsChart`
   * — see the "1 calculation, N consumers" note at the call site. Has
   * no `hasSnapshot` gate of its own: unlike hand usage, this section
   * renders unconditionally since it needs no snapshot. */
  wordPositionAggregate: WordPositionAggregate
}

/** One table, two `<tbody>` sections: hand usage (Left / Right /
 * Alternation / Repetition, the CHI 2018 Table 3 classes — needs a
 * snapshot to resolve fingers) and word position (Initiation / In-word
 * — needs only keycode equality against a separator set, so it renders
 * even without one). Each row's average comes from `avgIkiFromHist` on
 * that bucket's own folded histogram (never a mean of two other
 * buckets' averages). */
function BigramClassesTable({
  aggregate,
  wordPositionAggregate,
  hasSnapshot,
}: BigramClassesTableProps): JSX.Element {
  const { t } = useTranslation()

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

  // `WordPositionTotal` is the same `{count, hist}` shape as
  // `BigramClassTotal`, so the hand-usage floor applies unchanged.
  const avgInitiation = classAvgOrNull(wordPositionAggregate.initiation)
  const avgInWord = classAvgOrNull(wordPositionAggregate.inWord)
  const deltaInitiation = avgInitiation !== null && avgInWord !== null
    ? avgInitiation - avgInWord
    : null
  // Mapped the same way as CLASSIFIED_CLASSES above rather than written
  // out as two hand-copied rows, so the cell markup lives in one place
  // for both sections.
  const wordPositionRows = [
    { key: 'initiation', avg: avgInitiation, total: wordPositionAggregate.initiation },
    { key: 'inWord', avg: avgInWord, total: wordPositionAggregate.inWord },
  ] as const

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
        {/* Two `<tbody>` groups, not one: the two sections partition the
            same pairs along different axes, so merging them into a single
            run of rows would read as one six-way split whose counts ought
            to sum. Separate row groups also make `scope="rowgroup"` on the
            section headings true rather than decorative. */}
        <tbody>
          <tr>
            <th
              colSpan={3}
              scope="rowgroup"
              className="px-2 py-1 text-left text-xs font-medium text-content-muted"
              data-testid="analyze-bigrams-classes-section-hand-usage"
            >
              {t('analyze.bigrams.classes.section.handUsage')}
            </th>
          </tr>
          {hasSnapshot ? (
            CLASSIFIED_CLASSES.map((cls) => (
              <tr key={cls} className="border-t border-surface-dim">
                <td className="px-2 py-1">{t(`analyze.bigrams.classes.className.${cls}`)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtMs(avgByClass[cls])}</td>
                <td className="px-2 py-1 text-right tabular-nums">{aggregate.totals[cls].count.toLocaleString()}</td>
              </tr>
            ))
          ) : (
            <tr className="border-t border-surface-dim">
              <td
                colSpan={3}
                className="px-2 py-2 text-center text-content-muted"
                data-testid="analyze-bigrams-classes-no-snapshot"
              >
                {t('analyze.bigrams.classes.noSnapshot')}
              </td>
            </tr>
          )}
        </tbody>
        <tbody>
          <tr>
            <th
              colSpan={3}
              scope="rowgroup"
              className="px-2 py-1 text-left text-xs font-medium text-content-muted"
              data-testid="analyze-bigrams-classes-section-word-position"
            >
              {t('analyze.bigrams.classes.section.wordPosition')}
            </th>
          </tr>
          {wordPositionRows.map((row) => (
            <tr key={row.key} className="border-t border-surface-dim">
              <td className="px-2 py-1">{t(`analyze.bigrams.classes.className.${row.key}`)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{fmtMs(row.avg)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{row.total.count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Tooltip content={t('analyze.bigrams.classes.deltaTooltip')} wrapperClassName="block w-full">
        <div
          className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-content-muted"
          data-testid="analyze-bigrams-classes-delta"
        >
          <span>{t('analyze.bigrams.classes.deltaLeft')}: {fmtDelta(deltaLeft)}</span>
          <span>{t('analyze.bigrams.classes.deltaRight')}: {fmtDelta(deltaRight)}</span>
          <span>{t('analyze.bigrams.classes.deltaInitiation')}: {fmtDelta(deltaInitiation)}</span>
        </div>
      </Tooltip>
      {wordPositionAggregate.excludedCount > 0 && (
        <div className="text-xs text-content-muted" data-testid="analyze-bigrams-classes-excluded-note">
          {t('analyze.bigrams.classes.excludedNote', { count: wordPositionAggregate.excludedCount })}
        </div>
      )}
    </div>
  )
}

export type { BigramClassesQuadrantProps }
export { BigramClassesCoverage, fmtDelta, BigramClassesTable }
