// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { generateKeymapC, type KeymapExportInput } from '../keymap-export'
import type { KleKey } from '../kle/types'

function makeKey(overrides: Partial<KleKey> = {}): KleKey {
  return {
    x: 0, y: 0,
    width: 1, height: 1,
    x2: 0, y2: 0,
    width2: 1, height2: 1,
    rotation: 0, rotationX: 0, rotationY: 0,
    color: '#cccccc',
    labels: Array(12).fill(null),
    textColor: Array(12).fill(null),
    textSize: Array(12).fill(null),
    row: 0, col: 0,
    encoderIdx: -1, encoderDir: -1,
    layoutIndex: -1, layoutOption: -1,
    decal: false, nub: false, stepped: false, ghost: false,
    ...overrides,
  }
}

function mockSerialize(code: number): string {
  const names: Record<number, string> = {
    0x00: 'KC_NO',
    0x01: 'KC_TRNS',
    0x04: 'KC_A',
    0x05: 'KC_B',
    0x06: 'KC_C',
    0x07: 'KC_D',
    0x08: 'KC_E',
    0x09: 'KC_F',
    0x29: 'KC_ESC',
    0x2B: 'KC_TAB',
    0x1E: 'KC_1',
    0x1F: 'KC_2',
    0x35: 'KC_GRV',
    0x80: 'KC_VOLD',
    0x81: 'KC_VOLU',
  }
  return names[code] ?? `0x${code.toString(16).toUpperCase().padStart(4, '0')}`
}

function createBasicInput(overrides: Partial<KeymapExportInput> = {}): KeymapExportInput {
  // 2x3 grid: row0=(0,0)(0,1)(0,2), row1=(1,0)(1,1)(1,2)
  const keys: KleKey[] = [
    makeKey({ x: 0, y: 0, row: 0, col: 0 }),
    makeKey({ x: 1, y: 0, row: 0, col: 1 }),
    makeKey({ x: 2, y: 0, row: 0, col: 2 }),
    makeKey({ x: 0, y: 1, row: 1, col: 0 }),
    makeKey({ x: 1, y: 1, row: 1, col: 1 }),
    makeKey({ x: 2, y: 1, row: 1, col: 2 }),
  ]

  const keymap = new Map<string, number>([
    ['0,0,0', 0x29], ['0,0,1', 0x04], ['0,0,2', 0x05],
    ['0,1,0', 0x2B], ['0,1,1', 0x06], ['0,1,2', 0x07],
  ])

  return {
    layers: 1,
    keys,
    keymap,
    encoderLayout: new Map(),
    encoderCount: 0,
    layoutOptions: new Map(),
    serializeKeycode: mockSerialize,
    ...overrides,
  }
}

