// SPDX-License-Identifier: GPL-2.0-or-later
// Helpers for the Analyze > Layer tab. Pure functions so the bar
// ordering / zero-fill behaviour can be unit-tested without pulling in
// recharts or the component.

import { getLayerOpTarget } from '../../../shared/keycodes/keycodes'
import type {
  TypingKeymapSnapshot,
  TypingLayerUsageRow,
  TypingMatrixCellRow,
} from '../../../shared/types/typing-analytics'

export interface LayerBar {
  layer: number
  /** Single-line label used by the tooltip — `"Layer 0"` when no name
   * is configured, or `"Layer 0 · Base"` when a layer name exists. */
  label: string
  /** Multi-line variant of {@link label} for the chart axis tick.
   * Lines are separated by `\n`: `"Layer 0\nBase"` when a name
   * exists, or `"Layer 0"` alone otherwise. Keep the tooltip and the
   * axis wording in sync by deriving both from the same name. */
  axisLabel: string
  value: number
}

function coerceNonNegativeLayer(layer: number): number | null {
  return Number.isFinite(layer) && layer >= 0 ? layer : null
}

function coerceCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

export interface BuildLayerBarsOptions {
  /** Drop this layer index from the output entirely (used by the
   * Activations mode so the Base layer isn't rendered as a `0` bar
   * alongside the real activations). When omitted, every layer
   * 0..N-1 is included. */
  excludeLayer?: number
}

/**
 * Fold a Map<layer, count> into one bar per layer index, preserving
 * 0..N-1 ordering and zero-filling gaps. `layerCount` pins the
 * displayed range (usually the snapshot's layer count); when the
 * aggregation returns a higher layer index, the chart grows to
 * include it so remote / stale data isn't silently dropped. Labels
 * use `fallbackLabel(i)` alone when no keyboard-defined layer name
 * is present, or `"<fallback> · <name>"` when it is — that way the
 * bar stays identifiable even if the user rebinds the name list
 * partway through the range.
 */
export function buildLayerBarsFromCounts(
  byLayer: ReadonlyMap<number, number>,
  layerCount: number,
  layerNames: string[],
  fallbackLabel: (layer: number) => string,
  options: BuildLayerBarsOptions = {},
): LayerBar[] {
  const { excludeLayer } = options
  let observedMax = -1
  for (const layer of byLayer.keys()) {
    if (layer > observedMax) observedMax = layer
  }
  const effectiveCount = Math.max(layerCount, observedMax + 1, 0)
  const bars: LayerBar[] = []
  for (let i = 0; i < effectiveCount; i++) {
    if (excludeLayer !== undefined && i === excludeLayer) continue
    const name = layerNames[i]?.trim()
    const base = fallbackLabel(i)
    const hasName = !!(name && name.length > 0)
    bars.push({
      layer: i,
      label: hasName ? `${base} · ${name}` : base,
      axisLabel: hasName ? `${base}\n${name}` : base,
      value: byLayer.get(i) ?? 0,
    })
  }
  return bars
}

/** Keystrokes-per-layer aggregator — sums TypingLayerUsageRow rows by
 * layer index and returns a Map that {@link buildLayerBarsFromCounts}
 * can render. Defensive against IPC hiccups that could surface
 * NaN / Infinity / negative values. */
export function aggregateLayerKeystrokes(
  rows: ReadonlyArray<TypingLayerUsageRow>,
): Map<number, number> {
  const byLayer = new Map<number, number>()
  for (const r of rows) {
    const layer = coerceNonNegativeLayer(r.layer)
    if (layer === null) continue
    const add = coerceCount(r.keystrokes)
    if (add === 0) continue
    byLayer.set(layer, (byLayer.get(layer) ?? 0) + add)
  }
  return byLayer
}

/** Back-compat wrapper for the v1 Keystrokes path: returns LayerBar[]
 * directly from TypingLayerUsageRow[]. New callers should compose
 * {@link aggregateLayerKeystrokes} with {@link buildLayerBarsFromCounts}
 * for clarity. */
export function buildLayerBars(
  rows: ReadonlyArray<TypingLayerUsageRow>,
  layerCount: number,
  layerNames: string[],
  fallbackLabel: (layer: number) => string,
): LayerBar[] {
  return buildLayerBarsFromCounts(
    aggregateLayerKeystrokes(rows),
    layerCount,
    layerNames,
    fallbackLabel,
  )
}

export interface AggregateLayerActivationsOptions {
  /** Drop presses that dispatch to this layer index (e.g. the Base
   * layer). Meant for "`LT0(KC_ESC)` hold = no meaningful transition"
   * cases where folding that count into bars would be misleading. */
  excludeLayer?: number
}

/** Layer-activations aggregator — folds per-cell matrix totals into
 * target-layer activation counts. For each cell, the serialized QMK
 * id comes from `snapshot.keymap[layer][row][col]`; layer-op keycodes
 * dispatch to their target layer via
 * {@link import('../../../shared/keycodes/keycodes-utils').getLayerOpTarget}.
 * Semantics:
 *
 *   - `MO(n)` / `TG(n)` / `TO(n)` / `DF(n)` / `PDF(n)` / `OSL(n)` /
 *     `TT(n)`: every press activates — use `count`.
 *   - `LT(n, kc)` / `LM(n, mod)`: only the hold arm activates the
 *     layer; taps go to the inner keycode — use `hold`.
 *
 * Cells whose snapshot slot is empty, non-layer-op, or outside the
 * snapshot's keymap shape are silently skipped. Returns a
 * `Map<layer, activationCount>` that {@link buildLayerBarsFromCounts}
 * can render with the same axis styling as the Keystrokes view.
 */
export function aggregateLayerActivations(
  cells: ReadonlyArray<TypingMatrixCellRow>,
  snapshot: TypingKeymapSnapshot,
  options: AggregateLayerActivationsOptions = {},
): Map<number, number> {
  const { excludeLayer } = options
  const byLayer = new Map<number, number>()
  const keymap = snapshot.keymap
  if (!Array.isArray(keymap)) return byLayer
  for (const cell of cells) {
    const srcLayer = coerceNonNegativeLayer(cell.layer)
    if (srcLayer === null) continue
    const layerKeymap = keymap[srcLayer]
    if (!Array.isArray(layerKeymap)) continue
    const rowKeymap = layerKeymap[cell.row]
    if (!Array.isArray(rowKeymap)) continue
    const qmkId = rowKeymap[cell.col]
    if (typeof qmkId !== 'string') continue
    const target = getLayerOpTarget(qmkId)
    if (target === null) continue
    if (excludeLayer !== undefined && target.layer === excludeLayer) continue
    const raw = target.kind === 'hold' ? cell.hold : cell.count
    const add = coerceCount(raw)
    if (add === 0) continue
    byLayer.set(target.layer, (byLayer.get(target.layer) ?? 0) + add)
  }
  return byLayer
}
