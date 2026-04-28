// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  primaryDeviceScope,
  scopeToSelectValue,
  type DeviceScope,
} from '../../../shared/types/analyze-filters'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import type {
  TypingBigramAggregateResult,
  TypingBigramTopEntry,
  TypingKeymapSnapshot,
} from '../../../shared/types/typing-analytics'
import { fetchBigramAggregateForRange } from './analyze-fetch'
import { bigramPairLabel } from './analyze-bigram-format'
import {
  aggregateFingerPairs,
} from './analyze-bigram-finger'
import { useKeycodeFingerMap } from './use-keycode-finger-map'
import {
  avgIkiFromHist,
  percentileFromHist,
} from './analyze-bigram-heatmap'
import { FILTER_SELECT, LIST_LIMIT_OPTIONS } from './analyze-filter-styles'
import type { RangeMs } from './analyze-types'

interface BigramsChartProps {
  uid: string
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
  topLimit: number
  slowLimit: number
  fingerLimit: number
  keyLimit: number
  onTopLimitChange: (next: number) => void
  onSlowLimitChange: (next: number) => void
  onFingerLimitChange: (next: number) => void
  onKeyLimitChange: (next: number) => void
  snapshot: TypingKeymapSnapshot | null
  fingerOverrides?: Record<string, FingerType>
}

// Pull a high limit so the renderer can derive Top / Slow / Finger /
// Heatmap sub-views from a single fetch instead of 4 round-trips.
const ALL_PAIRS_LIMIT = 5000

export function BigramsChart({
  uid,
  range,
  deviceScopes,
  topLimit,
  slowLimit,
  fingerLimit,
  keyLimit,
  onTopLimitChange,
  onSlowLimitChange,
  onFingerLimitChange,
  onKeyLimitChange,
  snapshot,
  fingerOverrides,
}: BigramsChartProps): JSX.Element {
  const { t } = useTranslation()
  const [result, setResult] = useState<TypingBigramAggregateResult>({ view: 'top', entries: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  const scope = primaryDeviceScope(deviceScopes)
  const scopeKey = scopeToSelectValue(scope)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    fetchBigramAggregateForRange(uid, scope, range.fromMs, range.toMs, 'top', {
      limit: ALL_PAIRS_LIMIT,
    })
      .then((next) => {
        if (cancelled) return
        setResult(next)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        console.error('BigramsChart: typingAnalyticsGetBigramAggregateForRange failed', err)
        setError(true)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // scope is captured inside the effect via closure but not listed —
    // scopeKey is the stable identity proxy.
  }, [uid, range.fromMs, range.toMs, scopeKey])

  const entries = result.entries

  if (loading) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-bigrams-loading">
        {t('analyze.bigrams.loading')}
      </div>
    )
  }
  if (error) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-bigrams-error">
        {t('analyze.bigrams.error')}
      </div>
    )
  }
  if (entries.length === 0) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-bigrams-empty">
        {t('analyze.bigrams.empty')}
      </div>
    )
  }

  return (
    <div
      className="grid h-full min-h-0 grid-cols-2 grid-rows-2 gap-3"
      data-testid="analyze-bigrams-content"
    >
      <Quadrant
        title={t('analyze.bigrams.quadrant.top')}
        controls={
          <LimitSelect
            value={topLimit}
            onChange={onTopLimitChange}
            testId="analyze-bigrams-top-limit-select"
          />
        }
      >
        <TopRanking entries={entries} listLimit={topLimit} />
      </Quadrant>
      <Quadrant
        title={t('analyze.bigrams.quadrant.slow')}
        controls={
          <LimitSelect
            value={slowLimit}
            onChange={onSlowLimitChange}
            testId="analyze-bigrams-slow-limit-select"
          />
        }
      >
        <SlowRanking entries={entries} listLimit={slowLimit} />
      </Quadrant>
      <Quadrant
        title={t('analyze.bigrams.quadrant.fingerIki')}
        controls={
          <LimitSelect
            value={fingerLimit}
            onChange={onFingerLimitChange}
            testId="analyze-bigrams-finger-limit-select"
          />
        }
      >
        <BigramFingerBarChart
          entries={entries}
          snapshot={snapshot}
          fingerOverrides={fingerOverrides}
          listLimit={fingerLimit}
        />
      </Quadrant>
      <Quadrant
        title={t('analyze.bigrams.quadrant.heatmap')}
        controls={
          <LimitSelect
            value={keyLimit}
            onChange={onKeyLimitChange}
            testId="analyze-bigrams-key-limit-select"
          />
        }
      >
        <BigramKeyBarChart entries={entries} listLimit={keyLimit} />
      </Quadrant>
    </div>
  )
}

interface QuadrantProps {
  title: string
  controls?: React.ReactNode
  children: React.ReactNode
}

