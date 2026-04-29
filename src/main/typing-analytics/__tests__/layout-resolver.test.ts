// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import type { LayoutShape } from '../../../shared/keymap/layout-parse'
import type { KleKey } from '../../../shared/kle/types'
import type { TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'
import { buildLayoutResolver } from '../layout-resolver'

const QWERTY: LayoutShape = { map: {} }

const COLEMAK: LayoutShape = {
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

describe('buildLayoutResolver', () => {
  it('translates a QWERTY R press to the Colemak S position', () => {
    const snapshot = makeSnapshot([
      ['KC_R', 'KC_S', 'KC_A'],
    ])
    const resolver = buildLayoutResolver({
      snapshot,
      kleKeys: [],
      sourceLayout: QWERTY,
      targetLayout: COLEMAK,
    })
    const result = resolver.resolve(0, 0)
    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.char).toBe('r')
    expect(result.sourceKeycode).toBe('KC_R')
    // Colemak puts "r" on the QWERTY S position (KC_S).
    expect(result.targetKeycode).toBe('KC_S')
    expect(result.targetRow).toBe(0)
    expect(result.targetCol).toBe(1)
  })

  it('keeps un-overridden keys mapped to themselves on Colemak', () => {
    const snapshot = makeSnapshot([['KC_A']])
    const resolver = buildLayoutResolver({
      snapshot,
      kleKeys: [],
      sourceLayout: QWERTY,
      targetLayout: COLEMAK,
    })
    const result = resolver.resolve(0, 0)
    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.targetKeycode).toBe('KC_A')
    expect(result.targetRow).toBe(0)
    expect(result.targetCol).toBe(0)
  })

  it('unwraps masked keycodes to their inner basic keycode', () => {
    // LSFT(KC_A) at (1, 0) should resolve as if KC_A had been pressed.
    const snapshot = makeSnapshot([
      ['KC_NO', 'KC_NO', 'KC_A'],
      ['LSFT(KC_A)'],
    ])
    const resolver = buildLayoutResolver({
      snapshot,
      kleKeys: [],
      sourceLayout: QWERTY,
      targetLayout: COLEMAK,
    })
    const result = resolver.resolve(1, 0)
    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.char).toBe('a')
    expect(result.sourceKeycode).toBe('KC_A')
    // First-occurrence wins for the inner→pos index, so target lookup
    // of KC_A returns the (0, 2) recorded earlier in row order.
    expect(result.targetRow).toBe(0)
    expect(result.targetCol).toBe(2)
  })

  it('skips positions whose keycode has no resolvable inner', () => {
    // MO(1) is a layer-modifier; its inner ("1") is not a Keycode.
    const snapshot = makeSnapshot([['MO(1)']])
    const resolver = buildLayoutResolver({
      snapshot,
      kleKeys: [],
      sourceLayout: QWERTY,
      targetLayout: COLEMAK,
    })
    expect(resolver.resolve(0, 0)).toEqual({
      skipped: true,
      skipReason: 'unmapped_keycode',
    })
  })

  it('skips positions whose source keycode has no printable char', () => {
    // KC_NO resolves to a Keycode but has no `printable`, so it has
    // no source-layout char to look up on the target.
    const snapshot = makeSnapshot([['KC_NO']])
    const resolver = buildLayoutResolver({
      snapshot,
      kleKeys: [],
      sourceLayout: QWERTY,
      targetLayout: COLEMAK,
    })
    expect(resolver.resolve(0, 0)).toEqual({
      skipped: true,
      skipReason: 'no_char',
    })
  })

  it('skips when the target layout cannot reach the same char on this snapshot', () => {
    // Snapshot only has KC_S. Pressing it produces "s" on QWERTY.
    // Colemak puts "s" on KC_D, but the snapshot has no KC_D.
    const snapshot = makeSnapshot([['KC_S']])
    const resolver = buildLayoutResolver({
      snapshot,
      kleKeys: [],
      sourceLayout: QWERTY,
      targetLayout: COLEMAK,
    })
    expect(resolver.resolve(0, 0)).toEqual({
      skipped: true,
      skipReason: 'no_target_position',
    })
  })

  it('skips for unknown row/col positions', () => {
    const snapshot = makeSnapshot([['KC_A']])
    const resolver = buildLayoutResolver({
      snapshot,
      kleKeys: [],
      sourceLayout: QWERTY,
      targetLayout: COLEMAK,
    })
    expect(resolver.resolve(9, 9)).toEqual({
      skipped: true,
      skipReason: 'unmapped_keycode',
    })
  })

  it('attaches ergonomics meta when KleKeys are supplied', () => {
    // Four rows × four columns: top / home / bottom / thumb. Three
    // rows would force the bottom-most cluster to "thumb" and there
    // would be no genuine "top" row to land on.
    const kleKeys: KleKey[] = [
      emptyKleKey(0, 0, 0, 0),
      emptyKleKey(0, 1, 1, 0),
      emptyKleKey(0, 2, 2, 0),
      emptyKleKey(0, 3, 3, 0),
      emptyKleKey(1, 0, 0, 1),
      emptyKleKey(1, 1, 1, 1),
      emptyKleKey(1, 2, 2, 1),
      emptyKleKey(1, 3, 3, 1),
      emptyKleKey(2, 0, 0, 2),
      emptyKleKey(2, 1, 1, 2),
      emptyKleKey(2, 2, 2, 2),
      emptyKleKey(2, 3, 3, 2),
      emptyKleKey(3, 0, 0, 3),
      emptyKleKey(3, 1, 1, 3),
      emptyKleKey(3, 2, 2, 3),
      emptyKleKey(3, 3, 3, 3),
    ]
    const snapshot = makeSnapshot([
      ['KC_Q', 'KC_W', 'KC_E', 'KC_R'],
      ['KC_A', 'KC_S', 'KC_D', 'KC_F'],
      ['KC_Z', 'KC_X', 'KC_C', 'KC_V'],
      ['KC_NO', 'KC_NO', 'KC_SPACE', 'KC_NO'],
    ])
    const resolver = buildLayoutResolver({
      snapshot,
      kleKeys,
      sourceLayout: QWERTY,
      targetLayout: COLEMAK,
    })
    // Press QWERTY home-row F position. QWERTY "f" → Colemak "f" =
    // KC_E (Colemak F lives on KC_E). KC_E is on the top row at
    // (0, 2), so the target ergonomics row should be top.
    const result = resolver.resolve(1, 3)
    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.targetRow).toBe(0)
    expect(result.targetCol).toBe(2)
    expect(result.rowCategory).toBe('top')
    expect(result.hand).toBeDefined()
  })
})
