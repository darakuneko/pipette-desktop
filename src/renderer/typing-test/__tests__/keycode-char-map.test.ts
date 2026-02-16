// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { resolveCharFromMatrix, isShiftKeycode, extractMOLayer, extractLTLayer, extractLMLayer } from '../keycode-char-map'
import { deserialize } from '../../../shared/keycodes/keycodes'

function buildKeymap(entries: Array<[number, number, string]>): Map<string, number> {
  const m = new Map<string, number>()
  for (const [row, col, qmkId] of entries) {
    m.set(`0,${row},${col}`, deserialize(qmkId))
  }
  return m
}

describe('resolveCharFromMatrix', () => {
  it('resolves KC_A to "a"', () => {
    const keymap = buildKeymap([[0, 0, 'KC_A']])
    const result = resolveCharFromMatrix(0, 0, keymap)
    expect(result).toEqual({ kind: 'char', char: 'a' })
  })

  it('resolves KC_Z to "z"', () => {
    const keymap = buildKeymap([[1, 2, 'KC_Z']])
    const result = resolveCharFromMatrix(1, 2, keymap)
    expect(result).toEqual({ kind: 'char', char: 'z' })
  })

  it('resolves KC_1 to "1"', () => {
    const keymap = buildKeymap([[0, 1, 'KC_1']])
    const result = resolveCharFromMatrix(0, 1, keymap)
    expect(result).toEqual({ kind: 'char', char: '1' })
  })

  it('resolves KC_MINUS to "-"', () => {
    const keymap = buildKeymap([[0, 0, 'KC_MINUS']])
    const result = resolveCharFromMatrix(0, 0, keymap)
    expect(result).toEqual({ kind: 'char', char: '-' })
  })

  it('resolves KC_SPACE to space action', () => {
    const keymap = buildKeymap([[2, 0, 'KC_SPACE']])
    const result = resolveCharFromMatrix(2, 0, keymap)
    expect(result).toEqual({ kind: 'action', action: 'space' })
  })

  it('resolves KC_SPC alias to space action', () => {
    const keymap = buildKeymap([[2, 0, 'KC_SPC']])
    const result = resolveCharFromMatrix(2, 0, keymap)
    expect(result).toEqual({ kind: 'action', action: 'space' })
  })

  it('resolves KC_BSPACE to backspace action', () => {
    const keymap = buildKeymap([[0, 3, 'KC_BSPACE']])
    const result = resolveCharFromMatrix(0, 3, keymap)
    expect(result).toEqual({ kind: 'action', action: 'backspace' })
  })

  it('resolves KC_BSPC alias to backspace action', () => {
    const keymap = buildKeymap([[0, 3, 'KC_BSPC']])
    const result = resolveCharFromMatrix(0, 3, keymap)
    expect(result).toEqual({ kind: 'action', action: 'backspace' })
  })

  it('resolves KC_ENTER to space action (word submit)', () => {
    const keymap = buildKeymap([[0, 0, 'KC_ENTER']])
    const result = resolveCharFromMatrix(0, 0, keymap)
    expect(result).toEqual({ kind: 'action', action: 'space' })
  })

  it('resolves KC_ENT alias to space action', () => {
    const keymap = buildKeymap([[0, 0, 'KC_ENT']])
    const result = resolveCharFromMatrix(0, 0, keymap)
    expect(result).toEqual({ kind: 'action', action: 'space' })
  })

  it('returns null for missing keymap entries', () => {
    const keymap = new Map<string, number>()
    const result = resolveCharFromMatrix(5, 5, keymap)
    expect(result).toBeNull()
  })

  it('uses specified layer', () => {
    const keymap = new Map<string, number>()
    keymap.set('1,0,0', deserialize('KC_B'))
    const result = resolveCharFromMatrix(0, 0, keymap, 1)
    expect(result).toEqual({ kind: 'char', char: 'b' })
  })

  it('resolves LT(1, KC_SPC) to space action via inner keycode', () => {
    const keymap = buildKeymap([[0, 0, 'LT(1,KC_SPC)']])
    expect(resolveCharFromMatrix(0, 0, keymap)).toEqual({ kind: 'action', action: 'space' })
  })

  it('resolves LT(1, KC_BSPC) to backspace action via inner keycode', () => {
    const keymap = buildKeymap([[0, 0, 'LT(1,KC_BSPC)']])
    expect(resolveCharFromMatrix(0, 0, keymap)).toEqual({ kind: 'action', action: 'backspace' })
  })

  it('resolves LCTL_T(KC_A) to "a" via inner keycode', () => {
    const keymap = buildKeymap([[0, 0, 'LCTL_T(KC_A)']])
    expect(resolveCharFromMatrix(0, 0, keymap)).toEqual({ kind: 'char', char: 'a' })
  })

  it('resolves LT(2, KC_ENT) to space action via inner keycode', () => {
    const keymap = buildKeymap([[0, 0, 'LT(2,KC_ENT)']])
    expect(resolveCharFromMatrix(0, 0, keymap)).toEqual({ kind: 'action', action: 'space' })
  })

  it('returns null for TD (tap dance) — no false positive from inner byte', () => {
    const keymap = buildKeymap([[0, 0, 'TD(4)']])
    expect(resolveCharFromMatrix(0, 0, keymap)).toBeNull()
  })

  it('resolves symbols: comma, dot, slash', () => {
    const keymap = buildKeymap([
      [0, 0, 'KC_COMMA'],
      [0, 1, 'KC_DOT'],
      [0, 2, 'KC_SLASH'],
    ])
    expect(resolveCharFromMatrix(0, 0, keymap)).toEqual({ kind: 'char', char: ',' })
    expect(resolveCharFromMatrix(0, 1, keymap)).toEqual({ kind: 'char', char: '.' })
    expect(resolveCharFromMatrix(0, 2, keymap)).toEqual({ kind: 'char', char: '/' })
  })

  it('resolves KC_A to "A" when shifted', () => {
    const keymap = buildKeymap([[0, 0, 'KC_A']])
    const result = resolveCharFromMatrix(0, 0, keymap, 0, true)
    expect(result).toEqual({ kind: 'char', char: 'A' })
  })

  it('resolves KC_Z to "Z" when shifted', () => {
    const keymap = buildKeymap([[0, 0, 'KC_Z']])
    const result = resolveCharFromMatrix(0, 0, keymap, 0, true)
    expect(result).toEqual({ kind: 'char', char: 'Z' })
  })

  it('does not affect action keys when shifted', () => {
    const keymap = buildKeymap([[0, 0, 'KC_SPACE']])
    const result = resolveCharFromMatrix(0, 0, keymap, 0, true)
    expect(result).toEqual({ kind: 'action', action: 'space' })
  })

  it('shifts LT/MT inner keycodes', () => {
    const keymap = buildKeymap([[0, 0, 'LCTL_T(KC_A)']])
    const result = resolveCharFromMatrix(0, 0, keymap, 0, true)
    expect(result).toEqual({ kind: 'char', char: 'A' })
  })

  it('resolves KC_1 to "!" when shifted', () => {
    const keymap = buildKeymap([[0, 0, 'KC_1']])
    expect(resolveCharFromMatrix(0, 0, keymap, 0, true)).toEqual({ kind: 'char', char: '!' })
  })

  it('resolves KC_SLASH to "?" when shifted', () => {
    const keymap = buildKeymap([[0, 0, 'KC_SLASH']])
    expect(resolveCharFromMatrix(0, 0, keymap, 0, true)).toEqual({ kind: 'char', char: '?' })
  })

  it('resolves KC_QUOTE to double quote when shifted', () => {
    const keymap = buildKeymap([[0, 0, 'KC_QUOTE']])
    expect(resolveCharFromMatrix(0, 0, keymap, 0, true)).toEqual({ kind: 'char', char: '"' })
  })

  it('resolves KC_SCOLON to ":" when shifted', () => {
    const keymap = buildKeymap([[0, 0, 'KC_SCOLON']])
    expect(resolveCharFromMatrix(0, 0, keymap, 0, true)).toEqual({ kind: 'char', char: ':' })
  })

  it('resolves KC_9 to "(" when shifted', () => {
    const keymap = buildKeymap([[0, 0, 'KC_9']])
    expect(resolveCharFromMatrix(0, 0, keymap, 0, true)).toEqual({ kind: 'char', char: '(' })
  })

  it('resolves KC_0 to ")" when shifted', () => {
    const keymap = buildKeymap([[0, 0, 'KC_0']])
    expect(resolveCharFromMatrix(0, 0, keymap, 0, true)).toEqual({ kind: 'char', char: ')' })
  })
})