function Quadrant({ title, controls, children }: QuadrantProps): JSX.Element {
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-2 rounded border border-edge p-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[12px] font-medium text-content">{title}</div>
        {controls}
      </div>
      <div className="min-h-0 flex-1 overflow-auto pr-1">{children}</div>
    </div>
  )
}

interface LimitSelectProps {
  value: number
  onChange: (next: number) => void
  testId: string
}

function LimitSelect({ value, onChange, testId }: LimitSelectProps): JSX.Element {
  const options = LIST_LIMIT_OPTIONS.includes(value)
    ? LIST_LIMIT_OPTIONS
    : [...LIST_LIMIT_OPTIONS, value].sort((a, b) => a - b)
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      data-testid={testId}
      className={FILTER_SELECT}
    >
      {options.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  )
}

type SortKey = 'count' | 'avgIki' | 'p95'
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

interface TopRankingProps {
  entries: readonly TypingBigramTopEntry[]
  listLimit: number
}

function TopRanking({ entries, listLimit }: TopRankingProps): JSX.Element {
  const { t } = useTranslation()
  const [sort, setSort] = useState<SortState<'count' | 'avgIki'>>({ key: 'count', dir: 'desc' })

  const sliced = useMemo(() => {
    const arr = [...entries].slice(0, Math.max(listLimit, 0))
    arr.sort((a, b) => {
      switch (sort.key) {
        case 'count':
          return sort.dir === 'asc' ? a.count - b.count : b.count - a.count
        case 'avgIki':
          return compareNumeric(a.avgIki, b.avgIki, sort.dir)
      }
    })
    return arr
  }, [entries, listLimit, sort])

  if (sliced.length === 0) {
    return <EmptyQuadrant text={t('analyze.bigrams.empty')} />
  }
  return (
    <table className="w-full text-[12px]">
      <thead className="text-content-muted">
        <tr>
          <th className="px-1 py-1 text-right font-medium">#</th>
          <th className="px-2 py-1 text-left font-medium">{t('analyze.bigrams.column.pair')}</th>
          <SortHeader
            align="right"
            label={t('analyze.bigrams.column.count')}
            active={sort.key === 'count'}
            indicator={sortIndicator(sort, 'count')}
            onClick={() =>
              setSort((prev) => (prev.key === 'count'
                ? { key: 'count', dir: prev.dir === 'asc' ? 'desc' : 'asc' }
                : { key: 'count', dir: 'desc' }))
            }
          />
          <SortHeader
            align="right"
            label={t('analyze.bigrams.column.avgIki')}
            active={sort.key === 'avgIki'}
            indicator={sortIndicator(sort, 'avgIki')}
            onClick={() =>
              setSort((prev) => (prev.key === 'avgIki'
                ? { key: 'avgIki', dir: prev.dir === 'asc' ? 'desc' : 'asc' }
                : { key: 'avgIki', dir: 'desc' }))
            }
          />
        </tr>
      </thead>
      <tbody>
        {sliced.map((entry, i) => (
          <tr key={entry.bigramId} className="border-t border-surface-dim">
            <td className="px-1 py-1 text-right tabular-nums text-content-muted">{i + 1}</td>
            <td className="px-2 py-1 font-mono">{bigramPairLabel(entry.bigramId)}</td>
            <td className="px-2 py-1 text-right tabular-nums">{entry.count.toLocaleString()}</td>
            <td className="px-2 py-1 text-right tabular-nums">
              {entry.avgIki !== null ? `${Math.round(entry.avgIki)} ms` : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

interface SlowEntry {
  bigramId: string
  count: number
  hist: number[]
  avgIki: number | null
  p95: number | null
}

interface SlowRankingProps {
  entries: readonly TypingBigramTopEntry[]
  listLimit: number
}

function SlowRanking({ entries, listLimit }: SlowRankingProps): JSX.Element {
  const { t } = useTranslation()
  const [sort, setSort] = useState<SortState<'count' | 'avgIki' | 'p95'>>({ key: 'avgIki', dir: 'desc' })

  const slowEntries = useMemo<SlowEntry[]>(() => {
    const eligible: SlowEntry[] = []
    for (const entry of entries) {
      const avg = avgIkiFromHist(entry.hist)
      if (avg === null) continue
      eligible.push({
        bigramId: entry.bigramId,
        count: entry.count,
        hist: entry.hist,
        avgIki: avg,
        p95: percentileFromHist(entry.hist, 0.95),
      })
    }
    eligible.sort((a, b) => {
      switch (sort.key) {
        case 'count':
          return sort.dir === 'asc' ? a.count - b.count : b.count - a.count
        case 'avgIki':
          return compareNumeric(a.avgIki, b.avgIki, sort.dir)
        case 'p95':
          return compareNumeric(a.p95, b.p95, sort.dir)
      }
    })
    return eligible.slice(0, Math.max(listLimit, 0))
  }, [entries, listLimit, sort])

  if (slowEntries.length === 0) {
    return <EmptyQuadrant text={t('analyze.bigrams.empty')} />
  }
  return (
    <table className="w-full text-[12px]">
      <thead className="text-content-muted">
        <tr>
          <th className="px-1 py-1 text-right font-medium">#</th>
          <th className="px-2 py-1 text-left font-medium">{t('analyze.bigrams.column.pair')}</th>
          <SortHeader
            align="right"
            label={t('analyze.bigrams.column.count')}
            active={sort.key === 'count'}
            indicator={sortIndicator(sort, 'count')}
            onClick={() =>
              setSort((prev) => (prev.key === 'count'
                ? { key: 'count', dir: prev.dir === 'asc' ? 'desc' : 'asc' }
                : { key: 'count', dir: 'desc' }))
            }
          />
          <SortHeader
            align="right"
            label={t('analyze.bigrams.column.avgIki')}
            active={sort.key === 'avgIki'}
            indicator={sortIndicator(sort, 'avgIki')}
            onClick={() =>
              setSort((prev) => (prev.key === 'avgIki'
                ? { key: 'avgIki', dir: prev.dir === 'asc' ? 'desc' : 'asc' }
                : { key: 'avgIki', dir: 'desc' }))
            }
          />
          <SortHeader
            align="right"
            label={t('analyze.bigrams.column.p95')}
            active={sort.key === 'p95'}
            indicator={sortIndicator(sort, 'p95')}
            onClick={() =>
              setSort((prev) => (prev.key === 'p95'
                ? { key: 'p95', dir: prev.dir === 'asc' ? 'desc' : 'asc' }
                : { key: 'p95', dir: 'desc' }))
            }
          />
        </tr>
      </thead>
      <tbody>
        {slowEntries.map((entry, i) => (
          <tr key={entry.bigramId} className="border-t border-surface-dim">
            <td className="px-1 py-1 text-right tabular-nums text-content-muted">{i + 1}</td>
            <td className="px-2 py-1 font-mono">{bigramPairLabel(entry.bigramId)}</td>
            <td className="px-2 py-1 text-right tabular-nums">{entry.count.toLocaleString()}</td>
            <td className="px-2 py-1 text-right tabular-nums">
              {entry.avgIki !== null ? `${Math.round(entry.avgIki)} ms` : '—'}
            </td>
            <td className="px-2 py-1 text-right tabular-nums">
              {entry.p95 !== null ? `${Math.round(entry.p95)} ms` : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
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
}

function SortHeader({ label, indicator, align, active, onClick }: SortHeaderProps): JSX.Element {
  return (
    <th className={`select-none px-2 py-1 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        type="button"
        onClick={onClick}
        className={`cursor-pointer ${active ? 'text-content' : 'text-content-muted hover:text-content'}`}
      >
        {label}
        {indicator}
      </button>
    </th>
  )
}

function EmptyQuadrant({ text }: { text: string }): JSX.Element {
  return <div className="py-4 text-center text-[12px] text-content-muted">{text}</div>
}

interface FingerBarChartProps {
  entries: readonly TypingBigramTopEntry[]
  snapshot: TypingKeymapSnapshot | null
  fingerOverrides?: Record<string, FingerType>
  listLimit: number
}

function BigramFingerBarChart({
  entries,
  snapshot,
  fingerOverrides,
  listLimit,
}: FingerBarChartProps): JSX.Element {
  const { t } = useTranslation()
  const fingerMap = useKeycodeFingerMap(snapshot, fingerOverrides)
  const data = useMemo<BarDatum[]>(() => {
    if (fingerMap.size === 0) return []
    const totals = aggregateFingerPairs(entries, fingerMap)
    const ranked: BarDatum[] = []
    for (const [pairKey, total] of totals) {
      const avg = avgIkiFromHist(total.hist)
      if (avg === null) continue
      const [fromFinger, toFinger] = pairKey.split('_') as [FingerType, FingerType]
      const fromLabel = t(`analyze.finger.short.${fromFinger}`)
      const toLabel = t(`analyze.finger.short.${toFinger}`)
      ranked.push({
        id: pairKey,
        label: `${fromLabel} → ${toLabel}`,
        value: avg,
        count: total.count,
        color: fromFinger.startsWith('left-') ? BAR_LEFT : BAR_RIGHT,
      })
    }
    ranked.sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
    return ranked.slice(0, Math.max(listLimit, 0))
  }, [entries, fingerMap, listLimit, t])

  if (snapshot === null) {
    return (
      <div className="py-4 text-center text-[12px] text-content-muted" data-testid="analyze-bigrams-finger-no-snapshot">
        {t('analyze.bigrams.fingerIki.noSnapshot')}
      </div>
    )
  }
  if (data.length === 0) {
    return <EmptyQuadrant text={t('analyze.bigrams.empty')} />
  }
  return (
    <div data-testid="analyze-bigrams-finger-bars">
      <BigramBarChart data={data} yAxisWidth={70} unit="ms" />
    </div>
  )
}

interface KeyBarChartProps {
  entries: readonly TypingBigramTopEntry[]
  listLimit: number
}

function BigramKeyBarChart({ entries, listLimit }: KeyBarChartProps): JSX.Element {
  const { t } = useTranslation()
  const data = useMemo<BarDatum[]>(() => {
    const ranked: BarDatum[] = []
    for (const entry of entries) {
      if (entry.avgIki === null) continue
      ranked.push({
        id: entry.bigramId,
        label: bigramPairLabel(entry.bigramId),
        value: entry.avgIki,
        count: entry.count,
        color: BAR_LEFT,
      })
    }
    ranked.sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
    return ranked.slice(0, Math.max(listLimit, 0))
  }, [entries, listLimit])

  if (data.length === 0) {
    return <EmptyQuadrant text={t('analyze.bigrams.empty')} />
  }
  return (
    <div data-testid="analyze-bigrams-key-bars">
      <BigramBarChart data={data} yAxisWidth={56} unit="ms" />
    </div>
  )
}

const BAR_LEFT = '#3b82f6'
const BAR_RIGHT = '#ef4444'

interface BarDatum {
  id: string
  label: string
  value: number
  count: number
  color: string
}

const BAR_ROW_PX = 24
const CHART_VERTICAL_PADDING_PX = 16

interface BigramBarChartProps {
  data: BarDatum[]
  yAxisWidth: number
  unit: string
}

/** Horizontal bar chart shared by the Finger and Key bigram quadrants.
 * Each row is one categorical bar; height is sized to fit the row count
 * so the parent quadrant's `overflow-auto` handles long lists. recharts'
 * native Tooltip provides the cursor-following bubble that matches the
 * Ergonomics tab's bar charts. */
function BigramBarChart({ data, yAxisWidth, unit }: BigramBarChartProps): JSX.Element {
  // Floor at 120px so single-row charts don't squeeze the axis labels.
  const height = Math.max(120, data.length * BAR_ROW_PX + CHART_VERTICAL_PADDING_PX * 2 + 24)
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: CHART_VERTICAL_PADDING_PX, right: 40, bottom: CHART_VERTICAL_PADDING_PX, left: 4 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" horizontal={false} />
          <XAxis
            type="number"
            stroke="var(--color-content-muted)"
            fontSize={11}
            tickFormatter={(v) => `${Math.round(Number(v))}`}
          />
          <YAxis
            type="category"
            dataKey="label"
            stroke="var(--color-content-muted)"
            fontSize={11}
            width={yAxisWidth}
            interval={0}
          />
          <Tooltip
            cursor={{ fill: 'var(--color-surface-dim)' }}
            content={(p) => <BigramCellTooltip {...p} />}
          />
          <Bar dataKey="value" isAnimationActive={false}>
            {data.map((row) => (
              <Cell key={row.id} fill={row.color} />
            ))}
            <LabelList
              dataKey="value"
              position="right"
              formatter={(v: unknown) => `${Math.round(Number(v))} ${unit}`}
              style={{ fill: 'var(--color-content-muted)', fontSize: 11 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

interface BigramCellTooltipProps {
  active?: boolean
  label?: unknown
  payload?: ReadonlyArray<{ payload?: BarDatum }>
}

/** recharts content renderer — the default `formatter` path renders a
 * leading separator when the item name is empty, and threading a name
 * through every row would obscure the per-bigram label that's already
 * on the Y axis. Owning the markup keeps the bubble compact. */
function BigramCellTooltip({ active, label, payload }: BigramCellTooltipProps): JSX.Element | null {
  const { t } = useTranslation()
  if (!active || !payload?.length) return null
  const datum = payload[0]?.payload
  if (!datum) return null
  const displayLabel = typeof label === 'string' || typeof label === 'number' ? label : datum.label
  return (
    <div
      style={{
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-edge)',
        color: 'var(--color-content)',
        fontSize: 12,
        padding: '4px 8px',
        borderRadius: 4,
      }}
    >
      <div style={{ color: 'var(--color-content-secondary)' }}>{displayLabel}</div>
      <div>
        {t('analyze.bigrams.cellTooltip', {
          count: datum.count,
          avgIki: Math.round(datum.value),
        })}
      </div>
    </div>
  )
}
