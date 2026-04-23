// SPDX-License-Identifier: GPL-2.0-or-later
// Helpers for the Analyze > Layer tab. Pure functions so the bar
// ordering / zero-fill behaviour can be unit-tested without pulling in
// recharts or the component.

import type { TypingLayerUsageRow } from '../../../shared/types/typing-analytics'

export interface LayerBar {
  layer: number
  label: string
  keystrokes: number
}

/**
 * Fold the IPC rows into one bar per layer index, preserving 0..N-1
 * ordering and zero-filling gaps. `layerCount` pins the displayed
 * range (usually the snapshot's layer count); when the DB returns a
 * higher layer index, the chart grows to include it so remote / stale
 * data isn't silently dropped. Labels use `fallbackLabel(i)` alone
 * when no keyboard-defined layer name is present, or
 * `"<fallback> · <name>"` when it is — that way the bar stays
 * identifiable even if the user rebinds the name list partway through
 * the range.
 */
export function buildLayerBars(
  rows: TypingLayerUsageRow[],
  layerCount: number,
  layerNames: string[],
  fallbackLabel: (layer: number) => string,
): LayerBar[] {
  const byLayer = new Map<number, number>()
  let observedMax = -1
  for (const r of rows) {
    // Guard against IPC hiccups returning NaN / Infinity / negatives
    // (SQLite aggregates can surface odd values under edge cases and
    // we never want the chart total to go NaN).
    if (!Number.isFinite(r.layer) || r.layer < 0) continue
    const count = Number.isFinite(r.keystrokes) ? r.keystrokes : 0
    byLayer.set(r.layer, (byLayer.get(r.layer) ?? 0) + count)
    if (r.layer > observedMax) observedMax = r.layer
  }
  const effectiveCount = Math.max(layerCount, observedMax + 1, 0)
  const bars: LayerBar[] = []
  for (let i = 0; i < effectiveCount; i++) {
    const name = layerNames[i]?.trim()
    bars.push({
      layer: i,
      label: name && name.length > 0 ? `${fallbackLabel(i)} · ${name}` : fallbackLabel(i),
      keystrokes: byLayer.get(i) ?? 0,
    })
  }
  return bars
}