describe('isShiftKeycode', () => {
  it('identifies KC_LSHIFT', () => {
    expect(isShiftKeycode(deserialize('KC_LSHIFT'))).toBe(true)
  })

  it('identifies KC_RSHIFT', () => {
    expect(isShiftKeycode(deserialize('KC_RSHIFT'))).toBe(true)
  })

  it('rejects KC_A', () => {
    expect(isShiftKeycode(deserialize('KC_A'))).toBe(false)
  })

  it('rejects KC_LCTRL', () => {
    expect(isShiftKeycode(deserialize('KC_LCTRL'))).toBe(false)
  })
})

describe('extractMOLayer', () => {
  it('extracts layer from MO(1)', () => {
    expect(extractMOLayer(deserialize('MO(1)'))).toBe(1)
  })

  it('extracts layer from MO(0)', () => {
    expect(extractMOLayer(deserialize('MO(0)'))).toBe(0)
  })

  it('extracts layer from MO(3)', () => {
    expect(extractMOLayer(deserialize('MO(3)'))).toBe(3)
  })

  it('returns null for KC_A', () => {
    expect(extractMOLayer(deserialize('KC_A'))).toBeNull()
  })

  it('returns null for LT(1,KC_A)', () => {
    expect(extractMOLayer(deserialize('LT(1,KC_A)'))).toBeNull()
  })

  it('returns null for KC_LSHIFT', () => {
    expect(extractMOLayer(deserialize('KC_LSHIFT'))).toBeNull()
  })

  it('extracts layer from v6 MO hex value (0x5221 = MO(1) v6)', () => {
    expect(extractMOLayer(0x5221)).toBe(1)
  })

  it('extracts layer from v5 MO hex value (0x5101 = MO(1) v5)', () => {
    expect(extractMOLayer(0x5101)).toBe(1)
  })

  it('extracts layer 15 from v6 MO hex value (0x522f)', () => {
    expect(extractMOLayer(0x522f)).toBe(15)
  })
})

