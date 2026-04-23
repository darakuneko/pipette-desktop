// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import type { TypingLayerUsageRow } from '../../../../shared/types/typing-analytics'
import { buildLayerBars } from '../analyze-layer-usage'

const fallback = (layer: number): string => `Layer ${layer}`

describe('buildLayerBars', () => {
  it('zero-fills up to the snapshot layer count in 0..N-1 order', () => {
    const rows: TypingLayerUsageRow[] = [
      { layer: 1, keystrokes: 10 },
      { layer: 3, keystrokes: 5 },
    ]
    expect(buildLayerBars(rows, 4, [], fallback)).toEqual([
      { layer: 0, label: 'Layer 0', keystrokes: 0 },
      { layer: 1, label: 'Layer 1', keystrokes: 10 },
      { layer: 2, label: 'Layer 2', keystrokes: 0 },
      { layer: 3, label: 'Layer 3', keystrokes: 5 },
    ])
  })

  it('falls back to observedMax + 1 when the snapshot layer count is zero', () => {
    // No snapshot: the chart still surfaces the 2 layers that had presses.
    const rows: TypingLayerUsageRow[] = [
      { layer: 0, keystrokes: 3 },
      { layer: 1, keystrokes: 1 },
    ]
    expect(buildLayerBars(rows, 0, [], fallback)).toEqual([
      { layer: 0, label: 'Layer 0', keystrokes: 3 },
      { layer: 1, label: 'Layer 1', keystrokes: 1 },
    ])
  })

  it('grows beyond snapshot count when the DB reports a higher layer', () => {
    // Remote machine or stale snapshot: we never drop data silently.
    const rows: TypingLayerUsageRow[] = [
      { layer: 5, keystrokes: 2 },
    ]
    const out = buildLayerBars(rows, 2, [], fallback)
    expect(out).toHaveLength(6)
    expect(out[5]).toEqual({ layer: 5, label: 'Layer 5', keystrokes: 2 })
  })

  it('applies user-provided layer names with the fallback prefix', () => {
    const rows: TypingLayerUsageRow[] = [
      { layer: 0, keystrokes: 4 },
      { layer: 1, keystrokes: 2 },
    ]
    const names = ['Base', '  ', 'Navigation']
    expect(buildLayerBars(rows, 3, names, fallback)).toEqual([
      { layer: 0, label: 'Layer 0 · Base', keystrokes: 4 },
      // Empty/whitespace-only name falls back to just the index label.
      { layer: 1, label: 'Layer 1', keystrokes: 2 },
      { layer: 2, label: 'Layer 2 · Navigation', keystrokes: 0 },
    ])
  })

  it('sums duplicate layer rows', () => {
    // The SQL path GROUPs BY layer already, but callers may want to
    // merge multiple IPC results (e.g. own + remote). Fold defensively.
    const rows: TypingLayerUsageRow[] = [
      { layer: 0, keystrokes: 3 },
      { layer: 0, keystrokes: 5 },
    ]
    expect(buildLayerBars(rows, 1, [], fallback)).toEqual([
      { layer: 0, label: 'Layer 0', keystrokes: 8 },
    ])
  })

  it('skips invalid rows (negative / NaN / non-finite layer or keystrokes)', () => {
    const rows: TypingLayerUsageRow[] = [
      { layer: -1, keystrokes: 100 },
      { layer: Number.NaN, keystrokes: 100 },
      { layer: 0, keystrokes: Number.NaN },
      { layer: 0, keystrokes: 3 },
    ]
    expect(buildLayerBars(rows, 1, [], fallback)).toEqual([
      { layer: 0, label: 'Layer 0', keystrokes: 3 },
    ])
  })

  it('returns an empty array when both snapshot count and rows are empty', () => {
    expect(buildLayerBars([], 0, [], fallback)).toEqual([])
  })
})
