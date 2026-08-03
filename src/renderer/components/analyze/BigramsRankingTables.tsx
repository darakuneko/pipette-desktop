// SPDX-License-Identifier: GPL-2.0-or-later
// Top pairs and Pair interval (slow) quadrants for the Analyze Bigrams
// tab, plus the click-to-sort table header machinery they share. Split
// out of BigramsChart.tsx — see that file for the surrounding grid.

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingBigramTopEntry } from '../../../shared/types/typing-analytics'
import { bigramPairLabels, rolloverRatioFromEntry } from './analyze-bigram-format'
import { avgIkiAtOrAboveThreshold, percentileFromHist } from './analyze-bigram-heatmap'
import { fmtMs, formatPercentLabel } from './analyze-format'
import { EmptyQuadrant } from './bigrams-quadrant-ui'
import { Tooltip } from '../ui/Tooltip'

type SortKey = 'count' | 'avgIki' | 'sd' | 'p95' | 'rollover'
/** Columns `TopRanking` sorts on. */
type TopSortKey = 'count' | 'avgIki' | 'sd' | 'rollover'
/** `TopSortKey` plus `p95`, the one extra column `SlowRanking` adds. */
type SlowSortKey = TopSortKey | 'p95'
interface SortState<K extends SortKey> {
  key: K
  dir: 'asc' | 'desc'
}

function compareNumeric(a: number | null, b: number | null, dir: 'asc' | 'desc'): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return dir === 'asc' ? a - b : b - a
}

/** Compares two ranking rows on the currently active sort field. Every
 * sortable field is `number | null`, so a field lookup plus
 * `compareNumeric` replaces a per-field switch for both `TopRanking`
 * and `SlowRanking`. */
function compareBySortKey<K extends SortKey>(
  a: Record<K, number | null>,
  b: Record<K, number | null>,
  sort: SortState<K>,
): number {
  return compareNumeric(a[sort.key], b[sort.key], sort.dir)
}

/** Toggles direction when the clicked column is already active,
 * otherwise switches to that column defaulting to `desc`. */
function toggleSort<K extends SortKey>(prev: SortState<K>, key: K): SortState<K> {
  return prev.key === key
    ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: 'desc' }
}

function sortIndicator<K extends SortKey>(sort: SortState<K>, key: K): string {
  if (sort.key !== key) return ''
  return sort.dir === 'asc' ? ' ▲' : ' ▼'
}

interface SortHeaderProps {
  label: string
  indicator: string
  align: 'left' | 'right'
  active: boolean
  onClick: () => void
  /** Header tooltip. Absent by default — only the trigram Avg IKI header
   * sets one today. */
  title?: string
}

