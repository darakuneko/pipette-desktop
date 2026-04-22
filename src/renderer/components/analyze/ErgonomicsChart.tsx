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
import type { DeviceScope, RangeMs } from './analyze-types'
import { aggregateErgonomics } from './analyze-ergonomics'

interface Props {
  uid: string
  range: RangeMs
  deviceScope: DeviceScope
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
  const { t } = useTranslation()
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
              content={({ active, label, payload }) => {
                if (!active || !payload?.length) return null
                const value = payload[0]?.value
                const formatted = typeof value === 'number' ? value.toLocaleString() : value
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
                    {label}: {formatted} {t('analyze.unit.keys')}
                  </div>
                )
              }}
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
  deviceScope,
  snapshot,
  fingerOverrides,
}: Props) {
  const { t } = useTranslation()
  const [layerCells, setLayerCells] = useState<Record<number, TypingHeatmapByCell>>({})
  const [loading, setLoading] = useState(true)

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
            deviceScope === 'own',
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
  }, [uid, range, deviceScope, snapshot])

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
    { label: t('analyze.ergonomics.hand.left'), value: aggregation.hand.left },
    { label: t('analyze.ergonomics.hand.right'), value: aggregation.hand.right },
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
        height={220}
        testId="analyze-ergonomics-finger"
      />
      <Section
        title={t('analyze.ergonomics.handBalance')}
        data={handData}
        orientation="horizontal"
        height={140}
        testId="analyze-ergonomics-hand"
      />
      <Section
        title={t('analyze.ergonomics.rowUsage')}
        data={rowData}
        orientation="horizontal"
        height={200}
        testId="analyze-ergonomics-row"
      />
    </div>
  )
}
