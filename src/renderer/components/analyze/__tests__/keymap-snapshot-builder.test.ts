// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest'
import { emptyState } from '../../../hooks/keyboard-types'
import type { KeyboardState } from '../../../hooks/keyboard-types'
import { buildKeymapSnapshot } from '../keymap-snapshot-builder'

function makeState(overrides: Partial<KeyboardState>): KeyboardState {
  return { ...emptyState(), ...overrides }
}

describe('buildKeymapSnapshot', () => {
  it('returns null for the empty-UID placeholder', () => {
    expect(buildKeymapSnapshot(makeState({}))).toBeNull()
  })

  it('returns null when layout is missing', () => {
    const kb = makeState({ uid: '0xAABB', layers: 1, rows: 1, cols: 1 })
    expect(buildKeymapSnapshot(kb)).toBeNull()
  })

  it('packs the keymap Map into layer/row/col arrays of QMK ids', () => {
    // KC_A=0x04, KC_B=0x05, KC_ESC=0x29
    const keymap = new Map<string, number>([
      ['0,0,0', 0x04],
      ['0,0,1', 0x05],
      ['0,1,0', 0x29],
      ['1,0,0', 0x04],
    ])
    const kb = makeState({
      uid: '0xAABB',
      layers: 2,
      rows: 2,
      cols: 2,
      layout: { rows: 2, cols: 2 } as unknown as KeyboardState['layout'],
      keymap,
    })
    const out = buildKeymapSnapshot(kb, 1_000)
    expect(out).not.toBeNull()
    expect(out?.savedAt).toBe(1_000)
    expect(out?.layers).toBe(2)
    expect(out?.matrix).toEqual({ rows: 2, cols: 2 })
    // The serializer turns each number into its QMK id; KC_NO ("0")
    // is the zero fallback for cells the keymap didn't touch.
    expect(out?.keymap[0][0][0]).toBe('KC_A')
    expect(out?.keymap[0][0][1]).toBe('KC_B')
    expect(out?.keymap[0][1][0]).toBe('KC_ESCAPE')
    expect(out?.keymap[1][0][0]).toBe('KC_A')
    expect(out?.keymap[1][1][1]).toBe('KC_NO')
  })
})
