// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import type {
  TypingKeymapSnapshot,
  TypingLayerUsageRow,
  TypingMatrixCellRow,
} from '../../../../shared/types/typing-analytics'
import {
  aggregateLayerActivations,
  aggregateLayerKeystrokes,
  buildLayerBars,
  buildLayerBarsFromCounts,
} from '../analyze-layer-usage'

const fallback = (layer: number): string => `Layer ${layer}`

describe('buildLayerBars', () => {
  it('zero-fills up to the snapshot layer count in 0..N-1 order', () => {
    const rows: TypingLayerUsageRow[] = [
      { layer: 1, keystrokes: 10 },
      { layer: 3, keystrokes: 5 },
    ]
    expect(buildLayerBars(rows, 4, [], fallback)).toEqual([
      { layer: 0, label: 'Layer 0', axisLabel: 'Layer 0', value: 0 },
      { layer: 1, label: 'Layer 1', axisLabel: 'Layer 1', value: 10 },
      { layer: 2, label: 'Layer 2', axisLabel: 'Layer 2', value: 0 },
      { layer: 3, label: 'Layer 3', axisLabel: 'Layer 3', value: 5 },
    ])
  })

  it('falls back to observedMax + 1 when the snapshot layer count is zero', () => {
    // No snapshot: the chart still surfaces the 2 layers that had presses.
    const rows: TypingLayerUsageRow[] = [
      { layer: 0, keystrokes: 3 },
      { layer: 1, keystrokes: 1 },
    ]
    expect(buildLayerBars(rows, 0, [], fallback)).toEqual([
      { layer: 0, label: 'Layer 0', axisLabel: 'Layer 0', value: 3 },
      { layer: 1, label: 'Layer 1', axisLabel: 'Layer 1', value: 1 },
    ])
  })

  it('grows beyond snapshot count when the DB reports a higher layer', () => {
    // Remote machine or stale snapshot: we never drop data silently.
    const rows: TypingLayerUsageRow[] = [
      { layer: 5, keystrokes: 2 },
    ]
    const out = buildLayerBars(rows, 2, [], fallback)
    expect(out).toHaveLength(6)
    expect(out[5]).toEqual({ layer: 5, label: 'Layer 5', axisLabel: 'Layer 5', value: 2 })
  })

  it('applies user-provided layer names with the fallback prefix', () => {
    const rows: TypingLayerUsageRow[] = [
      { layer: 0, keystrokes: 4 },
      { layer: 1, keystrokes: 2 },
    ]
    const names = ['Base', '  ', 'Navigation']
    expect(buildLayerBars(rows, 3, names, fallback)).toEqual([
      { layer: 0, label: 'Layer 0 · Base', axisLabel: 'Layer 0\nBase', value: 4 },
      // Empty/whitespace-only name falls back to just the index label.
      { layer: 1, label: 'Layer 1', axisLabel: 'Layer 1', value: 2 },
      { layer: 2, label: 'Layer 2 · Navigation', axisLabel: 'Layer 2\nNavigation', value: 0 },
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
      { layer: 0, label: 'Layer 0', axisLabel: 'Layer 0', value: 8 },
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
      { layer: 0, label: 'Layer 0', axisLabel: 'Layer 0', value: 3 },
    ])
  })

  it('returns an empty array when both snapshot count and rows are empty', () => {
    expect(buildLayerBars([], 0, [], fallback)).toEqual([])
  })
})

describe('aggregateLayerKeystrokes', () => {
  it('sums keystrokes into a Map<layer, count>', () => {
    const rows: TypingLayerUsageRow[] = [
      { layer: 0, keystrokes: 3 },
      { layer: 0, keystrokes: 2 },
      { layer: 2, keystrokes: 7 },
    ]
    const got = aggregateLayerKeystrokes(rows)
    expect(got.size).toBe(2)
    expect(got.get(0)).toBe(5)
    expect(got.get(2)).toBe(7)
  })

  it('skips invalid rows (negative / NaN layer or count)', () => {
    const rows: TypingLayerUsageRow[] = [
      { layer: -1, keystrokes: 100 },
      { layer: Number.NaN, keystrokes: 100 },
      { layer: 0, keystrokes: Number.NaN },
      { layer: 0, keystrokes: 3 },
    ]
    const got = aggregateLayerKeystrokes(rows)
    expect(got.size).toBe(1)
    expect(got.get(0)).toBe(3)
  })
})

