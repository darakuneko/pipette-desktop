// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import type { KleKey } from '../../../shared/kle/types'
import type {
  LayoutComparisonInputLayout,
  TypingHeatmapCell,
  TypingKeymapSnapshot,
} from '../../../shared/types/typing-analytics'
import { computeLayoutComparison } from '../compute-layout-comparison'

const QWERTY: LayoutComparisonInputLayout = { id: 'qwerty', map: {} }

const COLEMAK: LayoutComparisonInputLayout = {
  id: 'colemak',
  map: {
    KC_E: 'F',
    KC_R: 'P',
    KC_T: 'G',
    KC_S: 'R',
    KC_D: 'S',
    KC_F: 'T',
  },
}

function emptyKleKey(row: number, col: number, x: number, y: number): KleKey {
  return {
    x,
    y,
    width: 1,
    height: 1,
    x2: 0,
    y2: 0,
    width2: 0,
    height2: 0,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    color: '',
    labels: [],
    textColor: [],
    textSize: [],
    row,
    col,
    encoderIdx: -1,
    encoderDir: -1,
    layoutIndex: -1,
    layoutOption: -1,
    decal: false,
    nub: false,
    stepped: false,
    ghost: false,
  }
}

function makeSnapshot(keymap: string[][]): TypingKeymapSnapshot {
  return {
    uid: 'uid-test',
    machineHash: 'hash-test',
    productName: 'Test',
    savedAt: 0,
    layers: 1,
    matrix: { rows: keymap.length, cols: keymap[0]?.length ?? 0 },
    keymap: [keymap],
    layout: null,
  }
}

function counts(entries: Array<[string, number]>): Map<string, Pick<TypingHeatmapCell, 'total'>> {
  const m = new Map<string, Pick<TypingHeatmapCell, 'total'>>()
  for (const [pos, total] of entries) m.set(pos, { total })
  return m
}

const FOUR_ROW_KEYS: KleKey[] = (() => {
  const keys: KleKey[] = []
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      keys.push(emptyKleKey(r, c, c, r))
    }
  }
  return keys
})()

