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
import { resolveSnapshotLabel, keycodeGroup } from '../../../shared/keycodes/keycodes'
import type { KeycodeGroup } from '../../../shared/keycodes/keycodes'
import { KeyboardWidget } from '../keyboard/KeyboardWidget'
import type { DeviceScope, HeatmapNormalization, RangeMs } from './analyze-types'

const FREQUENT_USED_N_OPTIONS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
const AGGREGATE_MODES = ['cell', 'char'] as const
type AggregateMode = typeof AGGREGATE_MODES[number]
const KEY_GROUPS = ['all', 'char', 'modifier', 'layerOp'] as const
type KeyGroupFilter = typeof KEY_GROUPS[number]
const MASK_INNER_RE = /\((.+)\)$/

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
  const [frequentUsedN, setFrequentUsedN] = useState<number>(10)
  const [aggregateMode, setAggregateMode] = useState<AggregateMode>('cell')
  const [keyGroupFilter, setKeyGroupFilter] = useState<KeyGroupFilter>('all')
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

  // Build the ranking by walking every layout cell, emitting one raw
  // entry per logical action the cell can take. Layer/mod-tap masks
  // produce two entries — the outer (total presses) and the inner (tap
  // emissions) — so LT1(Bksp) shows both its `LT1` hold activity and
  // the `Bksp` characters it types. Downstream we either present each
  // physical cell separately (`cell` mode, with `Row:N Col:N` suffix
  // when a label repeats) or sum by base label across cells (`char`
  // mode). `keyGroupFilter` trims the list to modifier / character /
  // layer-op entries, and masked-outer entries also carry their tap and
  // total so the row can print a `tap% / hold%` split.
  const rankings = useMemo(() => {
    type RawEntry = {
      baseLabel: string
      cell: string
      count: number
      group: KeycodeGroup
      maskedOuter: boolean
      tap: number
      total: number
    }
    const raw: RawEntry[] = []
    const compactLayerOp = (label: string): string => {
      const m = label.match(/^(LT|LM|MO|DF|PDF|TG|TT|OSL|TO)\s(\d+)$/)
      return m ? `${m[1]}${m[2]}` : label
    }
    const source = layout && Array.isArray(layout.keys)
      ? layout.keys.filter((k) => !k.decal && !k.ghost).map((k) => `${k.row},${k.col}`)
      : Array.from(heatmapCells.keys())
    for (const posKey of source) {
      const qmkId = keycodes.get(posKey) ?? ''
      const resolved = resolveSnapshotLabel(qmkId)
      const cell = heatmapCells.get(posKey)
      const total = cell?.total ?? 0
      const tap = cell?.tap ?? 0
      if (resolved.masked) {
        if (resolved.outer) {
          raw.push({
            baseLabel: compactLayerOp(resolved.outer),
            cell: posKey,
            count: total,
            group: keycodeGroup(qmkId),
            maskedOuter: true,
            tap,
            total,
          })
        }
        if (resolved.inner) {
          const innerMatch = MASK_INNER_RE.exec(qmkId)
          const innerQmkId = innerMatch ? innerMatch[1] : ''
          raw.push({
            baseLabel: resolved.inner,
            cell: posKey,
            count: tap,
            group: keycodeGroup(innerQmkId),
            maskedOuter: false,
            tap: 0,
            total: 0,
          })
        }
      } else {
        raw.push({
          baseLabel: compactLayerOp(resolved.outer || qmkId || posKey),
          cell: posKey,
          count: total,
          group: keycodeGroup(qmkId),
          maskedOuter: false,
          tap: 0,
          total: 0,
        })
      }
    }

    const filtered = keyGroupFilter === 'all'
      ? raw
      : raw.filter((r) => r.group === keyGroupFilter)

    type Entry = {
      displayLabel: string
      count: number
      cells: Set<string>
      maskedOuter: boolean
      tap: number
      total: number
    }
    let entries: Entry[]
    if (aggregateMode === 'char') {
      const byBase = new Map<string, Entry>()
      for (const r of filtered) {
        let e = byBase.get(r.baseLabel)
        if (!e) {
          e = {
            displayLabel: r.baseLabel,
            count: 0,
            cells: new Set<string>(),
            maskedOuter: r.maskedOuter,
            tap: 0,
            total: 0,
          }
          byBase.set(r.baseLabel, e)
        }
        e.count += r.count
        e.cells.add(r.cell)
        if (r.maskedOuter) {
          e.maskedOuter = true
          e.tap += r.tap
          e.total += r.total
        }
      }
      entries = Array.from(byBase.values())
    } else {
      const freq = new Map<string, number>()
      for (const r of filtered) freq.set(r.baseLabel, (freq.get(r.baseLabel) ?? 0) + 1)
      entries = filtered.map((r) => {
        const shared = (freq.get(r.baseLabel) ?? 0) > 1
        const [row, col] = r.cell.split(',')
        return {
          displayLabel: shared ? `${r.baseLabel} Row:${row} Col:${col}` : r.baseLabel,
          count: r.count,
          cells: new Set([r.cell]),
          maskedOuter: r.maskedOuter,
          tap: r.tap,
          total: r.total,
        }
      })
    }
    const frequentUsed = [...entries].sort((a, b) => b.count - a.count).slice(0, frequentUsedN)
    return { frequentUsed }
  }, [heatmapCells, keycodes, layout, frequentUsedN, aggregateMode, keyGroupFilter])

  const hoveredCells = useMemo(() => {
    if (!hoveredLabel) return undefined
    const match = rankings.frequentUsed.find((e) => e.displayLabel === hoveredLabel)
    return match ? match.cells : undefined
  }, [hoveredLabel, rankings])

  // Filter what the keyboard widget paints so the heatmap colours match
  // the ranking pane. A masked cell's outer and inner parts are judged
  // independently: `LT1(KC_BSPACE)` under `layerOp` keeps only the
  // outer (LT1) coloured, under `char` keeps only the inner (Bksp).
  // Cells where neither part matches are dropped entirely.
  const filteredHeatmapCells = useMemo(() => {
    if (keyGroupFilter === 'all') return heatmapCells
    const m = new Map<string, TypingHeatmapCell>()
    for (const [posKey, cell] of heatmapCells) {
      const qmkId = keycodes.get(posKey) ?? ''
      const masked = resolveSnapshotLabel(qmkId).masked
      const outerMatch = keycodeGroup(qmkId) === keyGroupFilter
      let innerMatch = false
      if (masked) {
        const innerExec = MASK_INNER_RE.exec(qmkId)
        const innerQmkId = innerExec ? innerExec[1] : ''
        innerMatch = keycodeGroup(innerQmkId) === keyGroupFilter
      }
      if (!outerMatch && !innerMatch) continue
      if (!masked) {
        m.set(posKey, cell)
        continue
      }
      m.set(posKey, {
        total: outerMatch ? cell.total : 0,
        tap: innerMatch ? cell.tap : 0,
        hold: outerMatch ? cell.hold : 0,
      })
    }
    return m
  }, [heatmapCells, keycodes, keyGroupFilter])

  const formatCount = (n: number): string => {
    if (normalization === 'shareOfTotal') return `${n.toFixed(2)}%`
    if (normalization === 'perHour') return `${n.toFixed(1)}/h`
    return Math.round(n).toLocaleString()
  }

  const { heatmapMaxTotal, heatmapMaxTap } = useMemo(() => {
    let total = 0
    let tap = 0
    for (const cell of filteredHeatmapCells.values()) {
      if (cell.total > total) total = cell.total
      if (cell.tap > tap) tap = cell.tap
    }
    return { heatmapMaxTotal: total, heatmapMaxTap: tap }
  }, [filteredHeatmapCells])

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
          heatmapCells={filteredHeatmapCells}
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
        <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="analyze-keyheatmap-frequent-used">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3
              id="analyze-keyheatmap-frequent-used"
              className="text-[11px] font-semibold uppercase tracking-widest text-content-muted"
            >
              {t('analyze.keyHeatmap.ranking.frequentUsed')}
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="rounded-md border border-edge bg-surface px-2 py-1 text-[12px] text-content focus:border-accent focus:outline-none"
                value={aggregateMode}
                onChange={(e) => setAggregateMode(e.target.value as AggregateMode)}
                aria-label={t('analyze.keyHeatmap.ranking.aggregate')}
                data-testid="analyze-keyheatmap-aggregate"
              >
                {AGGREGATE_MODES.map((m) => (
                  <option key={m} value={m}>{t(`analyze.keyHeatmap.ranking.aggregateOption.${m}`)}</option>
                ))}
              </select>
              <select
                className="rounded-md border border-edge bg-surface px-2 py-1 text-[12px] text-content focus:border-accent focus:outline-none"
                value={keyGroupFilter}
                onChange={(e) => setKeyGroupFilter(e.target.value as KeyGroupFilter)}
                aria-label={t('analyze.keyHeatmap.ranking.keyGroup')}
                data-testid="analyze-keyheatmap-keygroup"
              >
                {KEY_GROUPS.map((g) => (
                  <option key={g} value={g}>{t(`analyze.keyHeatmap.ranking.keyGroupOption.${g}`)}</option>
                ))}
              </select>
              <select
                className="rounded-md border border-edge bg-surface px-2 py-1 text-[12px] text-content focus:border-accent focus:outline-none"
                value={frequentUsedN}
                onChange={(e) => setFrequentUsedN(Number.parseInt(e.target.value, 10))}
                aria-label={t('analyze.keyHeatmap.ranking.frequentUsedN')}
                data-testid="analyze-keyheatmap-frequent-used-n"
              >
                {FREQUENT_USED_N_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
          </div>
          {rankings.frequentUsed.length === 0 ? (
            <div className="text-[12px] text-content-muted">{t('analyze.keyHeatmap.ranking.emptyFrequentUsed')}</div>
          ) : (
            <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto text-[12px]">
              {rankings.frequentUsed.map((entry, i) => {
                const showRatio = entry.maskedOuter && entry.total > 0
                const tapPct = showRatio ? Math.round((entry.tap / entry.total) * 100) : 0
                return (
                  <li
                    key={entry.displayLabel}
                    className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 ${hoveredLabel === entry.displayLabel ? 'bg-accent/10' : 'odd:bg-surface-dim/40'}`}
                    onMouseEnter={() => setHoveredLabel(entry.displayLabel)}
                    onMouseLeave={() => setHoveredLabel((k) => (k === entry.displayLabel ? null : k))}
                  >
                    <span className="w-6 text-right text-content-muted">{i + 1}</span>
                    <span className="flex-1 min-w-0 truncate font-mono text-content">{entry.displayLabel}</span>
                    {showRatio && (
                      <span className="font-mono text-[11px] text-content-muted">
                        tap:{tapPct}% / hold:{100 - tapPct}%
                      </span>
                    )}
                    <span className="font-mono text-content-secondary">{formatCount(entry.count)}</span>
                  </li>
                )
              })}
            </ol>
          )}
        </section>
      </div>
    </div>
  )
}
