// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Layer — per-layer keystroke totals. Reads the
// `typing_matrix_minute.layer` column (which records the live-active
// layer at press time) grouped by layer, so the value already reflects
// MO / LT / TG / etc. activations without keycode re-decoding.
//
// Snapshot is optional: when provided it fixes the displayed layer
// count (and the renderer zero-fills gaps); otherwise the bar chart
// shows just the layers that actually received presses.

import { useEffect, useMemo, useState } from 'react'
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
  TypingKeymapSnapshot,
  TypingLayerUsageRow,
} from '../../../shared/types/typing-analytics'
import type { DeviceScope, RangeMs } from './analyze-types'
import { buildLayerBars } from './analyze-layer-usage'
import { KeystrokeCountTooltip } from './analyze-tooltip'

interface Props {
  uid: string
  range: RangeMs
  deviceScope: DeviceScope
  /** Optional snapshot. When present its `layers` count fixes the
   * x-axis (including zero-usage layers); otherwise the chart falls
   * back to the highest layer index that actually received presses. */
  snapshot: TypingKeymapSnapshot | null
}

export function LayerUsageChart({ uid, range, deviceScope, snapshot }: Props) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<TypingLayerUsageRow[]>([])
  const [layerNames, setLayerNames] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const fetchRows =
      deviceScope === 'own'
        ? window.vialAPI.typingAnalyticsListLayerUsageLocal(uid, range.fromMs, range.toMs)
        : window.vialAPI.typingAnalyticsListLayerUsage(uid, range.fromMs, range.toMs)
    void fetchRows
      .then((result) => {
        if (cancelled) return
        setRows(Array.isArray(result) ? result : [])
      })
      .catch(() => {
        if (!cancelled) setRows([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [uid, range, deviceScope])

  // Settings tracks `uid` only — layer names don't change per range /
  // deviceScope, so merging this with the rows fetch would re-hit the
  // settings store on every filter tweak.
  useEffect(() => {
    let cancelled = false
    void window.vialAPI
      .pipetteSettingsGet(uid)
      .then((prefs) => {
        if (cancelled) return
        setLayerNames(Array.isArray(prefs?.layerNames) ? prefs.layerNames : [])
      })
      .catch(() => {
        if (!cancelled) setLayerNames([])
      })
    return () => {
      cancelled = true
    }
  }, [uid])

  const bars = useMemo(
    () =>
      buildLayerBars(
        rows,
        snapshot?.layers ?? 0,
        layerNames,
        (layer) => t('analyze.layer.layerLabel', { layer }),
      ),
    [rows, snapshot, layerNames, t],
  )

  if (loading) {
    return (
      <div
        className="py-4 text-center text-[13px] text-content-muted"
        data-testid="analyze-layer-loading"
      >
        {t('common.loading')}
      </div>
    )
  }
  const totalKeystrokes = bars.reduce((acc, b) => acc + b.keystrokes, 0)
  if (bars.length === 0 || totalKeystrokes === 0) {
    return (
      <div
        className="py-4 text-center text-[13px] text-content-muted"
        data-testid="analyze-layer-empty"
      >
        {t('analyze.layer.noData')}
      </div>
    )
  }

  return (
    <div
      className="flex h-full flex-col gap-2 overflow-y-auto pr-1"
      data-testid="analyze-layer"
    >
      <h4 className="mb-1 text-[13px] font-semibold text-content-secondary">
        {t('analyze.layer.title')}
      </h4>
      <div className="flex-1 min-h-[220px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={bars}
            layout="vertical"
            margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" />
            <XAxis type="number" stroke="var(--color-content-muted)" fontSize={11} />
            <YAxis
              type="category"
              dataKey="label"
              stroke="var(--color-content-muted)"
              fontSize={11}
              width={120}
            />
            <Tooltip
              cursor={{ fill: 'var(--color-surface-dim)' }}
              content={(props) => <KeystrokeCountTooltip {...props} />}
            />
            <Bar dataKey="keystrokes" fill="var(--color-accent)" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