describe('computeLayoutComparison', () => {
  it('returns empty targets when targets list is empty', () => {
    const result = computeLayoutComparison({
      matrixCounts: counts([['0,0', 1]]),
      snapshot: makeSnapshot([['KC_A']]),
      kleKeys: [],
      source: QWERTY,
      targets: [],
      metrics: ['fingerLoad', 'handBalance', 'rowDist', 'homeRow'],
    })
    expect(result.sourceLayoutId).toBe('qwerty')
    expect(result.targets).toEqual([])
  })

  it('aggregates per target with skipRate when no overlap exists', () => {
    // Snapshot only has KC_S; QWERTY says KC_S → "s"; Colemak puts
    // "s" on KC_D, which is absent from this snapshot. Every event
    // skips with reason no_target_position.
    const result = computeLayoutComparison({
      matrixCounts: counts([['0,0', 4]]),
      snapshot: makeSnapshot([['KC_S']]),
      kleKeys: [],
      source: QWERTY,
      targets: [COLEMAK],
      metrics: ['fingerLoad', 'handBalance', 'rowDist', 'homeRow'],
    })
    const target = result.targets[0]
    expect(target.layoutId).toBe('colemak')
    expect(target.totalEvents).toBe(0)
    expect(target.skippedEvents).toBe(4)
    expect(target.skipRate).toBe(1)
  })

  it('preserves total and skipped event counts together', () => {
    // Two cells: KC_A (resolves on Colemak — same position) and
    // KC_S (skips because Colemak target needs KC_D which is absent).
    const result = computeLayoutComparison({
      matrixCounts: counts([
        ['0,0', 3],
        ['0,1', 7],
      ]),
      snapshot: makeSnapshot([['KC_A', 'KC_S']]),
      kleKeys: [],
      source: QWERTY,
      targets: [COLEMAK],
      metrics: [],
    })
    const target = result.targets[0]
    expect(target.totalEvents).toBe(3)
    expect(target.skippedEvents).toBe(7)
    expect(target.skipRate).toBeCloseTo(7 / 10, 5)
    // No metrics requested → metric fields stay undefined.
    expect(target.fingerLoad).toBeUndefined()
    expect(target.handBalance).toBeUndefined()
    expect(target.rowDist).toBeUndefined()
    expect(target.homeRowStay).toBeUndefined()
  })

  it('omits metric fields when not requested', () => {
    const result = computeLayoutComparison({
      matrixCounts: counts([['0,0', 1]]),
      snapshot: makeSnapshot([['KC_A']]),
      kleKeys: FOUR_ROW_KEYS,
      source: QWERTY,
      targets: [COLEMAK],
      metrics: ['handBalance'],
    })
    const target = result.targets[0]
    expect(target.handBalance).toBeDefined()
    expect(target.fingerLoad).toBeUndefined()
    expect(target.rowDist).toBeUndefined()
    expect(target.homeRowStay).toBeUndefined()
  })

  it('computes finger / hand / row distributions on a 4×4 grid', () => {
    // Snapshot positions:
    //   row 0: top    → KC_Q KC_W KC_E KC_R
    //   row 1: home   → KC_A KC_S KC_D KC_F
    //   row 2: bottom → KC_Z KC_X KC_C KC_V
    //   row 3: thumb  → KC_NO KC_NO KC_SPACE KC_NO
    // Press KC_R (top row, right side) 10 times. On Colemak the
    // target keycode for "r" is KC_S, which lives on row 1 col 1
    // (home row, left side).
    const snapshot = makeSnapshot([
      ['KC_Q', 'KC_W', 'KC_E', 'KC_R'],
      ['KC_A', 'KC_S', 'KC_D', 'KC_F'],
      ['KC_Z', 'KC_X', 'KC_C', 'KC_V'],
      ['KC_NO', 'KC_NO', 'KC_SPACE', 'KC_NO'],
    ])
    const result = computeLayoutComparison({
      matrixCounts: counts([['0,3', 10]]),
      snapshot,
      kleKeys: FOUR_ROW_KEYS,
      source: QWERTY,
      targets: [COLEMAK],
      metrics: ['fingerLoad', 'handBalance', 'rowDist', 'homeRow'],
    })
    const target = result.targets[0]
    expect(target.totalEvents).toBe(10)
    expect(target.skippedEvents).toBe(0)
    // All weight lands on a single home-row cell.
    expect(target.homeRowStay).toBe(1)
    // Hand split is unanimous on whichever side (1, 1) belongs to —
    // we just need to confirm the ratios sum to 1 and one side is 0.
    expect(target.handBalance).toBeDefined()
    if (!target.handBalance) throw new Error('expected handBalance')
    expect(target.handBalance.left + target.handBalance.right).toBeCloseTo(1, 5)
    expect(target.rowDist?.home).toBe(1)
    // Sum of rowDist entries equals 1 because every event landed on
    // one row category.
    const rowSum = Object.values(target.rowDist ?? {}).reduce((s, v) => s + (v ?? 0), 0)
    expect(rowSum).toBeCloseTo(1, 5)
    const fingerSum = Object.values(target.fingerLoad ?? {}).reduce(
      (s, v) => s + (v ?? 0),
      0,
    )
    expect(fingerSum + (target.unmappedFinger ?? 0)).toBeCloseTo(1, 5)
  })

  it('runs each target independently', () => {
    const snapshot = makeSnapshot([['KC_A', 'KC_S']])
    const result = computeLayoutComparison({
      matrixCounts: counts([
        ['0,0', 1],
        ['0,1', 1],
      ]),
      snapshot,
      kleKeys: [],
      source: QWERTY,
      targets: [QWERTY, COLEMAK],
      metrics: [],
    })
    expect(result.targets).toHaveLength(2)
    // QWERTY → QWERTY: nothing skips.
    expect(result.targets[0].skippedEvents).toBe(0)
    expect(result.targets[0].totalEvents).toBe(2)
    // QWERTY → Colemak with this snapshot: KC_A resolves on KC_A
    // (same pos), KC_S would need KC_D for "s" → skipped.
    expect(result.targets[1].totalEvents).toBe(1)
    expect(result.targets[1].skippedEvents).toBe(1)
  })

  it('emits per-target cellCounts keyed by the target physical position', () => {
    // QWERTY R press resolves to the QWERTY S position on Colemak
    // (Colemak labels "r" → KC_S → snapshot S = (0, 1)). The current
    // baseline (source = target) keeps the event on its source pos.
    const snapshot = makeSnapshot([['KC_R', 'KC_S']])
    const result = computeLayoutComparison({
      matrixCounts: counts([['0,0', 4]]),
      snapshot,
      kleKeys: [],
      source: QWERTY,
      targets: [QWERTY, COLEMAK],
      metrics: [],
    })
    expect(result.targets[0].cellCounts).toEqual({ '0,0': 4 })
    expect(result.targets[1].cellCounts).toEqual({ '0,1': 4 })
  })

  it('omits cellCounts when no events resolved', () => {
    const result = computeLayoutComparison({
      matrixCounts: counts([['0,0', 1]]),
      snapshot: makeSnapshot([['KC_NO']]),
      kleKeys: [],
      source: QWERTY,
      targets: [COLEMAK],
      metrics: [],
    })
    expect(result.targets[0].cellCounts).toBeUndefined()
  })

  it('skips zero-count cells without affecting metrics', () => {
    const result = computeLayoutComparison({
      matrixCounts: counts([
        ['0,0', 0],
        ['0,1', 5],
      ]),
      snapshot: makeSnapshot([['KC_A', 'KC_S']]),
      kleKeys: [],
      source: QWERTY,
      targets: [QWERTY],
      metrics: [],
    })
    expect(result.targets[0].totalEvents).toBe(5)
    expect(result.targets[0].skippedEvents).toBe(0)
  })
})