describe('generateKeymapC', () => {
  it('generates basic single-layer output', () => {
    const result = generateKeymapC(createBasicInput())

    expect(result).toContain('#include QMK_KEYBOARD_H')
    expect(result).toContain('PROGMEM')
    expect(result).toContain('[0] = LAYOUT(')
    expect(result).toContain('KC_ESC, KC_A, KC_B')
    expect(result).toContain('KC_TAB, KC_C, KC_D')
  })

  it('generates header with SPDX and include', () => {
    const result = generateKeymapC(createBasicInput())

    expect(result).toMatch(/^\/\* SPDX-License-Identifier: GPL-2\.0-or-later \*\//)
    expect(result).toContain('#include QMK_KEYBOARD_H')
    expect(result).toContain('const uint16_t PROGMEM keymaps[][MATRIX_ROWS][MATRIX_COLS]')
  })

  it('generates multiple layers with correct indices', () => {
    const keymap = new Map<string, number>([
      ['0,0,0', 0x29], ['0,0,1', 0x04], ['0,0,2', 0x05],
      ['0,1,0', 0x2B], ['0,1,1', 0x06], ['0,1,2', 0x07],
      ['1,0,0', 0x35], ['1,0,1', 0x1E], ['1,0,2', 0x1F],
      ['1,1,0', 0x01], ['1,1,1', 0x08], ['1,1,2', 0x09],
    ])

    const result = generateKeymapC(createBasicInput({ layers: 2, keymap }))

    expect(result).toContain('[0] = LAYOUT(')
    expect(result).toContain('[1] = LAYOUT(')
    expect(result).toContain('KC_GRV, KC_1, KC_2')
    expect(result).toContain('KC_TRNS, KC_E, KC_F')
  })

  it('filters keys by layout options', () => {
    const keys: KleKey[] = [
      makeKey({ x: 0, y: 0, row: 0, col: 0 }),
      makeKey({ x: 1, y: 0, row: 0, col: 1, layoutIndex: 0, layoutOption: 0 }),
      makeKey({ x: 1, y: 0, row: 0, col: 2, layoutIndex: 0, layoutOption: 1 }),
    ]

    const keymap = new Map<string, number>([
      ['0,0,0', 0x29],
      ['0,0,1', 0x04],
      ['0,0,2', 0x05],
    ])

    // Select layoutOption 1 for layoutIndex 0
    const layoutOptions = new Map<number, number>([[0, 1]])

    const result = generateKeymapC(createBasicInput({ keys, keymap, layoutOptions }))

    // col 2 (option 1) should be included, col 1 (option 0) should not
    expect(result).toContain('KC_ESC, KC_B')
    expect(result).not.toContain('KC_A')
  })

  it('excludes decal keys', () => {
    const keys: KleKey[] = [
      makeKey({ x: 0, y: 0, row: 0, col: 0 }),
      makeKey({ x: 1, y: 0, row: 0, col: 1, decal: true }),
      makeKey({ x: 2, y: 0, row: 0, col: 2 }),
    ]

    const keymap = new Map<string, number>([
      ['0,0,0', 0x29],
      ['0,0,1', 0x04],
      ['0,0,2', 0x05],
    ])

    const result = generateKeymapC(createBasicInput({ keys, keymap }))

    expect(result).toContain('KC_ESC, KC_B')
    expect(result).not.toContain('KC_A')
  })

  it('generates encoder_map when encoders exist', () => {
    // encoderLayout: dir 0=CW, dir 1=CCW (matching useKeyboard convention)
    const encoderLayout = new Map<string, number>([
      ['0,0,0', 0x81], // CW = KC_VOLU
      ['0,0,1', 0x80], // CCW = KC_VOLD
    ])

    const result = generateKeymapC(createBasicInput({
      encoderCount: 1,
      encoderLayout,
    }))

    expect(result).toContain('encoder_map')
    // ENCODER_CCW_CW takes CCW first, then CW
    expect(result).toContain('ENCODER_CCW_CW(KC_VOLD, KC_VOLU)')
    expect(result).toContain('NUM_ENCODERS')
    expect(result).toContain('NUM_DIRECTIONS')
  })

  it('does not include encoder_map section when no encoders', () => {
    const result = generateKeymapC(createBasicInput({ encoderCount: 0 }))

    expect(result).not.toContain('encoder_map')
    expect(result).not.toContain('ENCODER_CCW_CW')
  })

  it('generates encoder_map for multiple layers', () => {
    // dir 0=CW, dir 1=CCW
    const encoderLayout = new Map<string, number>([
      ['0,0,0', 0x81], ['0,0,1', 0x80], // L0: CW=VOLU, CCW=VOLD
      ['1,0,0', 0x01], ['1,0,1', 0x01], // L1: CW=TRNS, CCW=TRNS
    ])

    const keymap = new Map<string, number>([
      ['0,0,0', 0x29], ['0,0,1', 0x04], ['0,0,2', 0x05],
      ['0,1,0', 0x2B], ['0,1,1', 0x06], ['0,1,2', 0x07],
      ['1,0,0', 0x35], ['1,0,1', 0x1E], ['1,0,2', 0x1F],
      ['1,1,0', 0x01], ['1,1,1', 0x08], ['1,1,2', 0x09],
    ])

    const result = generateKeymapC(createBasicInput({
      layers: 2,
      keymap,
      encoderCount: 1,
      encoderLayout,
    }))

    expect(result).toContain('[0] = { ENCODER_CCW_CW(KC_VOLD, KC_VOLU) }')
    expect(result).toContain('[1] = { ENCODER_CCW_CW(KC_TRNS, KC_TRNS) }')
  })

  it('groups keys by y coordinate (visual rows)', () => {
    // Keys on same visual row (y difference <= 0.3)
    const keys: KleKey[] = [
      makeKey({ x: 0, y: 0, row: 0, col: 0 }),
      makeKey({ x: 1, y: 0.1, row: 0, col: 1 }), // close y => same row
      makeKey({ x: 0, y: 1.5, row: 1, col: 0 }),   // far y => new row
    ]

    const keymap = new Map<string, number>([
      ['0,0,0', 0x29],
      ['0,0,1', 0x04],
      ['0,1,0', 0x05],
    ])

    const result = generateKeymapC(createBasicInput({ keys, keymap }))

    // Row 1: ESC, A (same visual row)
    // Row 2: B (new visual row)
    const lines = result.split('\n')
    const layoutLine1 = lines.find(l => l.includes('KC_ESC'))!
    expect(layoutLine1).toContain('KC_A')
    const layoutLine2 = lines.find(l => l.includes('KC_B') && !l.includes('KC_ESC'))!
    expect(layoutLine2).toBeDefined()
  })

  it('separates normal keys from encoder keys', () => {
    const keys: KleKey[] = [
      makeKey({ x: 0, y: 0, row: 0, col: 0 }),
      makeKey({ x: 1, y: 0, row: 0, col: 1 }),
      makeKey({ x: 2, y: 0, row: 0, col: 2, encoderIdx: 0, encoderDir: 0 }),
      makeKey({ x: 3, y: 0, row: 0, col: 3, encoderIdx: 0, encoderDir: 1 }),
    ]

    const keymap = new Map<string, number>([
      ['0,0,0', 0x29],
      ['0,0,1', 0x04],
      ['0,0,2', 0x80],
      ['0,0,3', 0x81],
    ])

    const result = generateKeymapC(createBasicInput({ keys, keymap }))

    // LAYOUT should only contain normal keys
    const layoutSection = result.split('};')[0]
    expect(layoutSection).toContain('KC_ESC, KC_A')
    // Encoder keys should not appear in LAYOUT
    expect(layoutSection).not.toContain('KC_VOLD')
  })

  it('defaults keycode to 0 (KC_NO) for missing keys', () => {
    const keys: KleKey[] = [
      makeKey({ x: 0, y: 0, row: 0, col: 0 }),
    ]

    const result = generateKeymapC(createBasicInput({
      keys,
      keymap: new Map(), // empty keymap
    }))

    expect(result).toContain('KC_NO')
  })

  it('includes all keys when layoutOptions is empty (matches KeyboardWidget)', () => {
    const keys: KleKey[] = [
      makeKey({ x: 0, y: 0, row: 0, col: 0 }),
      makeKey({ x: 1, y: 0, row: 0, col: 1, layoutIndex: 0, layoutOption: 0 }),
      makeKey({ x: 2, y: 0, row: 0, col: 2, layoutIndex: 0, layoutOption: 1 }),
    ]

    const keymap = new Map<string, number>([
      ['0,0,0', 0x29],
      ['0,0,1', 0x04],
      ['0,0,2', 0x05],
    ])

    // Empty layoutOptions → include all keys regardless of layoutOption
    const result = generateKeymapC(createBasicInput({ keys, keymap, layoutOptions: new Map() }))

    expect(result).toContain('KC_ESC, KC_A, KC_B')
  })

  it('does not chain-merge rows with gradual y offsets', () => {
    // Keys at y=0.0, 0.2, 0.4 — should split into rows based on distance from row start
    const keys: KleKey[] = [
      makeKey({ x: 0, y: 0.0, row: 0, col: 0 }),
      makeKey({ x: 1, y: 0.2, row: 0, col: 1 }),
      makeKey({ x: 2, y: 0.4, row: 0, col: 2 }), // > 0.3 from row start (0.0)
    ]

    const keymap = new Map<string, number>([
      ['0,0,0', 0x29],
      ['0,0,1', 0x04],
      ['0,0,2', 0x05],
    ])

    const result = generateKeymapC(createBasicInput({ keys, keymap }))

    // First two keys in same row, third in new row
    const lines = result.split('\n')
    const escLine = lines.find(l => l.includes('KC_ESC'))!
    expect(escLine).toContain('KC_A')
    expect(escLine).not.toContain('KC_B')
  })

  it('handles empty keys array', () => {
    const result = generateKeymapC(createBasicInput({ keys: [], keymap: new Map() }))

    expect(result).toContain('LAYOUT(')
    expect(result).toContain('#include QMK_KEYBOARD_H')
  })

  it('ends output with newline', () => {
    const result = generateKeymapC(createBasicInput())
    expect(result.endsWith('\n')).toBe(true)
  })
})