describe('extractLTLayer', () => {
  it('extracts layer from LT(1,KC_A)', () => {
    expect(extractLTLayer(deserialize('LT(1,KC_A)'))).toBe(1)
  })

  it('extracts layer from LT(2,KC_SPC)', () => {
    expect(extractLTLayer(deserialize('LT(2,KC_SPC)'))).toBe(2)
  })

  it('extracts layer from LT(0,KC_ENT)', () => {
    expect(extractLTLayer(deserialize('LT(0,KC_ENT)'))).toBe(0)
  })

  it('returns null for MO(1)', () => {
    expect(extractLTLayer(deserialize('MO(1)'))).toBeNull()
  })

  it('returns null for KC_A', () => {
    expect(extractLTLayer(deserialize('KC_A'))).toBeNull()
  })

  it('returns null for LCTL_T(KC_A) — mod tap is not LT', () => {
    expect(extractLTLayer(deserialize('LCTL_T(KC_A)'))).toBeNull()
  })
})

describe('extractLMLayer', () => {
  it('extracts layer from LM(1, MOD_LCTL)', () => {
    expect(extractLMLayer(deserialize('LM(1, MOD_LCTL)'))).toBe(1)
  })

  it('extracts layer from LM(0, MOD_LSFT)', () => {
    expect(extractLMLayer(deserialize('LM(0, MOD_LSFT)'))).toBe(0)
  })

  it('extracts layer from LM(3, MOD_RALT)', () => {
    expect(extractLMLayer(deserialize('LM(3, MOD_RALT)'))).toBe(3)
  })

  it('returns null for MO(1)', () => {
    expect(extractLMLayer(deserialize('MO(1)'))).toBeNull()
  })

  it('returns null for KC_A', () => {
    expect(extractLMLayer(deserialize('KC_A'))).toBeNull()
  })

  it('returns null for LT(1,KC_A)', () => {
    expect(extractLMLayer(deserialize('LT(1,KC_A)'))).toBeNull()
  })
})