function SortHeader({ label, indicator, align, active, onClick, title }: SortHeaderProps): JSX.Element {
  return (
    <th className={`select-none px-2 py-1 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <Tooltip content={title ?? ''} disabled={!title}>
        <button
          type="button"
          onClick={onClick}
          className={`cursor-pointer ${active ? 'text-content' : 'text-content-muted hover:text-content'}`}
        >
          {label}
          {indicator}
        </button>
      </Tooltip>
    </th>
  )
}

interface TopRankingProps {
  entries: readonly TypingBigramTopEntry[]
  listLimit: number
  gram: 2 | 3
  /** Snapshot-derived `code -> qmkId` map (see `useSnapshotQmkByCode`)
   * threaded into `bigramPairLabels` so pair labels resolve from the
   * snapshot's own recorded keymap instead of the session's
   * `RAWCODES_MAP`. Optional so existing callers/tests keep working
   * unedited — absent, `bigramPairLabels` falls back to its
   * pre-existing behavior. */
  qmkByCode?: ReadonlyMap<number, string>
  vialProtocol?: number
}

/** `TypingBigramTopEntry` plus the derived rollover fraction and
 * resolved pair label, so `compareBySortKey` can sort on the former
 * the same generic way it sorts on count/avgIki/sd — those are raw
 * wire fields, `rollover`/`label` are computed once per visible row
 * instead (label via a single batched `bigramPairLabels` call over the
 * whole capped set, not one `bigramPairLabel` call per rendered row —
 * see that function's doc comment for why that matters when the
 * snapshot's protocol differs from the session's). */
interface TopRow extends TypingBigramTopEntry {
  rollover: number | null
  label: string
}

function TopRanking({ entries, listLimit, gram, qmkByCode, vialProtocol }: TopRankingProps): JSX.Element {
  const { t } = useTranslation()
  const [sort, setSort] = useState<SortState<TopSortKey>>({ key: 'count', dir: 'desc' })
  const toggle = (key: TopSortKey): void => setSort((prev) => toggleSort(prev, key))

  const sliced = useMemo<TopRow[]>(() => {
    const capped = entries.slice(0, Math.max(listLimit, 0))
    const labels = bigramPairLabels(capped.map((e) => e.ngramId), qmkByCode, vialProtocol)
    const arr: TopRow[] = capped.map((e, i) => ({ ...e, rollover: rolloverRatioFromEntry(e), label: labels[i] }))
    arr.sort((a, b) => compareBySortKey(a, b, sort))
    return arr
  }, [entries, listLimit, sort, qmkByCode, vialProtocol])

  if (sliced.length === 0) {
    return <EmptyQuadrant text={t('analyze.bigrams.empty')} />
  }
  return (
    <table className="w-full text-xs" data-testid="analyze-bigrams-top-ranking">
      <thead className="text-content-muted">
        <tr>
          <th className="px-1 py-1 text-right font-medium">#</th>
          <th className="px-2 py-1 text-left font-medium">{t('analyze.bigrams.column.pair')}</th>
          <SortHeader
            align="right"
            label={t('analyze.bigrams.column.count')}
            active={sort.key === 'count'}
            indicator={sortIndicator(sort, 'count')}
            onClick={() => toggle('count')}
          />
          <SortHeader
            align="right"
            label={t('analyze.bigrams.column.avgIki')}
            title={gram === 3 ? t('analyze.bigrams.column.avgIkiTrigramTooltip') : undefined}
            active={sort.key === 'avgIki'}
            indicator={sortIndicator(sort, 'avgIki')}
            onClick={() => toggle('avgIki')}
          />
          <SortHeader
            align="right"
            label={t('analyze.bigrams.column.sd')}
            active={sort.key === 'sd'}
            indicator={sortIndicator(sort, 'sd')}
            onClick={() => toggle('sd')}
          />
          {/* Overlap sampling is bigram-only (see rolloverRatioFromEntry —
           * aggregatePairTotals never populates trigram overlap
           * accumulators), so the column would be all-"—" and inert at
           * gram === 3. Gated the same way avgIkiTrigramTooltip already
           * gates its own gram-specific behavior above. */}
          {gram === 2 && (
            <SortHeader
              align="right"
              label={t('analyze.bigrams.column.rollover')}
              title={t('analyze.bigrams.column.rolloverTooltip')}
              active={sort.key === 'rollover'}
              indicator={sortIndicator(sort, 'rollover')}
              onClick={() => toggle('rollover')}
            />
          )}
        </tr>
      </thead>
      <tbody>
        {sliced.map((entry, i) => (
          <tr key={entry.ngramId} className="border-t border-surface-dim">
            <td className="px-1 py-1 text-right tabular-nums text-content-muted">{i + 1}</td>
            <td className="px-2 py-1 font-mono">{entry.label}</td>
            <td className="px-2 py-1 text-right tabular-nums">{entry.count.toLocaleString()}</td>
            <td className="px-2 py-1 text-right tabular-nums">{fmtMs(entry.avgIki)}</td>
            <td className="px-2 py-1 text-right tabular-nums">{fmtMs(entry.sd)}</td>
            {gram === 2 && <td className="px-2 py-1 text-right tabular-nums">{formatPercentLabel(entry.rollover)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

interface SlowEntry {
  ngramId: string
  count: number
  hist: number[]
  avgIki: number | null
  sd: number | null
  p95: number | null
  rollover: number | null
  label: string
}

interface SlowRankingProps {
  entries: readonly TypingBigramTopEntry[]
  listLimit: number
  /** Shared threshold from `pairIntervalThresholdMs` — see
   * `avgIkiAtOrAboveThreshold` for the bucket-center caveat. */
  minAvgIkiMs: number
  gram: 2 | 3
  /** See `TopRankingProps.qmkByCode`. */
  qmkByCode?: ReadonlyMap<number, string>
  vialProtocol?: number
}

function SlowRanking({ entries, listLimit, minAvgIkiMs, gram, qmkByCode, vialProtocol }: SlowRankingProps): JSX.Element {
  const { t } = useTranslation()
  const [sort, setSort] = useState<SortState<SlowSortKey>>({ key: 'avgIki', dir: 'desc' })
  const toggle = (key: SlowSortKey): void => setSort((prev) => toggleSort(prev, key))

  const slowEntries = useMemo<SlowEntry[]>(() => {
    const eligible: Omit<SlowEntry, 'label'>[] = []
    for (const entry of entries) {
      const avg = avgIkiAtOrAboveThreshold(entry.hist, minAvgIkiMs)
      if (avg === null) continue
      eligible.push({
        ngramId: entry.ngramId,
        count: entry.count,
        hist: entry.hist,
        avgIki: avg,
        sd: entry.sd,
        p95: percentileFromHist(entry.hist, 0.95),
        rollover: rolloverRatioFromEntry(entry),
      })
    }
    eligible.sort((a, b) => compareBySortKey(a, b, sort))
    const capped = eligible.slice(0, Math.max(listLimit, 0))
    const labels = bigramPairLabels(capped.map((e) => e.ngramId), qmkByCode, vialProtocol)
    return capped.map((e, i) => ({ ...e, label: labels[i] }))
  }, [entries, listLimit, minAvgIkiMs, sort, qmkByCode, vialProtocol])

  if (slowEntries.length === 0) {
    return <EmptyQuadrant text={t('analyze.bigrams.empty')} />
  }
  return (
    <table className="w-full text-xs" data-testid="analyze-bigrams-slow-ranking">
      <thead className="text-content-muted">
        <tr>
          <th className="px-1 py-1 text-right font-medium">#</th>
          <th className="px-2 py-1 text-left font-medium">{t('analyze.bigrams.column.pair')}</th>
          <SortHeader
            align="right"
            label={t('analyze.bigrams.column.count')}
            active={sort.key === 'count'}
            indicator={sortIndicator(sort, 'count')}
            onClick={() => toggle('count')}
          />
          <SortHeader
            align="right"
            label={t('analyze.bigrams.column.avgIki')}
            title={gram === 3 ? t('analyze.bigrams.column.avgIkiTrigramTooltip') : undefined}
            active={sort.key === 'avgIki'}
            indicator={sortIndicator(sort, 'avgIki')}
            onClick={() => toggle('avgIki')}
          />
          <SortHeader
            align="right"
            label={t('analyze.bigrams.column.sd')}
            active={sort.key === 'sd'}
            indicator={sortIndicator(sort, 'sd')}
            onClick={() => toggle('sd')}
          />
          <SortHeader
            align="right"
            label={t('analyze.bigrams.column.p95')}
            active={sort.key === 'p95'}
            indicator={sortIndicator(sort, 'p95')}
            onClick={() => toggle('p95')}
          />
          {/* Bigram-only column — see the matching comment in TopRanking. */}
          {gram === 2 && (
            <SortHeader
              align="right"
              label={t('analyze.bigrams.column.rollover')}
              title={t('analyze.bigrams.column.rolloverTooltip')}
              active={sort.key === 'rollover'}
              indicator={sortIndicator(sort, 'rollover')}
              onClick={() => toggle('rollover')}
            />
          )}
        </tr>
      </thead>
      <tbody>
        {slowEntries.map((entry, i) => (
          <tr key={entry.ngramId} className="border-t border-surface-dim">
            <td className="px-1 py-1 text-right tabular-nums text-content-muted">{i + 1}</td>
            <td className="px-2 py-1 font-mono">{entry.label}</td>
            <td className="px-2 py-1 text-right tabular-nums">{entry.count.toLocaleString()}</td>
            <td className="px-2 py-1 text-right tabular-nums">{fmtMs(entry.avgIki)}</td>
            <td className="px-2 py-1 text-right tabular-nums">{fmtMs(entry.sd)}</td>
            <td className="px-2 py-1 text-right tabular-nums">{fmtMs(entry.p95)}</td>
            {gram === 2 && <td className="px-2 py-1 text-right tabular-nums">{formatPercentLabel(entry.rollover)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export type { SortKey, SortState, SortHeaderProps, TopRankingProps, SlowEntry, SlowRankingProps }
export {
  compareNumeric,
  compareBySortKey,
  toggleSort,
  sortIndicator,
  SortHeader,
  TopRanking,
  SlowRanking,
}
