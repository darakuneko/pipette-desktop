// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BIGRAM_VIEWS,
  primaryDeviceScope,
  scopeToSelectValue,
  type BigramView,
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
  avgIkiFromHist as avgIkiFromHistRenderer,
  type BigramHeatmapCell,
} from './analyze-bigram-heatmap'
import { codeToLabel } from '../../../shared/keycodes/keycodes'
import type { RangeMs } from './analyze-types'

interface BigramsChartProps {
  uid: string
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
  view: BigramView
  minSample: number
  onViewChange: (next: BigramView) => void
  onMinSampleChange: (next: number) => void
  /** Snapshot is required for the Finger IKI view (keycode → finger
   * resolution). Top / Slow / Heatmap render without it. */
  snapshot: TypingKeymapSnapshot | null
  fingerOverrides?: Record<string, FingerType>
}

const TOP_LIMIT = 30
// Finger / heatmap views aggregate across all observed pairs; bump the
// fetch limit so the renderer is not throttled before grouping.
const ALL_PAIRS_LIMIT = 5000
const HEATMAP_TOP_KEYS = 12
const MIN_SAMPLE_BOUND = 1
const MAX_SAMPLE_BOUND = 1000

function effectiveIpcView(uiView: BigramView): 'top' | 'slow' {
  return uiView === 'slow' ? 'slow' : 'top'
}

function effectiveLimit(uiView: BigramView): number {
  return uiView === 'top' || uiView === 'slow' ? TOP_LIMIT : ALL_PAIRS_LIMIT
}

export function BigramsChart({
  uid,
  range,
  deviceScopes,
  view,
  minSample,
  onViewChange,
  onMinSampleChange,
  snapshot,
  fingerOverrides,
}: BigramsChartProps): JSX.Element {
  const [result, setResult] = useState<TypingBigramAggregateResult>({ view: 'top', entries: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  const scope = primaryDeviceScope(deviceScopes)
  const scopeKey = scopeToSelectValue(scope)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    const ipcView = effectiveIpcView(view)
    fetchBigramAggregateForRange(uid, scope, range.fromMs, range.toMs, ipcView, {
      minSampleCount: ipcView === 'slow' ? minSample : undefined,
      limit: effectiveLimit(view),
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
  }, [uid, range.fromMs, range.toMs, view, scopeKey, minSample])

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3"
      data-testid="analyze-bigrams-content"
    >
      <BigramsFilters
        view={view}
        onViewChange={onViewChange}
        minSample={minSample}
        onMinSampleChange={onMinSampleChange}
      />
      {/* Filters stay pinned; the body scrolls inside the remaining
       * height so a long ranking / wide heatmap doesn't push the
       * sidebar's back button off screen. */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <BigramsBody
          loading={loading}
          error={error}
          result={result}
          view={view}
          snapshot={snapshot}
          fingerOverrides={fingerOverrides}
        />
      </div>
    </div>
  )
}

interface FiltersProps {
  view: BigramView
  onViewChange: (next: BigramView) => void
  minSample: number
  onMinSampleChange: (next: number) => void
}

function BigramsFilters({ view, onViewChange, minSample, onMinSampleChange }: FiltersProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-end gap-3 text-[13px]">
      <label className="flex flex-col gap-1">
        <span className="text-content-muted">{t('analyze.bigrams.viewLabel')}</span>
        <select
          value={view}
          onChange={(e) => {
            const next = e.target.value as BigramView
            if (BIGRAM_VIEWS.includes(next)) onViewChange(next)
          }}
          data-testid="analyze-bigrams-view-select"
          className="rounded border border-surface-dim bg-surface px-2 py-1"
        >
          {BIGRAM_VIEWS.map((v) => (
            <option key={v} value={v}>
              {t(`analyze.bigrams.view.${v}`)}
            </option>
          ))}
        </select>
      </label>
      {view === 'slow' && (
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
      )}
    </div>
  )
}

interface BodyProps {
  loading: boolean
  error: boolean
  result: TypingBigramAggregateResult
  view: BigramView
  snapshot: TypingKeymapSnapshot | null
  fingerOverrides?: Record<string, FingerType>
}

function BigramsBody({ loading, error, result, view, snapshot, fingerOverrides }: BodyProps): JSX.Element {
  const { t } = useTranslation()
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
  if (result.entries.length === 0) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-bigrams-empty">
        {t('analyze.bigrams.empty')}
      </div>
    )
  }
  if (view === 'fingerIki') {
    return <BigramFingerHeatmap entries={result.entries} snapshot={snapshot} fingerOverrides={fingerOverrides} />
  }
  if (view === 'heatmap') {
    return <BigramKeyHeatmap entries={result.entries} />
  }
  return <BigramRankingTable result={result} />
}

interface RankingTableProps {
  result: TypingBigramAggregateResult
}

