// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  primaryDeviceScope,
  scopeToSelectValue,
  type DeviceScope,
} from '../../../shared/types/analyze-filters'
import type {
  TypingBigramAggregateResult,
  TypingBigramAggregateView,
} from '../../../shared/types/typing-analytics'
import { fetchBigramAggregateForRange } from './analyze-fetch'
import { bigramPairLabel } from './analyze-bigram-format'
import type { RangeMs } from './analyze-types'

interface BigramsChartProps {
  uid: string
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
  view: TypingBigramAggregateView
  minSample: number
  onViewChange: (next: TypingBigramAggregateView) => void
  onMinSampleChange: (next: number) => void
}

const TOP_LIMIT = 30
const MIN_SAMPLE_BOUND = 1
// 1 minute of solid typing at 200 WPM is ~1000 events; clamp the input
// so an oversized number can't silently produce an empty Slow ranking.
const MAX_SAMPLE_BOUND = 1000

export function BigramsChart({
  uid,
  range,
  deviceScopes,
  view,
  minSample,
  onViewChange,
  onMinSampleChange,
}: BigramsChartProps): JSX.Element {
  const [result, setResult] = useState<TypingBigramAggregateResult>({ view: 'top', entries: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  // Pull a single primary scope from the (variadic) deviceScopes prop so
  // the IPC layer can resolve own / all / hash uniformly. The Analyze
  // surface currently passes one scope; the array shape is preserved
  // for future multi-scope chart variants.
  const scope = primaryDeviceScope(deviceScopes)
  // useEffect can't depend on `scope` directly: the hash variant is a
  // fresh object on every render, which would re-fire the IPC each
  // time. The string form (`own` / `all` / `hash:<machineHash>`) is
  // stable across renders.
  const scopeKey = scopeToSelectValue(scope)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    fetchBigramAggregateForRange(uid, scope, range.fromMs, range.toMs, view, {
      minSampleCount: view === 'slow' ? minSample : undefined,
      limit: TOP_LIMIT,
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
    // scopeKey is the stable identity proxy. range.fromMs / toMs cover
    // the scalar pieces of `range`.
  }, [uid, range.fromMs, range.toMs, view, scopeKey, minSample])

  return (
    <div className="space-y-3" data-testid="analyze-bigrams-content">
      <BigramsFilters
        view={view}
        onViewChange={onViewChange}
        minSample={minSample}
        onMinSampleChange={onMinSampleChange}
      />
      <BigramsBody loading={loading} error={error} result={result} />
    </div>
  )
}

interface FiltersProps {
  view: TypingBigramAggregateView
  onViewChange: (next: TypingBigramAggregateView) => void
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
          onChange={(e) => onViewChange(e.target.value === 'slow' ? 'slow' : 'top')}
          data-testid="analyze-bigrams-view-select"
          className="rounded border border-surface-dim bg-surface px-2 py-1"
        >
          <option value="top">{t('analyze.bigrams.view.top')}</option>
          <option value="slow">{t('analyze.bigrams.view.slow')}</option>
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
}

function BigramsBody({ loading, error, result }: BodyProps): JSX.Element {
  const { t } = useTranslation()
  if (loading) {
    return (
      <div
        className="py-4 text-center text-[13px] text-content-muted"
        data-testid="analyze-bigrams-loading"
      >
        {t('analyze.bigrams.loading')}
      </div>
    )
  }
  if (error) {
    return (
      <div
        className="py-4 text-center text-[13px] text-content-muted"
        data-testid="analyze-bigrams-error"
      >
        {t('analyze.bigrams.error')}
      </div>
    )
  }
  if (result.entries.length === 0) {
    return (
      <div
        className="py-4 text-center text-[13px] text-content-muted"
        data-testid="analyze-bigrams-empty"
      >
        {t('analyze.bigrams.empty')}
      </div>
    )
  }

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
