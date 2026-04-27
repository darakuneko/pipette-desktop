// SPDX-License-Identifier: GPL-2.0-or-later
//
// Layout Comparison Phase 1 orchestrator. Owns source / target
// selection state, fires the IPC fetch, and renders all three Phase 1
// panels at once (Heatmap Diff on top, then Finger Diff + Metric
// Table side-by-side) so the user can scan position / finger / number
// shifts together without flipping a sub-view.

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
  LayoutComparisonMetric,
  LayoutComparisonResult,
  TypingKeymapSnapshot,
} from '../../../shared/types/typing-analytics'
import { LAYOUT_BY_ID, pickLayoutComparisonInput } from '../../data/keyboard-layouts'
import { fetchLayoutComparisonForRange } from './analyze-fetch'
import { formatSharePercent } from './analyze-format'
import { LayoutComparisonFingerDiff } from './LayoutComparisonFingerDiff'
import { LayoutComparisonHeatmapDiff } from './LayoutComparisonHeatmapDiff'
import { LayoutComparisonMetricTable } from './LayoutComparisonMetricTable'
import type { RangeMs } from './analyze-types'

const EMPTY_KLE_KEYS: readonly KleKey[] = []

interface Props {
  uid: string
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
  snapshot: TypingKeymapSnapshot | null
  /** Persisted source / target read from `useAnalyzeFilters`. The
   * AnalyzePane filter row owns the picker UI; this view stays
   * read-only on the filter so the IPC fetch stays the side-effect
   * source of truth. */
  filter: Required<LayoutComparisonFilters>
}

const SKIP_RATE_WARNING_THRESHOLD = 0.05
const PHASE_1_METRICS: LayoutComparisonMetric[] = [
  'fingerLoad',
  'handBalance',
  'rowDist',
  'homeRow',
]

export function LayoutComparisonView({
  uid,
  range,
  deviceScopes,
  snapshot,
  filter,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const sourceLayoutId = filter.sourceLayoutId
  const targetLayoutId = filter.targetLayoutId
  const [result, setResult] = useState<LayoutComparisonResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  const scope = primaryDeviceScope(deviceScopes)
  const scopeKey = scopeToSelectValue(scope)

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
    const source = pickLayoutComparisonInput(sourceLayoutId)
    const target = targetLayoutId !== null ? pickLayoutComparisonInput(targetLayoutId) : null
    if (!source || !target) {
      setResult(null)
      return
    }
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
      metrics: PHASE_1_METRICS,
    })
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
  }, [uid, range.fromMs, range.toMs, scopeKey, sourceLayoutId, targetLayoutId, shouldFetch])

  const columnLabels = useMemo(() => {
    if (!result) return []
    return result.targets.map((target, idx) => {
      if (idx === 0) {
        return t('analyze.layoutComparison.headers.current')
      }
      return LAYOUT_BY_ID.get(target.layoutId)?.name ?? target.layoutId
    })
  }, [result, t])

  const skipPercent = useMemo(() => {
    if (!result) return null
    let max = 0
    for (const target of result.targets) {
      if (target.skipRate > max) max = target.skipRate
    }
    return max
  }, [result])

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
          {skipPercent !== null && skipPercent > SKIP_RATE_WARNING_THRESHOLD && (
            <div
              className="rounded border border-amber-400/60 bg-amber-50/40 px-3 py-2 text-[12px] text-amber-900 dark:bg-amber-900/20 dark:text-amber-200"
              role="status"
              data-testid="analyze-layout-comparison-skip-warning"
            >
              {t('analyze.layoutComparison.skipWarning', {
                percent: formatSharePercent(skipPercent),
              })}
            </div>
          )}
          {(() => {
            // Fetch site enforces `targets = [source, target]`, so
            // [1] is always present once the result lands.
            const candidate = result.targets[1]
            const targetLabel = columnLabels[1] ?? candidate.layoutId
            return (
              <>
                {/* Each panel scrolls independently — heatmap on top
                  * gets its own overflow box (KeyboardWidget can run
                  * tall on full keyboards) and the bottom grid lets
                  * finger / metric scroll inside their own halves. */}
                <div className="min-h-0 overflow-auto">
                  <LayoutComparisonHeatmapDiff
                    current={result.targets[0]}
                    target={candidate}
                    kleKeys={kleKeys}
                    targetLabel={targetLabel}
                  />
                </div>
                <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[3fr_2fr]">
                  {/* Finger diff: hide overflow on both axes — the
                    * chart now flexes to fill this panel, so neither
                    * direction should ever need a scrollbar. */}
                  <div className="min-w-0 min-h-0 overflow-hidden">
                    <LayoutComparisonFingerDiff
                      current={result.targets[0]}
                      target={candidate}
                      targetLabel={targetLabel}
                    />
                  </div>
                  <div className="min-w-0 min-h-0 overflow-auto">
                    <LayoutComparisonMetricTable
                      columnLabels={columnLabels}
                      targets={result.targets}
                    />
                  </div>
                </div>
              </>
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
