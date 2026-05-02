// SPDX-License-Identifier: GPL-2.0-or-later
//
// Layout Comparison Phase 1 orchestrator. Owns source / target
// selection state, fires the IPC fetch, and renders all three Phase 1
// panels in a 2-column / 2-row grid: Heatmap Diff and Finger Diff
// stacked on the left, Metric Table spanning both rows on the right —
// so the user can scan position / finger shifts against the same
// numeric baseline without flipping a sub-view.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  primaryDeviceScope,
  scopeToSelectValue,
  type DeviceScope,
  type LayoutComparisonFilters,
} from '../../../shared/types/analyze-filters'
import type { KeyboardLayout, KleKey } from '../../../shared/kle/types'
import type {
  LayoutComparisonResult,
  TypingKeymapSnapshot,
} from '../../../shared/types/typing-analytics'
import { useKeyLabelLookup } from '../../hooks/useKeyLabelLookup'
import { fetchLayoutComparisonForRange } from './analyze-fetch'
import { LAYOUT_COMPARISON_PHASE_1_METRICS } from './layout-comparison-metrics'
import { LayoutComparisonFingerDiff } from './LayoutComparisonFingerDiff'
import { LayoutComparisonHeatmapDiff } from './LayoutComparisonHeatmapDiff'
import { LayoutComparisonMetricTable } from './LayoutComparisonMetricTable'
import type { RangeMs } from './analyze-types'

const EMPTY_KLE_KEYS: readonly KleKey[] = []

interface Props {
  uid: string
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
  /** App filter — see WpmChart.Props.appScopes. */
  appScopes: string[]
  snapshot: TypingKeymapSnapshot | null
  /** Persisted source / target read from `useAnalyzeFilters`. The
   * AnalyzePane filter row owns the picker UI; this view stays
   * read-only on the filter so the IPC fetch stays the side-effect
   * source of truth. */
  filter: Required<LayoutComparisonFilters>
  /** Notifies the page chrome (TypingAnalyticsView footer) of the
   * current max skip rate so the warning can render alongside the
   * split-view toggle instead of as a banner inside the panel. The
   * effect emits `null` whenever no result is loaded so the chrome
   * can clear stale values when the user switches tab / range. */
  onSkipPercentChange?: (percent: number | null) => void
}

