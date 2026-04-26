// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  primaryDeviceScope,
  scopeToSelectValue,
  type DeviceScope,
} from '../../../shared/types/analyze-filters'
import {
  FINGER_LIST,
  type FingerType,
} from '../../../shared/kle/kle-ergonomics'
import type { KeyboardLayout } from '../../../shared/kle/types'
import type {
  TypingBigramAggregateResult,
  TypingBigramTopEntry,
  TypingKeymapSnapshot,
} from '../../../shared/types/typing-analytics'
import { fetchBigramAggregateForRange } from './analyze-fetch'
import { bigramPairLabel } from './analyze-bigram-format'
import {
  aggregateFingerPairs,
  buildKeycodeFingerMap,
  type FingerPairTotal,
} from './analyze-bigram-finger'
import {
  aggregateKeyHeatmap,
  avgIkiFromHist,
  percentileFromHist,
  type BigramHeatmapCell,
} from './analyze-bigram-heatmap'
import { codeToLabel } from '../../../shared/keycodes/keycodes'
import type { RangeMs } from './analyze-types'

interface BigramsChartProps {
  uid: string
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
  minSample: number
  listLimit: number
  onMinSampleChange: (next: number) => void
  onListLimitChange: (next: number) => void
  snapshot: TypingKeymapSnapshot | null
  fingerOverrides?: Record<string, FingerType>
}

// Pull a high limit so the renderer can derive Top / Slow / Finger /
// Heatmap sub-views from a single fetch instead of 4 round-trips.
const ALL_PAIRS_LIMIT = 5000
const HEATMAP_TOP_KEYS = 12
const MIN_SAMPLE_BOUND = 1
const MAX_SAMPLE_BOUND = 1000
const LIST_LIMIT_BOUND = 1
const LIST_LIMIT_MAX = 100

export function BigramsChart({
  uid,
  range,
  deviceScopes,
  minSample,
  listLimit,
  onMinSampleChange,
  onListLimitChange,
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
    // Single fetch: server returns count-sorted entries; the Slow
    // ranking is recomputed client-side off this same payload so we
    // don't double-call the IPC.
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
      className="flex h-full min-h-0 flex-col gap-3"
      data-testid="analyze-bigrams-content"
    >
      <BigramsFilters
        minSample={minSample}
        listLimit={listLimit}
        onMinSampleChange={onMinSampleChange}
        onListLimitChange={onListLimitChange}
      />
      {/* 2x2 quadrant: top / slow rankings on the upper row, finger /
       * pair heatmaps on the lower row. Each quadrant manages its own
       * scroll so the long lists don't push the heatmaps off-screen. */}
      <div className="grid h-full min-h-0 grid-cols-2 grid-rows-2 gap-3">
        <Quadrant title={t('analyze.bigrams.quadrant.top')}>
          <TopRanking entries={entries} listLimit={listLimit} />
        </Quadrant>
        <Quadrant title={t('analyze.bigrams.quadrant.slow')}>
          <SlowRanking entries={entries} minSample={minSample} listLimit={listLimit} />
        </Quadrant>
        <Quadrant title={t('analyze.bigrams.quadrant.fingerIki')}>
          <BigramFingerHeatmap entries={entries} snapshot={snapshot} fingerOverrides={fingerOverrides} />
        </Quadrant>
        <Quadrant title={t('analyze.bigrams.quadrant.heatmap')}>
          <BigramKeyHeatmap entries={entries} />
        </Quadrant>
      </div>
    </div>
  )
}

interface QuadrantProps {
  title: string
  children: React.ReactNode
}

function Quadrant({ title, children }: QuadrantProps): JSX.Element {
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-2 rounded border border-edge p-2">
      <div className="text-[12px] font-medium text-content">{title}</div>
      <div className="min-h-0 flex-1 overflow-auto pr-1">{children}</div>
    </div>
  )
}

interface FiltersProps {
  minSample: number
  listLimit: number
  onMinSampleChange: (next: number) => void
  onListLimitChange: (next: number) => void
}

