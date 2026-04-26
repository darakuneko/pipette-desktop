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
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import { primaryDeviceScope, scopeToSelectValue } from '../../../shared/types/analyze-filters'
import type { DeviceScope, RangeMs } from './analyze-types'
import { aggregateErgonomics, FINGER_LIST, ROW_ORDER } from './analyze-ergonomics'
import { fetchMatrixHeatmapAllLayers } from './analyze-fetch'
import { KeystrokeCountTooltip } from './analyze-tooltip'

interface Props {
  uid: string
  range: RangeMs
  /** Device filter (capped at MAX_DEVICE_SCOPES = 1). The single scope
   * drives the finger / hand / row aggregations. */
  deviceScopes: readonly DeviceScope[]
  snapshot: TypingKeymapSnapshot
  fingerOverrides?: Record<string, FingerType>
}

type BarDatum = { label: string; value: number }

interface SectionProps {
  title: string
  data: BarDatum[]
  orientation: 'horizontal' | 'vertical'
  height: number
  testId: string
}

const Section = memo(function Section({
  title,
  data,
  orientation,
  height,
  testId,
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
            <Bar dataKey="value" fill="var(--color-accent)" />
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
  const [layerCells, setLayerCells] = useState<Record<number, TypingHeatmapByCell>>({})
  const [loading, setLoading] = useState(true)

  const deviceScope = primaryDeviceScope(deviceScopes)
  const scopeKey = scopeToSelectValue(deviceScope)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void fetchMatrixHeatmapAllLayers(uid, snapshot, range.fromMs, range.toMs, deviceScope)
      .then((next) => {
        if (cancelled) return
        setLayerCells(next)
        setLoading(false)
      })
    return () => { cancelled = true }
    // `scopeKey` carries `deviceScope` identity.
  }, [uid, range, scopeKey, snapshot])

  const mergedHeatmap = useMemo(
    () => mergeLayerHeatmaps(layerCells),
    [layerCells],
  )

  const layout = snapshot.layout as KeyboardLayout | null
  const keys = layout?.keys ?? []

  const aggregation = useMemo(
    () => aggregateErgonomics(mergedHeatmap, keys, fingerOverrides),
    [mergedHeatmap, keys, fingerOverrides],
  )

  const fingerData: BarDatum[] = FINGER_LIST.map((f) => ({
    label: t(`analyze.ergonomics.finger.${f}`),
    value: aggregation.finger[f],
  }))
  const handData: BarDatum[] = [
    {
      label: t('analyze.ergonomics.hand.left'),
      value: aggregation.hand.left,
    },
    {
      label: t('analyze.ergonomics.hand.right'),
      value: aggregation.hand.right,
    },
  ]
  const rowData: BarDatum[] = ROW_ORDER.map((r) => ({
    label: t(`analyze.ergonomics.rowCategory.${r}`),
    value: aggregation.row[r],
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
      <Section
        title={t('analyze.ergonomics.fingerLoad')}
        data={fingerData}
        orientation="vertical"
        height={360}
        testId="analyze-ergonomics-finger"
      />
      {/* Hand Balance has just two bars, so it's pinned to a narrower
        * column while Row Usage (6 categories) takes the rest of the
        * width. `min-w-0` keeps the recharts measurement from forcing
        * either child past its grid track. */}
      <div className="grid grid-cols-[1fr_3fr] gap-4">
        <div className="min-w-0">
          <Section
            title={t('analyze.ergonomics.handBalance')}
            data={handData}
            orientation="horizontal"
            height={200}
            testId="analyze-ergonomics-hand"
          />
        </div>
        <div className="min-w-0">
          <Section
            title={t('analyze.ergonomics.rowUsage')}
            data={rowData}
            orientation="horizontal"
            height={200}
            testId="analyze-ergonomics-row"
          />
        </div>
      </div>
    </div>
  )
}