function BigramRankingTable({ result }: RankingTableProps): JSX.Element {
  const { t } = useTranslation()
  const isSlow = result.view === 'slow'
  const maxCount = result.entries.reduce((acc, e) => Math.max(acc, e.count), 1)

  return (
    <table className="w-full text-[13px]">
      <thead className="text-content-muted">
        <tr>
          <th className="px-2 py-1 text-left font-medium">{t('analyze.bigrams.column.pair')}</th>
          <th className="px-2 py-1 text-right font-medium">{t('analyze.bigrams.column.count')}</th>
          <th className="px-2 py-1 text-right font-medium">{t('analyze.bigrams.column.avgIki')}</th>
          {isSlow && (
            <th className="px-2 py-1 text-right font-medium">{t('analyze.bigrams.column.p95')}</th>
          )}
          <th className="px-2 py-1 text-left font-medium">{t('analyze.bigrams.column.bar')}</th>
        </tr>
      </thead>
      <tbody>
        {result.entries.map((entry) => (
          <tr key={entry.bigramId} className="border-t border-surface-dim">
            <td className="px-2 py-1 font-mono">{bigramPairLabel(entry.bigramId)}</td>
            <td className="px-2 py-1 text-right tabular-nums">{entry.count.toLocaleString()}</td>
            <td className="px-2 py-1 text-right tabular-nums">
              {entry.avgIki !== null ? `${Math.round(entry.avgIki)} ms` : '—'}
            </td>
            {isSlow && (
              <td className="px-2 py-1 text-right tabular-nums">
                {'p95' in entry && entry.p95 !== null ? `${Math.round(entry.p95)} ms` : '—'}
              </td>
            )}
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
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-bigrams-finger-no-snapshot">
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
      const avgIki = total ? avgIkiFromHistRenderer(total.hist) : null
      if (avgIki !== null && avgIki > maxAvg) maxAvg = avgIki
      cells.push({ key, count: total?.count ?? 0, avgIki })
    }
  }

  return (
    <div className="space-y-2" data-testid="analyze-bigrams-finger-heatmap">
      <div className="text-[12px] text-content-muted">{t('analyze.bigrams.fingerIki.hint')}</div>
      <div className="overflow-x-auto">
        <table className="text-[12px]">
          <thead>
            <tr>
              <th className="px-2 py-1" />
              {FINGER_LIST.map((f) => (
                <th key={f} className="px-2 py-1 text-center font-medium text-content-muted">
                  {t(`analyze.ergonomics.finger.${f}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FINGER_LIST.map((f1) => (
              <tr key={f1}>
                <th className="px-2 py-1 text-right font-medium text-content-muted">
                  {t(`analyze.ergonomics.finger.${f1}`)}
                </th>
                {FINGER_LIST.map((f2) => {
                  const cell = cells.find((c) => c.key === `${f1}_${f2}`)
                  const avgIki = cell?.avgIki ?? null
                  const isSfb = f1 === f2
                  return (
                    <td
                      key={f2}
                      className={`relative px-2 py-1 text-center tabular-nums ${isSfb ? 'ring-1 ring-accent' : ''}`}
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
      </div>
    </div>
  )
}

interface KeyHeatmapProps {
  entries: readonly TypingBigramTopEntry[]
}

function BigramKeyHeatmap({ entries }: KeyHeatmapProps): JSX.Element {
  const { t } = useTranslation()
  const { keys, cells } = useMemo(() => aggregateKeyHeatmap(entries, HEATMAP_TOP_KEYS), [entries])

  let maxAvg = 0
  const avgGrid: (number | null)[][] = cells.map((row) =>
    row.map((cell) => {
      if (!cell) return null
      const avg = avgIkiFromHistRenderer(cell.hist)
      if (avg !== null && avg > maxAvg) maxAvg = avg
      return avg
    }),
  )

  return (
    <div className="space-y-2" data-testid="analyze-bigrams-key-heatmap">
      <div className="text-[12px] text-content-muted">{t('analyze.bigrams.heatmap.hint')}</div>
      <div className="overflow-x-auto">
        <table className="text-[12px]">
          <thead>
            <tr>
              <th className="px-2 py-1" />
              {keys.map((k) => (
                <th key={k} className="px-2 py-1 text-center font-medium text-content-muted">
                  {codeToLabel(k)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((kFrom, i) => (
              <tr key={kFrom}>
                <th className="px-2 py-1 text-right font-medium text-content-muted">
                  {codeToLabel(kFrom)}
                </th>
                {keys.map((kTo, j) => {
                  const cell: BigramHeatmapCell | null = cells[i][j]
                  const avg = avgGrid[i][j]
                  return (
                    <td
                      key={kTo}
                      className="px-2 py-1 text-center tabular-nums"
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
      </div>
    </div>
  )
}

/** Map an IKI in [0, max] to a cool→warm CSS color string. Higher
 * values are warmer (slower bigrams stand out). */
function heatmapColor(iki: number, max: number): string {
  if (max <= 0) return 'transparent'
  const t = Math.min(1, Math.max(0, iki / max))
  // cool blue → red gradient (220° → 0° hue).
  const hue = 220 - 220 * t
  return `hsl(${hue}, 60%, 70%)`
}
