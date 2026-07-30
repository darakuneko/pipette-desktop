// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  selectTapHoldDurationCells,
  selectTapHoldMatrixCells,
  tapHoldPositionKeys,
} from '../analyze-tapping-term-cells'
import type { TypingDurationCell, TypingKeymapSnapshot, TypingMatrixCellRow } from '../../../../shared/types/typing-analytics'

function snapshot(keymap: string[][][], vialProtocol?: number): TypingKeymapSnapshot {
  return {
    uid: 'uid-1',
    machineHash: 'hash-1',
    productName: 'Test Keyboard',
    savedAt: 0,
    layers: keymap.length,
    matrix: { rows: 1, cols: keymap[0]?.[0]?.length ?? 0 },
    keymap,
    layout: null,
    vialProtocol,
  }
}

function durationCell(layer: number, row: number, col: number): TypingDurationCell {
  return { layer, row, col, durationSamples: 10, hist: [10, 0, 0, 0, 0, 0, 0, 0], sum: 100, sumSq: 1_000 }
}

function matrixCell(layer: number, row: number, col: number): TypingMatrixCellRow {
  return { layer, row, col, count: 10, tap: 6, hold: 4 }
}

describe('tapHoldPositionKeys', () => {
  it('finds no tap-hold keys in a plain keymap', () => {
    const snap = snapshot([[['KC_A', 'KC_B', 'KC_C']]])
    expect(tapHoldPositionKeys(snap).size).toBe(0)
  })

  it('identifies Layer-Tap, Mod-Tap and Swap-Hands-Tap keys across the keymap', () => {
    const snap = snapshot([[['KC_A', 'LT(1,KC_SPC)', 'MT(MOD_LSFT, KC_A)', 'SH_T(KC_A)']]])
    const keys = tapHoldPositionKeys(snap)
    expect(keys.has('0:0,1')).toBe(true)
    expect(keys.has('0:0,2')).toBe(true)
    expect(keys.has('0:0,3')).toBe(true)
    expect(keys.has('0:0,0')).toBe(false)
    expect(keys.size).toBeGreaterThan(0)
  })

  it('does not flag a plain modifier-mask keycode as tap-hold', () => {
    const snap = snapshot([[['LCTL(KC_A)']]])
    expect(tapHoldPositionKeys(snap).size).toBe(0)
  })

  it('returns an empty set for a malformed keymap', () => {
    const malformed = snapshot([])
    expect(tapHoldPositionKeys(malformed).size).toBe(0)
  })

  it('scans every layer, not just the first', () => {
    const snap = snapshot([
      [['KC_A', 'KC_B']],
      [['KC_C', 'LT(2,KC_D)']],
    ])
    const keys = tapHoldPositionKeys(snap)
    expect(keys.has('1:0,1')).toBe(true)
    expect(keys.has('0:0,1')).toBe(false)
  })
})

describe('selectTapHoldDurationCells / selectTapHoldMatrixCells', () => {
  const keys = tapHoldPositionKeys(snapshot([[['KC_A', 'LT(1,KC_SPC)', 'KC_C']]]))

  it('keeps only cells sitting on a tap-hold position', () => {
    const cells = [durationCell(0, 0, 0), durationCell(0, 0, 1), durationCell(0, 0, 2)]
    const selected = selectTapHoldDurationCells(keys, cells)
    expect(selected).toHaveLength(1)
    expect(selected[0]).toMatchObject({ layer: 0, row: 0, col: 1 })
  })

  it('returns an empty array when the position-key set is empty', () => {
    const emptyKeys = tapHoldPositionKeys(snapshot([[['KC_A', 'KC_B']]]))
    const cells = [durationCell(0, 0, 0), durationCell(0, 0, 1)]
    expect(selectTapHoldDurationCells(emptyKeys, cells)).toEqual([])
  })

  it('applies the same filter to matrix cell rows (tap/hold context counts)', () => {
    const cells = [matrixCell(0, 0, 0), matrixCell(0, 0, 1)]
    const selected = selectTapHoldMatrixCells(keys, cells)
    expect(selected).toHaveLength(1)
    expect(selected[0]).toMatchObject({ layer: 0, row: 0, col: 1 })
  })

  it('ignores a cell recorded on a position from another layer', () => {
    const cells = [durationCell(1, 0, 1)]
    expect(selectTapHoldDurationCells(keys, cells)).toEqual([])
  })
})
