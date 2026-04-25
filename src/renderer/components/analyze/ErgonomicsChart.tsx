// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Ergonomics — aggregate keystroke counts by finger, hand,
// and row category. Finger labels are estimated from KLE geometry
// (see shared/kle/kle-ergonomics); users can override the defaults
// in the separate finger-assignment page.

import { memo, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type {
  TypingHeatmapByCell,
  TypingHeatmapCell,
  TypingKeymapSnapshot,
} from '../../../shared/types/typing-analytics'
import type { KeyboardLayout } from '../../../shared/kle/types'
import { FINGER_LIST } from '../../../shared/kle/kle-ergonomics'
import type { FingerType, RowCategory } from '../../../shared/kle/kle-ergonomics'
import { primaryDeviceScope, scopeToSelectValue } from '../../../shared/types/analyze-filters'
import type { DeviceScope, RangeMs } from './analyze-types'
import { aggregateErgonomics } from './analyze-ergonomics'
import { KeystrokeCountTooltip } from './analyze-tooltip'
import { useEffectiveTheme } from '../../hooks/useEffectiveTheme'
import { chartSeriesColor } from '../../utils/chart-palette'

interface Props {
  uid: string
  range: RangeMs
  /** Multi-select Device filter (capped at MAX_DEVICE_SCOPES = 2).
   * Today only `deviceScopes[0]` is consumed; a follow-up commit
   * paints the second-device bars adjacent to the primary so the
   * finger / hand / row sections compare two scopes at a glance. */
  deviceScopes: readonly DeviceScope[]
  snapshot: TypingKeymapSnapshot
  fingerOverrides?: Record<string, FingerType>
}

// Display rows top-to-bottom (function row first → thumb last)
const ROW_ORDER: RowCategory[] = [
  'function',
  'number',
  'top',
  'home',
  'bottom',
  'thumb',
]

type BarDatum = { label: string; value: number; valueB?: number | null }

interface SectionProps {
  title: string
  data: BarDatum[]
  orientation: 'horizontal' | 'vertical'
  height: number
  testId: string
  /** When set, the section paints a parallel `valueB` bar in this
   * colour next to the primary `value` bar. `null` skips the
   * secondary bar entirely so single-device picks stay visually
   * unchanged. */
  secondaryColor: string | null
  primaryColor: string
}

const Section = memo(function Section({
  title,
  data,
  orientation,
  height,
  testId,
  secondaryColor,
  primaryColor,
}: SectionProps) {
  return (
    <div data-testid={testId}>
      <h4 className="mb-1 text-[13px] font-semibold text-content-secondary">
        {title}
      </h4>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout={orientation}
            margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" />
            {orientation === 'vertical' ? (
              <>
                <XAxis
                  type="number"
                  stroke="var(--color-content-muted)"
                  fontSize={11}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  stroke="var(--color-content-muted)"
                  fontSize={11}
                  width={80}
                />
              </>
            ) : (
              <>
                <XAxis
                  type="category"
                  dataKey="label"
                  stroke="var(--color-content-muted)"
                  fontSize={11}
                />
                <YAxis type="number" stroke="var(--color-content-muted)" fontSize={11} />
              </>
            )}
            <Tooltip
              cursor={{ fill: 'var(--color-surface-dim)' }}
              content={(props) => <KeystrokeCountTooltip {...props} />}
            />
            <Bar dataKey="value" fill={primaryColor} />
            {secondaryColor !== null && (
              <Bar dataKey="valueB" fill={secondaryColor} />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
})

function mergeLayerHeatmaps(
  layerCells: Record<number, TypingHeatmapByCell>,
): Map<string, TypingHeatmapCell> {
  const merged = new Map<string, TypingHeatmapCell>()
  for (const cells of Object.values(layerCells)) {
    for (const [posKey, c] of Object.entries(cells)) {
      const entry = merged.get(posKey) ?? { total: 0, tap: 0, hold: 0 }
      entry.total += c.total
      entry.tap += c.tap
      entry.hold += c.hold
      merged.set(posKey, entry)
    }
  }
  return merged
}

export function ErgonomicsChart({
  uid,
  range,
  deviceScopes,
  snapshot,
  fingerOverrides,
}: Props) {
  const { t } = useTranslation()
  const effectiveTheme = useEffectiveTheme()
  const [layerCells, setLayerCells] = useState<Record<number, TypingHeatmapByCell>>({})
  const [secondaryLayerCells, setSecondaryLayerCells] = useState<Record<number, TypingHeatmapByCell>>({})
  const [loading, setLoading] = useState(true)

  const deviceScope = primaryDeviceScope(deviceScopes)
  const secondaryScope: DeviceScope | undefined = deviceScopes.length > 1 ? deviceScopes[1] : undefined
  const hasSecondary = secondaryScope !== undefined
  const scopeKey = scopeToSelectValue(deviceScope)
  const secondaryScopeKey = secondaryScope ? scopeToSelectValue(secondaryScope) : null
  // Two-device picks switch the primary off `--color-accent` and onto
  // the cool end of the shared ramp; single-device picks keep the
  // existing accent so the no-compare view stays unchanged.
  const primaryColor = hasSecondary ? chartSeriesColor(0, 2, effectiveTheme) : 'var(--color-accent)'
  const secondaryColor = chartSeriesColor(1, 2, effectiveTheme)

  useEffect(() => {
    let cancelled = false
    const layerCount = Array.isArray(snapshot.keymap) ? snapshot.keymap.length : 0
    if (layerCount === 0) {
      setLayerCells({})
      setLoading(false)
      return
    }
    setLoading(true)
    const layerIdxs = Array.from({ length: layerCount }, (_, i) => i)
    void Promise.all(
      layerIdxs.map((l) =>
        window.vialAPI
          .typingAnalyticsGetMatrixHeatmapForRange(
            uid,
            l,
            range.fromMs,
            range.toMs,
            deviceScope,
          )
          .catch(() => ({} as TypingHeatmapByCell)),
      ),
    ).then((results) => {
      if (cancelled) return
      const next: Record<number, TypingHeatmapByCell> = {}
      layerIdxs.forEach((l, i) => {
        next[l] = results[i]
      })
      setLayerCells(next)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [uid, range, scopeKey, snapshot])

  // Secondary fetch mirrors the primary's per-layer Promise.all but
  // skips the `setLoading` flag — the primary path already drives the
  // loading state for the chart shell. Clearing the buffer up front
  // keeps a stale dataset from outliving a scope change.
  useEffect(() => {
    setSecondaryLayerCells({})
    if (!hasSecondary || !secondaryScope) return
    const layerCount = Array.isArray(snapshot.keymap) ? snapshot.keymap.length : 0
    if (layerCount === 0) return
    let cancelled = false
    const layerIdxs = Array.from({ length: layerCount }, (_, i) => i)
    void Promise.all(
      layerIdxs.map((l) =>
        window.vialAPI
          .typingAnalyticsGetMatrixHeatmapForRange(
            uid,
            l,
            range.fromMs,
            range.toMs,
            secondaryScope,
          )
          .catch(() => ({} as TypingHeatmapByCell)),
      ),
    ).then((results) => {
      if (cancelled) return
      const next: Record<number, TypingHeatmapByCell> = {}
      layerIdxs.forEach((l, i) => {
        next[l] = results[i]
      })
      setSecondaryLayerCells(next)
    })
    return () => {
      cancelled = true
    }
  }, [uid, range, secondaryScopeKey, snapshot, hasSecondary, secondaryScope])

  const mergedHeatmap = useMemo(
    () => mergeLayerHeatmaps(layerCells),
    [layerCells],
  )
  const mergedSecondaryHeatmap = useMemo(
    () => (hasSecondary ? mergeLayerHeatmaps(secondaryLayerCells) : new Map<string, TypingHeatmapCell>()),
    [secondaryLayerCells, hasSecondary],
  )

  const layout = snapshot.layout as KeyboardLayout | null
  const keys = layout?.keys ?? []

  const aggregation = useMemo(
    () => aggregateErgonomics(mergedHeatmap, keys, fingerOverrides),
    [mergedHeatmap, keys, fingerOverrides],
  )
  // Secondary aggregation reuses the *primary's* finger overrides so
  // the same finger labels apply on both bars — assigning a finger
  // re-classifies device A and device B the same way.
  const secondaryAggregation = useMemo(
    () => (hasSecondary
      ? aggregateErgonomics(mergedSecondaryHeatmap, keys, fingerOverrides)
      : null),
    [mergedSecondaryHeatmap, keys, fingerOverrides, hasSecondary],
  )

  const fingerData: BarDatum[] = FINGER_LIST.map((f) => ({
    label: t(`analyze.ergonomics.finger.${f}`),
    value: aggregation.finger[f],
    valueB: secondaryAggregation?.finger[f] ?? null,
  }))
  const handData: BarDatum[] = [
    {
      label: t('analyze.ergonomics.hand.left'),
      value: aggregation.hand.left,
      valueB: secondaryAggregation?.hand.left ?? null,
    },
    {
      label: t('analyze.ergonomics.hand.right'),
      value: aggregation.hand.right,
      valueB: secondaryAggregation?.hand.right ?? null,
    },
  ]
  const rowData: BarDatum[] = ROW_ORDER.map((r) => ({
    label: t(`analyze.ergonomics.rowCategory.${r}`),
    value: aggregation.row[r],
    valueB: secondaryAggregation?.row[r] ?? null,
  }))

  if (loading) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-ergonomics-loading">
        {t('common.loading')}
      </div>
    )
  }
  if (!layout || keys.length === 0) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-ergonomics-no-layout">
        {t('analyze.ergonomics.noLayout')}
      </div>
    )
  }
  if (aggregation.total === 0) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-ergonomics-empty">
        {t('analyze.ergonomics.noData')}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1" data-testid="analyze-ergonomics">
      {hasSecondary && (
        <div
          className="flex items-center gap-4 text-[11px] text-content-muted"
          data-testid="analyze-ergonomics-legend"
        >
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5 rounded"
              style={{ backgroundColor: primaryColor }}
            />
            {t('analyze.ergonomics.legend')}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5 rounded"
              style={{ backgroundColor: secondaryColor }}
            />
            {t('analyze.ergonomics.secondaryLegend')}
          </span>
        </div>
      )}
      <Section
        title={t('analyze.ergonomics.fingerLoad')}
        data={fingerData}
        orientation="vertical"
        height={220}
        testId="analyze-ergonomics-finger"
        primaryColor={primaryColor}
        secondaryColor={hasSecondary ? secondaryColor : null}
      />
      <Section
        title={t('analyze.ergonomics.handBalance')}
        data={handData}
        orientation="horizontal"
        height={140}
        testId="analyze-ergonomics-hand"
        primaryColor={primaryColor}
        secondaryColor={hasSecondary ? secondaryColor : null}
      />
      <Section
        title={t('analyze.ergonomics.rowUsage')}
        data={rowData}
        orientation="horizontal"
        height={200}
        testId="analyze-ergonomics-row"
        primaryColor={primaryColor}
        secondaryColor={hasSecondary ? secondaryColor : null}
      />
    </div>
  )
}