function BigramsFilters({
  minSample,
  listLimit,
  onMinSampleChange,
  onListLimitChange,
}: FiltersProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-end gap-3 text-[13px]">
      <label className="flex flex-col gap-1">
        <span className="text-content-muted">{t('analyze.bigrams.listLimit')}</span>
        <input
          type="number"
          min={LIST_LIMIT_BOUND}
          max={LIST_LIMIT_MAX}
          value={listLimit}
          onChange={(e) => {
            const parsed = Number(e.target.value)
            if (!Number.isFinite(parsed)) return
            const clamped = Math.max(LIST_LIMIT_BOUND, Math.min(LIST_LIMIT_MAX, Math.floor(parsed)))
            onListLimitChange(clamped)
          }}
          data-testid="analyze-bigrams-list-limit-input"
          className="w-20 rounded border border-surface-dim bg-surface px-2 py-1 tabular-nums"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-content-muted">{t('analyze.bigrams.minSample')}</span>
        <input
          type="number"
          min={MIN_SAMPLE_BOUND}
          max={MAX_SAMPLE_BOUND}
          value={minSample}
          onChange={(e) => {
            const parsed = Number(e.target.value)
            if (!Number.isFinite(parsed)) return
            const clamped = Math.max(MIN_SAMPLE_BOUND, Math.min(MAX_SAMPLE_BOUND, Math.floor(parsed)))
            onMinSampleChange(clamped)
          }}
          data-testid="analyze-bigrams-min-sample-input"
          className="w-20 rounded border border-surface-dim bg-surface px-2 py-1 tabular-nums"
        />
      </label>
    </div>
  )
}

interface TopRankingProps {
  entries: readonly TypingBigramTopEntry[]
  listLimit: number
}

