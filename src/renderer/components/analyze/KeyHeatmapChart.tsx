// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Heatmap — per-physical-key press-count heatmap. Uses the
// same `KeyboardWidget` the typing view renders, fed from the keymap
// snapshot's layer/keycode data, with the range-bound matrix heatmap
// overlaid so every key shows its actual label instead of a raw
// `row,col` index.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingHeatmapByCell, TypingHeatmapCell, TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'
import type { KeyboardLayout } from '../../../shared/kle/types'
import { resolveSnapshotLabel } from '../../../shared/keycodes/keycodes'
import { KeyboardWidget } from '../keyboard/KeyboardWidget'
import type { DeviceScope, HeatmapNormalization, RangeMs } from './analyze-types'

const TOP_N_OPTIONS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

interface Props {
  uid: string
  range: RangeMs
  deviceScope: DeviceScope
  /** Preloaded by the parent so the tab can show/hide without doing
   * a fetch per tab switch; `null` means no snapshot is available for
   * the range and the tab should never have been shown. */
  snapshot: TypingKeymapSnapshot
  normalization: HeatmapNormalization
}

export function KeyHeatmapChart({ uid, range, deviceScope, snapshot, normalization }: Props) {
  const { t } = useTranslation()
  const [cells, setCells] = useState<TypingHeatmapByCell>({})
  const [loading, setLoading] = useState(true)
  const [layer, setLayer] = useState(0)
  const [topN, setTopN] = useState<number>(10)
  const [hoveredLabel, setHoveredLabel] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const load = async () => {
      try {
        const data = await window.vialAPI.typingAnalyticsGetMatrixHeatmapForRange(
          uid, layer, range.fromMs, range.toMs, deviceScope === 'own',
        )
        if (!cancelled) setCells(data)
      } catch {
        if (!cancelled) setCells({})
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [uid, layer, range, deviceScope])

  const layout = snapshot.layout as KeyboardLayout | null

  // `keycodes` feeds KeyboardWidget the layer-specific QMK id for each
  // (row,col), which the ranking list below renders as the raw QMK id
  // for compactness. `labelOverrides` resolves the same ids through
  // `resolveSnapshotLabel` so the keyboard widget renders pretty
  // multi-line labels even when the connected keyboard's live layer
  // count doesn't currently register the snapshot's LT/LM composites.
  const { keycodes, labelOverrides } = useMemo(() => {
    const kc = new Map<string, string>()
    const overrides = new Map<string, { outer: string; inner: string; masked: boolean }>()
    const rows = Array.isArray(snapshot.keymap) ? snapshot.keymap[layer] : undefined
    if (!Array.isArray(rows)) return { keycodes: kc, labelOverrides: overrides }
    for (let r = 0; r < snapshot.matrix.rows; r += 1) {
      const rowArr = rows[r]
      if (!Array.isArray(rowArr)) continue
      for (let c = 0; c < snapshot.matrix.cols; c += 1) {
        const qmkId = rowArr[c] ?? ''
        const posKey = `${r},${c}`
        kc.set(posKey, qmkId)
        overrides.set(posKey, resolveSnapshotLabel(qmkId))
      }
    }
    return { keycodes: kc, labelOverrides: overrides }
  }, [snapshot, layer])

  // KeyboardWidget expects `Map<"row,col", {total,tap,hold}>`; the IPC
  // returns a plain object so we rehydrate here. Normalisation scales
  // the counts so the heatmap stays meaningful even when the selected
  // range is tiny (`perHour`) or when users want relative share of
  // keystrokes rather than absolute figures.
  const heatmapCells = useMemo(() => {
    const rawTotal = Object.values(cells).reduce((s, c) => s + c.total, 0)
    const rangeHours = Math.max(1 / 60, (range.toMs - range.fromMs) / 3_600_000)
    const scale = normalization === 'perHour'
      ? (v: number) => v / rangeHours
      : normalization === 'shareOfTotal'
        ? (v: number) => rawTotal > 0 ? (v / rawTotal) * 100 : 0
        : (v: number) => v
    const m = new Map<string, TypingHeatmapCell>()
    for (const [key, cell] of Object.entries(cells)) {
      m.set(key, { total: scale(cell.total), tap: scale(cell.tap), hold: scale(cell.hold) })
    }
    return m
  }, [cells, normalization, range])

  // Build the ranking as one entry per (logical label, physical cell).
  // A masked key contributes two rows — outer (total presses) and inner
  // (tap emissions) — so users can see LT1 hold activity separately from
  // the Bksp/Space it types. Cells that share a label (two LT1 keys, or
  // two `A` keys in a split layout) get a `row,col` suffix appended so
  // each physical key stays distinguishable in the list and hover
  // highlights the exact cell.
  const rankings = useMemo(() => {
    type Entry = { displayLabel: string; count: number; cell: string }
    const raw: Array<{ baseLabel: string; count: number; cell: string }> = []
    // Ranking wants the compact `LT1` form (no space) even though the
    // key widget renders `LT 1` for legibility on the keycap itself.
    const compactLayerOp = (label: string): string => {
      const m = label.match(/^(LT|LM|MO|DF|PDF|TG|TT|OSL|TO)\s(\d+)$/)
      return m ? `${m[1]}${m[2]}` : label
    }
    const push = (label: string, count: number, posKey: string) => {
      if (!label) return
      raw.push({ baseLabel: compactLayerOp(label), count, cell: posKey })
    }
    const source = layout && Array.isArray(layout.keys)
      ? layout.keys.filter((k) => !k.decal && !k.ghost).map((k) => `${k.row},${k.col}`)
      : Array.from(heatmapCells.keys())
    for (const posKey of source) {
      const qmkId = keycodes.get(posKey) ?? ''
      const resolved = resolveSnapshotLabel(qmkId)
      const cell = heatmapCells.get(posKey)
      if (resolved.masked) {
        push(resolved.outer, cell?.total ?? 0, posKey)
        push(resolved.inner, cell?.tap ?? 0, posKey)
      } else {
        push(resolved.outer || qmkId || posKey, cell?.total ?? 0, posKey)
      }
    }
    const freq = new Map<string, number>()
    for (const r of raw) freq.set(r.baseLabel, (freq.get(r.baseLabel) ?? 0) + 1)
    const all: Entry[] = raw.map((r) => {
      if ((freq.get(r.baseLabel) ?? 0) <= 1) {
        return { displayLabel: r.baseLabel, count: r.count, cell: r.cell }
      }
      const [row, col] = r.cell.split(',')
      return {
        displayLabel: `${r.baseLabel} Row:${row} Col:${col}`,
        count: r.count,
        cell: r.cell,
      }
    })
    const top = [...all].sort((a, b) => b.count - a.count).slice(0, topN)
    return { top }
  }, [heatmapCells, keycodes, layout, topN])

  const hoveredCells = useMemo(() => {
    if (!hoveredLabel) return undefined
    const match = rankings.top.find((e) => e.displayLabel === hoveredLabel)
    return match ? new Set([match.cell]) : undefined
  }, [hoveredLabel, rankings])

  const formatCount = (n: number): string => {
    if (normalization === 'shareOfTotal') return `${n.toFixed(2)}%`
    if (normalization === 'perHour') return `${n.toFixed(1)}/h`
    return Math.round(n).toLocaleString()
  }

  const { heatmapMaxTotal, heatmapMaxTap } = useMemo(() => {
    let total = 0
    let tap = 0
    for (const cell of heatmapCells.values()) {
      if (cell.total > total) total = cell.total
      if (cell.tap > tap) tap = cell.tap
    }
    return { heatmapMaxTotal: total, heatmapMaxTap: tap }
  }, [heatmapCells])

  if (!layout || !Array.isArray(layout.keys)) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-keyheatmap-nolayout">
        {t('analyze.keyHeatmap.noLayout')}
      </div>
    )
  }

  if (loading) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-keyheatmap-loading">
        {t('common.loading')}
      </div>
    )
  }

  const layerOptions = Array.from({ length: Math.max(1, snapshot.layers) }, (_, i) => i)

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="analyze-keyheatmap-chart">
      <div className="flex shrink-0 justify-center overflow-auto">
        <KeyboardWidget
          keys={layout.keys}
          keycodes={keycodes}
          labelOverrides={labelOverrides}
          heatmapCells={heatmapCells}
          heatmapMaxTotal={heatmapMaxTotal}
          heatmapMaxTap={heatmapMaxTap}
          // Zero-out the hold axis so the outer rect scales by total instead
          // of hold — the ranking below is keyed by the physical cell's
          // total press count, so the keymap colour has to read from the
          // same axis or the "why is this redder than that?" question has
          // no good answer.
          heatmapMaxHold={0}
          highlightedKeys={hoveredCells}
          readOnly
        />
      </div>
      <div
        className="flex shrink-0 flex-wrap items-center justify-end gap-1 text-[12px]"
        role="tablist"
        aria-label={t('analyze.keyHeatmap.layer')}
        data-testid="analyze-keyheatmap-layers"
      >
        {layerOptions.map((i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-label={t('analyze.keyHeatmap.layerOption', { i })}
            aria-selected={layer === i}
            onClick={() => setLayer(i)}
            className={`min-w-8 rounded border px-2 py-1 text-center text-[11px] transition-colors ${
              layer === i
                ? 'border-accent bg-accent/10 text-content'
                : 'border-edge text-content-muted hover:text-content'
            }`}
            data-testid={`analyze-keyheatmap-layer-${i}`}
          >
            {i}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col" data-testid="analyze-keyheatmap-rankings">
        <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="analyze-keyheatmap-top-heading">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3
              id="analyze-keyheatmap-top-heading"
              className="text-[11px] font-semibold uppercase tracking-widest text-content-muted"
            >
              {t('analyze.keyHeatmap.ranking.topHeading')}
            </h3>
            <select
              className="rounded-md border border-edge bg-surface px-2 py-1 text-[12px] text-content focus:border-accent focus:outline-none"
              value={topN}
              onChange={(e) => setTopN(Number.parseInt(e.target.value, 10))}
              aria-label={t('analyze.keyHeatmap.ranking.topN')}
              data-testid="analyze-keyheatmap-top-n"
            >
              {TOP_N_OPTIONS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          {rankings.top.length === 0 ? (
            <div className="text-[12px] text-content-muted">{t('analyze.keyHeatmap.ranking.emptyTop')}</div>
          ) : (
            <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto text-[12px]">
              {rankings.top.map((entry, i) => (
                <li
                  key={entry.displayLabel}
                  className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 ${hoveredLabel === entry.displayLabel ? 'bg-accent/10' : 'odd:bg-surface-dim/40'}`}
                  onMouseEnter={() => setHoveredLabel(entry.displayLabel)}
                  onMouseLeave={() => setHoveredLabel((k) => (k === entry.displayLabel ? null : k))}
                >
                  <span className="w-6 text-right text-content-muted">{i + 1}</span>
                  <span className="flex-1 min-w-0 truncate font-mono text-content">{entry.displayLabel}</span>
                  <span className="font-mono text-content-secondary">{formatCount(entry.count)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  )
}