export function LayoutComparisonView({
  uid,
  range,
  deviceScopes,
  appScopes,
  snapshot,
  filter,
  onSkipPercentChange,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const sourceLayoutId = filter.sourceLayoutId
  const targetLayoutId = filter.targetLayoutId
  const [result, setResult] = useState<LayoutComparisonResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const lookup = useKeyLabelLookup()
  // Maps are read straight from the lookup so a download elsewhere in
  // the app re-renders this view without a manual refresh.
  const sourceMap = lookup.getMap(sourceLayoutId)
  const targetMap = targetLayoutId !== null ? lookup.getMap(targetLayoutId) : undefined

  useEffect(() => {
    void lookup.ensure(sourceLayoutId)
    if (targetLayoutId !== null) void lookup.ensure(targetLayoutId)
  }, [lookup, sourceLayoutId, targetLayoutId])

  const scope = primaryDeviceScope(deviceScopes)
  const scopeKey = scopeToSelectValue(scope)
  // Stable string identity for the app filter so the effect doesn't
  // refire when the parent passes a fresh-but-equal array.
  const appScopesKey = appScopes.join('|')

  // Run the fetch only when the user has both ends of the comparison
  // chosen and there's a snapshot to anchor against. The IPC handler
  // also returns null when no snapshot exists, but bailing here saves
  // a round-trip on an obvious empty state.
  const shouldFetch = snapshot !== null && targetLayoutId !== null

  useEffect(() => {
    if (!shouldFetch) {
      setResult(null)
      setError(false)
      return
    }
    if (!sourceMap || !targetMap || targetLayoutId === null) {
      setResult(null)
      return
    }
    const source = { id: sourceLayoutId, map: sourceMap }
    const target = { id: targetLayoutId, map: targetMap }
    let cancelled = false
    setLoading(true)
    setError(false)
    // First entry of `targets` is the source itself so the table can
    // render a "Current" baseline column without re-doing the math
    // renderer-side. The compute step short-circuits identical
    // source/target into the no-op resolver branch.
    fetchLayoutComparisonForRange(uid, scope, range.fromMs, range.toMs, {
      source,
      targets: [source, target],
      metrics: [...LAYOUT_COMPARISON_PHASE_1_METRICS],
    }, appScopes)
      .then((next) => {
        if (cancelled) return
        setResult(next)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        console.error('LayoutComparisonView: fetchLayoutComparisonForRange failed', err)
        setError(true)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // appScopesKey carries appScopes' identity for memo equality.
    // sourceMap/targetMap re-run the fetch once the lookup finishes
    // loading a downloaded entry's payload via IPC.
  }, [uid, range.fromMs, range.toMs, scopeKey, sourceLayoutId, targetLayoutId, shouldFetch, appScopesKey, sourceMap, targetMap])

  const columnLabels = useMemo(() => {
    if (!result) return []
    return result.targets.map((target, idx) => {
      if (idx === 0) {
        return t('analyze.layoutComparison.headers.current')
      }
      return lookup.getName(target.layoutId) ?? target.layoutId
    })
  }, [result, t, lookup])

  const skipPercent = useMemo(() => {
    if (!result) return null
    let max = 0
    for (const target of result.targets) {
      if (target.skipRate > max) max = target.skipRate
    }
    return max
  }, [result])

  // Push skip rate changes up to the page chrome and clear the value
  // on unmount so the footer doesn't keep showing a stale percentage
  // after the user navigates to another tab.
  useEffect(() => {
    onSkipPercentChange?.(skipPercent)
  }, [skipPercent, onSkipPercentChange])
  useEffect(() => () => onSkipPercentChange?.(null), [onSkipPercentChange])

  // The Heatmap Diff panel paints onto a KeyboardWidget, so it needs
  // the snapshot's KLE geometry. snapshot.layout is `unknown` by type
  // — every Analyze chart casts it the same way.
  const kleKeys = useMemo<readonly KleKey[]>(() => {
    const layout = snapshot?.layout as KeyboardLayout | null
    if (!layout || !Array.isArray(layout.keys)) return EMPTY_KLE_KEYS
    return layout.keys
  }, [snapshot])

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-x-hidden" data-testid="analyze-layout-comparison-view">
      {snapshot === null ? (
        <Empty message={t('analyze.layoutComparison.noSnapshot')} testid="analyze-layout-comparison-no-snapshot" />
      ) : targetLayoutId === null ? (
        <Empty message={t('analyze.layoutComparison.noTarget')} testid="analyze-layout-comparison-no-target" />
      ) : loading ? (
        <Empty message={t('analyze.layoutComparison.loading')} testid="analyze-layout-comparison-loading" />
      ) : error ? (
        <Empty message={t('analyze.layoutComparison.fetchError')} testid="analyze-layout-comparison-error" />
      ) : !result ? (
        <Empty message={t('analyze.layoutComparison.noData')} testid="analyze-layout-comparison-no-data" />
      ) : (
        <>
          {(() => {
            // Fetch site enforces `targets = [source, target]`, so
            // [1] is always present once the result lands.
            const candidate = result.targets[1]
            const targetLabel = columnLabels[1] ?? candidate.layoutId
            return (
              // Three panels share a 2-column / 2-row grid: heatmap +
              // finger diff stack on the left so they can scan
              // position vs. finger shifts together, and the metric
              // table spans both rows on the right so the numeric
              // baseline stays visible alongside either chart.
              <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[3fr_2fr] lg:grid-rows-2">
                <div className="min-w-0 min-h-0 overflow-auto lg:col-start-1 lg:row-start-1">
                  <LayoutComparisonHeatmapDiff
                    current={result.targets[0]}
                    target={candidate}
                    kleKeys={kleKeys}
                    targetLabel={targetLabel}
                  />
                </div>
                {/* Finger diff: hide overflow on both axes — the
                  * chart now flexes to fill this panel, so neither
                  * direction should ever need a scrollbar. */}
                <div className="min-w-0 min-h-0 overflow-hidden lg:col-start-1 lg:row-start-2">
                  <LayoutComparisonFingerDiff
                    current={result.targets[0]}
                    target={candidate}
                    targetLabel={targetLabel}
                  />
                </div>
                <div className="min-w-0 min-h-0 overflow-auto lg:col-start-2 lg:row-span-2">
                  <LayoutComparisonMetricTable
                    columnLabels={columnLabels}
                    targets={result.targets}
                  />
                </div>
              </div>
            )
          })()}
        </>
      )}
    </div>
  )
}

function Empty({ message, testid }: { message: string; testid: string }): JSX.Element {
  return (
    <div
      className="py-4 text-center text-[13px] text-content-muted"
      data-testid={testid}
    >
      {message}
    </div>
  )
}
