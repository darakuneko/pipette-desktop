// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { generateKeymapC, type KeymapExportInput } from '../keymap-export'

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
  // 2x3 matrix: row0=(0,0)(0,1)(0,2), row1=(1,0)(1,1)(1,2)
  const keymap = new Map<string, number>([
    ['0,0,0', 0x29], ['0,0,1', 0x04], ['0,0,2', 0x05],
    ['0,1,0', 0x2B], ['0,1,1', 0x06], ['0,1,2', 0x07],
  ])

  return {
    layers: 1,
    matrixRows: 2,
    matrixCols: 3,
    keymap,
    encoderLayout: new Map(),
    encoderCount: 0,
    serializeKeycode: mockSerialize,
    ...overrides,
  }
}

describe('generateKeymapC', () => {
  it('generates basic single-layer output', () => {
    const result = generateKeymapC(createBasicInput())

    expect(result).toContain('#include QMK_KEYBOARD_H')
    expect(result).toContain('PROGMEM')
    expect(result).toContain('[0] = {')
    expect(result).toContain('{ KC_ESC, KC_A, KC_B }')
    expect(result).toContain('{ KC_TAB, KC_C, KC_D }')
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

    expect(result).toContain('[0] = {')
    expect(result).toContain('[1] = {')
    expect(result).toContain('{ KC_GRV, KC_1, KC_2 }')
    expect(result).toContain('{ KC_TRNS, KC_E, KC_F }')
  })

  it('emits a full grid in row-then-col order using designated initializers', () => {
    const result = generateKeymapC(createBasicInput())

    expect(result).toContain(
      '[0] = {\n        { KC_ESC, KC_A, KC_B },\n        { KC_TAB, KC_C, KC_D }\n    }',
    )
  })

  it('defaults missing Map entries to KC_NO at their coordinates', () => {
    const keymap = new Map<string, number>([
      ['0,0,0', 0x29], ['0,0,1', 0x04],
      // 0,0,2 intentionally missing
      ['0,1,0', 0x2B], ['0,1,1', 0x06], ['0,1,2', 0x07],
    ])

    const result = generateKeymapC(createBasicInput({ keymap }))

    expect(result).toContain('{ KC_ESC, KC_A, KC_NO }')
  })

  it('emits a full KC_NO grid for a layer whose entries are all missing', () => {
    const result = generateKeymapC(createBasicInput({ layers: 2, keymap: new Map() }))

    expect(result).toContain('[0] = {')
    expect(result).toContain('[1] = {')
    expect(result).toContain('{ KC_NO, KC_NO, KC_NO }')
  })

  it('throws when matrix dimensions are unavailable or invalid', () => {
    expect(() => generateKeymapC(createBasicInput({ matrixRows: 0 }))).toThrow()
    expect(() => generateKeymapC(createBasicInput({ matrixCols: 0 }))).toThrow()
    expect(() => generateKeymapC(createBasicInput({ matrixRows: Number.NaN }))).toThrow()
    expect(() => generateKeymapC(createBasicInput({ matrixCols: 1.5 }))).toThrow()
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

  it('ends output with newline', () => {
    const result = generateKeymapC(createBasicInput())
    expect(result.endsWith('\n')).toBe(true)
  })

  it('generates enum for custom keycodes when provided', () => {
    const result = generateKeymapC(createBasicInput({
      customKeycodes: [
        { name: 'CUSTOM_1', title: 'Custom One', shortName: 'C1' },
        { name: 'CUSTOM_2', title: 'Custom Two', shortName: 'C2' },
      ],
    }))

    expect(result).toContain('enum custom_keycodes {')
    expect(result).toContain('CUSTOM_1 = QK_KB_0,')
    expect(result).toContain('CUSTOM_2,')
    expect(result).toContain('};')
    // Enum should appear between #include and keymaps array
    const includeIdx = result.indexOf('#include QMK_KEYBOARD_H')
    const enumIdx = result.indexOf('enum custom_keycodes')
    const keymapsIdx = result.indexOf('const uint16_t PROGMEM keymaps')
    expect(enumIdx).toBeGreaterThan(includeIdx)
    expect(enumIdx).toBeLessThan(keymapsIdx)
  })

  it('does not generate enum when customKeycodes is undefined', () => {
    const result = generateKeymapC(createBasicInput())

    expect(result).not.toContain('enum custom_keycodes')
  })

  it('does not generate enum when customKeycodes is empty', () => {
    const result = generateKeymapC(createBasicInput({ customKeycodes: [] }))

    expect(result).not.toContain('enum custom_keycodes')
  })

  it('handles custom keycodes with missing name field', () => {
    const result = generateKeymapC(createBasicInput({
      customKeycodes: [
        { title: 'No Name', shortName: 'NN' },
        { name: 'HAS_NAME', title: 'Has Name', shortName: 'HN' },
      ],
    }))

    // Entry without name should use USER00 fallback
    expect(result).toContain('USER00 = QK_KB_0,')
    expect(result).toContain('HAS_NAME,')
  })
})