function snapshotWithKeymap(keymap: string[][][]): TypingKeymapSnapshot {
  return {
    uid: '0x00',
    machineHash: 'h',
    productName: 'Test',
    savedAt: 0,
    layers: keymap.length,
    matrix: { rows: keymap[0]?.length ?? 0, cols: keymap[0]?.[0]?.length ?? 0 },
    keymap,
    layout: null,
  }
}

describe('aggregateLayerActivations', () => {
  // Keymap for these scenarios: layer 0 holds the layer-op keys, and
  // layers 1..3 echo a plain character so we can assert that taps /
  // non-layer-op presses never contribute to activations.
  const keymap: string[][][] = [
    [
      ['MO(1)', 'LT2(KC_A)', 'TG(3)', 'KC_B'],
    ],
    [
      ['KC_B', 'KC_B', 'KC_B', 'KC_B'],
    ],
    [
      ['KC_C', 'KC_C', 'KC_C', 'KC_C'],
    ],
    [
      ['KC_D', 'KC_D', 'KC_D', 'KC_D'],
    ],
  ]
  const snapshot = snapshotWithKeymap(keymap)

  it('dispatches press-kind ops (MO / TG) to their target layer using `count`', () => {
    const cells: TypingMatrixCellRow[] = [
      { layer: 0, row: 0, col: 0, count: 4, tap: 0, hold: 0 }, // MO(1) pressed 4x → layer 1 +4
      { layer: 0, row: 0, col: 2, count: 2, tap: 0, hold: 0 }, // TG(3) pressed 2x → layer 3 +2
    ]
    const got = aggregateLayerActivations(cells, snapshot)
    expect(got.get(1)).toBe(4)
    expect(got.get(3)).toBe(2)
    expect(got.size).toBe(2)
  })

  it('dispatches hold-kind ops (LT / LM) using `hold` only; tap portion is ignored', () => {
    // LT2(KC_A) pressed 10x: 7 as tap (inner KC_A), 3 as hold (layer 2).
    const cells: TypingMatrixCellRow[] = [
      { layer: 0, row: 0, col: 1, count: 10, tap: 7, hold: 3 },
    ]
    const got = aggregateLayerActivations(cells, snapshot)
    expect(got.get(2)).toBe(3)
    expect(got.size).toBe(1)
  })

  it('ignores non-layer-op cells', () => {
    const cells: TypingMatrixCellRow[] = [
      // plain KC_B on layer 0 (not a layer-op) — never counts
      { layer: 0, row: 0, col: 3, count: 100, tap: 0, hold: 0 },
      // KC_B while layer 1 is active — also not a layer-op
      { layer: 1, row: 0, col: 0, count: 50, tap: 0, hold: 0 },
    ]
    const got = aggregateLayerActivations(cells, snapshot)
    expect(got.size).toBe(0)
  })

  it('returns an empty Map when the snapshot has no keymap', () => {
    const emptySnap: TypingKeymapSnapshot = snapshotWithKeymap([])
    const cells: TypingMatrixCellRow[] = [
      { layer: 0, row: 0, col: 0, count: 4, tap: 0, hold: 0 },
    ]
    expect(aggregateLayerActivations(cells, emptySnap).size).toBe(0)
  })

  it('silently skips cells whose (layer,row,col) falls outside the snapshot keymap', () => {
    // row/col indices that the snapshot doesn't cover — guards against
    // races between an older snapshot and a resized keymap.
    const cells: TypingMatrixCellRow[] = [
      { layer: 9, row: 0, col: 0, count: 4, tap: 0, hold: 0 }, // layer OOB
      { layer: 0, row: 99, col: 0, count: 4, tap: 0, hold: 0 }, // row OOB
      { layer: 0, row: 0, col: 99, count: 4, tap: 0, hold: 0 }, // col OOB
      { layer: 0, row: 0, col: 0, count: 5, tap: 0, hold: 0 }, // valid: MO(1) → +5
    ]
    const got = aggregateLayerActivations(cells, snapshot)
    expect(got.size).toBe(1)
    expect(got.get(1)).toBe(5)
  })

  it('combines with buildLayerBarsFromCounts to produce a ready-to-render bar list', () => {
    const cells: TypingMatrixCellRow[] = [
      { layer: 0, row: 0, col: 0, count: 4, tap: 0, hold: 0 }, // MO(1) +4
      { layer: 0, row: 0, col: 1, count: 10, tap: 7, hold: 3 }, // LT2 +3
    ]
    const byLayer = aggregateLayerActivations(cells, snapshot)
    const bars = buildLayerBarsFromCounts(byLayer, snapshot.layers, [], (l) => `Layer ${l}`)
    expect(bars).toEqual([
      { layer: 0, label: 'Layer 0', axisLabel: 'Layer 0', value: 0 },
      { layer: 1, label: 'Layer 1', axisLabel: 'Layer 1', value: 4 },
      { layer: 2, label: 'Layer 2', axisLabel: 'Layer 2', value: 3 },
      { layer: 3, label: 'Layer 3', axisLabel: 'Layer 3', value: 0 },
    ])
  })

  it('drops presses that dispatch to `excludeLayer` (base-layer noise suppression)', () => {
    // Keymap extended with a layer-op pointing AT the base layer (LT0)
    // plus a real transition (MO(2)), to mimic the LT0(KC_ESC) edge
    // case the user surfaced during rollout testing.
    const km: string[][][] = [
      [
        ['LT0(KC_ESCAPE)', 'MO(2)', 'KC_A', 'KC_B'],
      ],
      [['KC_X', 'KC_X', 'KC_X', 'KC_X']],
      [['KC_Y', 'KC_Y', 'KC_Y', 'KC_Y']],
      [['KC_Z', 'KC_Z', 'KC_Z', 'KC_Z']],
    ]
    const snap = snapshotWithKeymap(km)
    const cells: TypingMatrixCellRow[] = [
      // LT0 held twice — would normally bucket into layer 0 and
      // drown out real transitions.
      { layer: 0, row: 0, col: 0, count: 2, tap: 0, hold: 2 },
      // MO(2) pressed three times — the real activation.
      { layer: 0, row: 0, col: 1, count: 3, tap: 0, hold: 0 },
    ]
    const got = aggregateLayerActivations(cells, snap, { excludeLayer: 0 })
    expect(got.has(0)).toBe(false)
    expect(got.get(2)).toBe(3)
  })
})

