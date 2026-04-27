// SPDX-License-Identifier: GPL-2.0-or-later
//
// Layout Optimizer Phase 1 orchestrator. Owns source / target
// selection state, fires the IPC fetch, and renders the side-by-side
// metric table once a result lands.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  primaryDeviceScope,
  scopeToSelectValue,
  type DeviceScope,
} from '../../../shared/types/analyze-filters'
import type { KeyboardLayout, KleKey } from '../../../shared/kle/types'
import type {
  LayoutOptimizerMetric,
  LayoutOptimizerResult,
  TypingKeymapSnapshot,
} from '../../../shared/types/typing-analytics'
import { KEYBOARD_LAYOUTS, LAYOUT_BY_ID, pickLayoutOptimizerInput } from '../../data/keyboard-layouts'
import { fetchLayoutOptimizerForRange } from './analyze-fetch'
import { FILTER_BUTTON } from './analyze-filter-styles'
import { formatSharePercent } from './analyze-format'
import { LayoutOptimizerFingerDiff } from './LayoutOptimizerFingerDiff'
import { LayoutOptimizerHeatmapDiff } from './LayoutOptimizerHeatmapDiff'
import { LayoutOptimizerMetricTable } from './LayoutOptimizerMetricTable'
import { LayoutOptimizerSelector } from './LayoutOptimizerSelector'
import type { RangeMs } from './analyze-types'

type SubView = 'metric' | 'fingerDiff' | 'heatmapDiff'

const SUB_VIEWS: SubView[] = ['metric', 'fingerDiff', 'heatmapDiff']

const EMPTY_KLE_KEYS: readonly KleKey[] = []

interface Props {
  uid: string
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
  snapshot: TypingKeymapSnapshot | null
}

// First entry in `keyboard-layouts.ts` is QWERTY by convention. Read
// it dynamically so a future rename of that data file doesn't drop
// the dropdown onto a now-invalid id.
const DEFAULT_SOURCE_LAYOUT_ID = KEYBOARD_LAYOUTS[0]?.id ?? 'qwerty'
const SKIP_RATE_WARNING_THRESHOLD = 0.05
const PHASE_1_METRICS: LayoutOptimizerMetric[] = [
  'fingerLoad',
  'handBalance',
  'rowDist',
  'homeRow',
]

export function LayoutOptimizerView({ uid, range, deviceScopes, snapshot }: Props): JSX.Element {
  const { t } = useTranslation()
  const [sourceLayoutId, setSourceLayoutId] = useState<string>(DEFAULT_SOURCE_LAYOUT_ID)
  const [targetLayoutId, setTargetLayoutId] = useState<string | null>(null)
  const [subView, setSubView] = useState<SubView>('metric')
  const [result, setResult] = useState<LayoutOptimizerResult | null>(null)
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
    const source = pickLayoutOptimizerInput(sourceLayoutId)
    const target = targetLayoutId !== null ? pickLayoutOptimizerInput(targetLayoutId) : null
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
    fetchLayoutOptimizerForRange(uid, scope, range.fromMs, range.toMs, {
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
        console.error('LayoutOptimizerView: fetchLayoutOptimizerForRange failed', err)
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
        return t('analyze.layoutOptimizer.headers.current')
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

  // The Heatmap Diff sub-view paints onto a KeyboardWidget, so it
  // needs the snapshot's KLE geometry. snapshot.layout is `unknown`
  // by type — every Analyze chart casts it the same way.
  const kleKeys = useMemo<readonly KleKey[]>(() => {
    const layout = snapshot?.layout as KeyboardLayout | null
    if (!layout || !Array.isArray(layout.keys)) return EMPTY_KLE_KEYS
    return layout.keys
  }, [snapshot])

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto" data-testid="analyze-layout-optimizer-view">
      <LayoutOptimizerSelector
        sourceLayoutId={sourceLayoutId}
        targetLayoutId={targetLayoutId}
        onSourceChange={setSourceLayoutId}
        onTargetChange={setTargetLayoutId}
      />
      {snapshot === null ? (
        <Empty message={t('analyze.layoutOptimizer.noSnapshot')} testid="analyze-layout-optimizer-no-snapshot" />
      ) : targetLayoutId === null ? (
        <Empty message={t('analyze.layoutOptimizer.noTarget')} testid="analyze-layout-optimizer-no-target" />
      ) : loading ? (
        <Empty message={t('analyze.layoutOptimizer.loading')} testid="analyze-layout-optimizer-loading" />
      ) : error ? (
        <Empty message={t('analyze.layoutOptimizer.fetchError')} testid="analyze-layout-optimizer-error" />
      ) : !result ? (
        <Empty message={t('analyze.layoutOptimizer.noData')} testid="analyze-layout-optimizer-no-data" />
      ) : (
        <>
          {skipPercent !== null && skipPercent > SKIP_RATE_WARNING_THRESHOLD && (
            <div
              className="rounded border border-amber-400/60 bg-amber-50/40 px-3 py-2 text-[12px] text-amber-900 dark:bg-amber-900/20 dark:text-amber-200"
              role="status"
              data-testid="analyze-layout-optimizer-skip-warning"
            >
              {t('analyze.layoutOptimizer.skipWarning', {
                percent: formatSharePercent(skipPercent),
              })}
            </div>
          )}
          <div
            role="tablist"
            aria-label={t('analyze.layoutOptimizer.subView.label')}
            className="flex flex-wrap items-center gap-1"
            data-testid="analyze-layout-optimizer-sub-view"
          >
            {SUB_VIEWS.map((key) => {
              const active = subView === key
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`${FILTER_BUTTON} ${active ? 'bg-accent/10 text-accent' : ''}`}
                  onClick={() => setSubView(key)}
                  data-testid={`analyze-layout-optimizer-sub-view-${key}`}
                >
                  {t(`analyze.layoutOptimizer.subView.${key}`)}
                </button>
              )
            })}
          </div>
          {subView === 'metric' ? (
            <LayoutOptimizerMetricTable
              columnLabels={columnLabels}
              targets={result.targets}
            />
          ) : subView === 'fingerDiff' ? (
            // Fetch site enforces `targets = [source, target]`, so
            // [1] is always present once the result lands.
            <LayoutOptimizerFingerDiff
              current={result.targets[0]}
              target={result.targets[1]}
              targetLabel={columnLabels[1] ?? result.targets[1].layoutId}
            />
          ) : (
            <LayoutOptimizerHeatmapDiff
              current={result.targets[0]}
              target={result.targets[1]}
              kleKeys={kleKeys}
              targetLabel={columnLabels[1] ?? result.targets[1].layoutId}
            />
          )}
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