function TopRanking({ entries, listLimit }: TopRankingProps): JSX.Element {
  const { t } = useTranslation()
  const sliced = useMemo(() => entries.slice(0, listLimit), [entries, listLimit])
  const maxCount = sliced.reduce((acc, e) => Math.max(acc, e.count), 1)
  if (sliced.length === 0) {
    return <EmptyQuadrant text={t('analyze.bigrams.empty')} />
  }
  return (
    <table className="w-full text-[12px]">
      <thead className="text-content-muted">
        <tr>
          <th className="px-2 py-1 text-left font-medium">{t('analyze.bigrams.column.pair')}</th>
          <th className="px-2 py-1 text-right font-medium">{t('analyze.bigrams.column.count')}</th>
          <th className="px-2 py-1 text-right font-medium">{t('analyze.bigrams.column.avgIki')}</th>
          <th className="px-2 py-1 text-left font-medium">{t('analyze.bigrams.column.bar')}</th>
        </tr>
      </thead>
      <tbody>
        {sliced.map((entry) => (
          <tr key={entry.bigramId} className="border-t border-surface-dim">
            <td className="px-2 py-1 font-mono">{bigramPairLabel(entry.bigramId)}</td>
            <td className="px-2 py-1 text-right tabular-nums">{entry.count.toLocaleString()}</td>
            <td className="px-2 py-1 text-right tabular-nums">
              {entry.avgIki !== null ? `${Math.round(entry.avgIki)} ms` : '—'}
            </td>
            <td className="px-2 py-1">
              <div className="h-2 rounded bg-surface-dim">
                <div
                  className="h-full rounded bg-accent"
                  style={{ width: `${Math.round((entry.count / maxCount) * 100)}%` }}
                />
              </div>
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
  minSample: number
  listLimit: number
}

function SlowRanking({ entries, minSample, listLimit }: SlowRankingProps): JSX.Element {
  const { t } = useTranslation()
  const slowEntries = useMemo<SlowEntry[]>(() => {
    const eligible: SlowEntry[] = []
    for (const entry of entries) {
      if (entry.count < minSample) continue
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
    eligible.sort((a, b) => (b.avgIki ?? 0) - (a.avgIki ?? 0) || a.bigramId.localeCompare(b.bigramId))
    return eligible.slice(0, listLimit)
  }, [entries, minSample, listLimit])
  if (slowEntries.length === 0) {
    return <EmptyQuadrant text={t('analyze.bigrams.empty')} />
  }
  return (
    <table className="w-full text-[12px]">
      <thead className="text-content-muted">
        <tr>
          <th className="px-2 py-1 text-left font-medium">{t('analyze.bigrams.column.pair')}</th>
          <th className="px-2 py-1 text-right font-medium">{t('analyze.bigrams.column.count')}</th>
          <th className="px-2 py-1 text-right font-medium">{t('analyze.bigrams.column.avgIki')}</th>
          <th className="px-2 py-1 text-right font-medium">{t('analyze.bigrams.column.p95')}</th>
        </tr>
      </thead>
      <tbody>
        {slowEntries.map((entry) => (
          <tr key={entry.bigramId} className="border-t border-surface-dim">
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

function EmptyQuadrant({ text }: { text: string }): JSX.Element {
  return (
    <div className="py-4 text-center text-[12px] text-content-muted">{text}</div>
  )
}

interface FingerHeatmapProps {
  entries: readonly TypingBigramTopEntry[]
  snapshot: TypingKeymapSnapshot | null
  fingerOverrides?: Record<string, FingerType>
}

function BigramFingerHeatmap({ entries, snapshot, fingerOverrides }: FingerHeatmapProps): JSX.Element {
  const { t } = useTranslation()
  const totals = useMemo(() => {
    if (snapshot === null) return new Map<string, FingerPairTotal>()
    const layout = snapshot.layout as KeyboardLayout | null
    const keys = layout?.keys ?? []
    if (keys.length === 0) return new Map<string, FingerPairTotal>()
    const fingerMap = buildKeycodeFingerMap(snapshot, keys, fingerOverrides)
    return aggregateFingerPairs(entries, fingerMap)
  }, [entries, snapshot, fingerOverrides])

  if (snapshot === null) {
    return (
      <div className="py-4 text-center text-[12px] text-content-muted" data-testid="analyze-bigrams-finger-no-snapshot">
        {t('analyze.bigrams.fingerIki.noSnapshot')}
      </div>
    )
  }

  const cells: { key: string; count: number; avgIki: number | null }[] = []
  let maxAvg = 0
  for (const f1 of FINGER_LIST) {
    for (const f2 of FINGER_LIST) {
      const key = `${f1}_${f2}`
      const total = totals.get(key)
      const avgIki = total ? avgIkiFromHist(total.hist) : null
      if (avgIki !== null && avgIki > maxAvg) maxAvg = avgIki
      cells.push({ key, count: total?.count ?? 0, avgIki })
    }
  }

  return (
    <table className="text-[11px]" data-testid="analyze-bigrams-finger-heatmap">
      <thead>
        <tr>
          <th className="px-1 py-1" />
          {FINGER_LIST.map((f) => (
            <th key={f} className="px-1 py-1 text-center font-medium text-content-muted">
              {t(`analyze.ergonomics.finger.${f}`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {FINGER_LIST.map((f1) => (
          <tr key={f1}>
            <th className="px-1 py-1 text-right font-medium text-content-muted">
              {t(`analyze.ergonomics.finger.${f1}`)}
            </th>
            {FINGER_LIST.map((f2) => {
              const cell = cells.find((c) => c.key === `${f1}_${f2}`)
              const avgIki = cell?.avgIki ?? null
              const isSfb = f1 === f2
              return (
                <td
                  key={f2}
                  className={`relative px-1 py-1 text-center tabular-nums ${isSfb ? 'ring-1 ring-accent' : ''}`}
                  style={{
                    backgroundColor: avgIki !== null ? heatmapColor(avgIki, maxAvg) : 'transparent',
                  }}
                  title={
                    avgIki !== null && cell
                      ? `${cell.count} × avg ${Math.round(avgIki)} ms`
                      : undefined
                  }
                >
                  {avgIki !== null ? Math.round(avgIki) : '—'}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

interface KeyHeatmapProps {
  entries: readonly TypingBigramTopEntry[]
}

function BigramKeyHeatmap({ entries }: KeyHeatmapProps): JSX.Element {
  const { keys, cells } = useMemo(() => aggregateKeyHeatmap(entries, HEATMAP_TOP_KEYS), [entries])

  let maxAvg = 0
  const avgGrid: (number | null)[][] = cells.map((row) =>
    row.map((cell) => {
      if (!cell) return null
      const avg = avgIkiFromHist(cell.hist)
      if (avg !== null && avg > maxAvg) maxAvg = avg
      return avg
    }),
  )

  return (
    <table className="text-[11px]" data-testid="analyze-bigrams-key-heatmap">
      <thead>
        <tr>
          <th className="px-1 py-1" />
          {keys.map((k) => (
            <th key={k} className="px-1 py-1 text-center font-medium text-content-muted">
              {codeToLabel(k)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {keys.map((kFrom, i) => (
          <tr key={kFrom}>
            <th className="px-1 py-1 text-right font-medium text-content-muted">
              {codeToLabel(kFrom)}
            </th>
            {keys.map((kTo, j) => {
              const cell: BigramHeatmapCell | null = cells[i][j]
              const avg = avgGrid[i][j]
              return (
                <td
                  key={kTo}
                  className="px-1 py-1 text-center tabular-nums"
                  style={{
                    backgroundColor: avg !== null ? heatmapColor(avg, maxAvg) : 'transparent',
                  }}
                  title={
                    cell !== null && avg !== null
                      ? `${cell.count} × avg ${Math.round(avg)} ms`
                      : undefined
                  }
                >
                  {avg !== null ? Math.round(avg) : '—'}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Map an IKI in [0, max] to a cool→warm CSS color string. Higher
 * values are warmer (slower bigrams stand out). */
function heatmapColor(iki: number, max: number): string {
  if (max <= 0) return 'transparent'
  const t = Math.min(1, Math.max(0, iki / max))
  const hue = 220 - 220 * t
  return `hsl(${hue}, 60%, 70%)`
}