describe('buildLayerBarsFromCounts excludeLayer', () => {
  it('omits the excluded layer from the output bar list', () => {
    const byLayer = new Map<number, number>([
      [0, 100],
      [1, 5],
      [2, 3],
    ])
    const bars = buildLayerBarsFromCounts(
      byLayer,
      4,
      [],
      (l) => `Layer ${l}`,
      { excludeLayer: 0 },
    )
    expect(bars).toEqual([
      { layer: 1, label: 'Layer 1', axisLabel: 'Layer 1', value: 5 },
      { layer: 2, label: 'Layer 2', axisLabel: 'Layer 2', value: 3 },
      { layer: 3, label: 'Layer 3', axisLabel: 'Layer 3', value: 0 },
    ])
  })

  it('includes every layer when excludeLayer is undefined', () => {
    const byLayer = new Map<number, number>([[0, 1]])
    const bars = buildLayerBarsFromCounts(byLayer, 2, [], (l) => `Layer ${l}`)
    expect(bars).toHaveLength(2)
    expect(bars[0]).toEqual({ layer: 0, label: 'Layer 0', axisLabel: 'Layer 0', value: 1 })
  })

  it('uses a newline separator in axisLabel when a name is present', () => {
    const byLayer = new Map<number, number>([[1, 7]])
    const bars = buildLayerBarsFromCounts(byLayer, 2, ['Base', 'Nav'], (l) => `L${l}`)
    expect(bars).toEqual([
      { layer: 0, label: 'L0 · Base', axisLabel: 'L0\nBase', value: 0 },
      { layer: 1, label: 'L1 · Nav', axisLabel: 'L1\nNav', value: 7 },
    ])
  })
})
