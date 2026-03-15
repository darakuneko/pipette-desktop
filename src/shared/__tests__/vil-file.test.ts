// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  isVilFile,
  isVilFileV1,
  migrateVilFileToV2,
  isRecord,
  isKeyboardDefinition,
  VILFILE_CURRENT_VERSION,
  mapToRecord,
  recordToMap,
  deriveLayerCount,
} from '../vil-file'
import type { VilFile, KeyboardDefinition } from '../types/protocol'

const validDefinition: KeyboardDefinition = {
  name: 'TestKB',
  matrix: { rows: 2, cols: 3 },
  layouts: { keymap: [[{ x: 0, y: 0 }, 'KC_A']] },
}

const validVilV1 = {
  uid: '0x1234',
  keymap: { '0,0,0': 4 },
  encoderLayout: { '0,0,0': 5 },
  macros: [0, 1, 2],
  layoutOptions: 0,
  tapDance: [{ onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 }],
  combo: [{ key1: 0, key2: 0, key3: 0, key4: 0, output: 0 }],
  keyOverride: [],
  altRepeatKey: [],
  qmkSettings: { '1': [0, 1] },
}

const validVilV2 = {
  ...validVilV1,
  version: 2,
  definition: validDefinition,
}

describe('isVilFile', () => {
  it('returns true for valid v1 VilFile (no version field)', () => {
    expect(isVilFile(validVilV1)).toBe(true)
  })

  it('returns true for valid v2 VilFile (version: 2 + definition)', () => {
    expect(isVilFile(validVilV2)).toBe(true)
  })

  it('returns false for null', () => {
    expect(isVilFile(null)).toBe(false)
  })

  it('returns false for non-object', () => {
    expect(isVilFile('string')).toBe(false)
    expect(isVilFile(42)).toBe(false)
  })

  it('returns false when uid is missing', () => {
    const { uid: _uid, ...rest } = validVilV1
    expect(isVilFile(rest)).toBe(false)
  })

  it('returns false when keymap is not an object', () => {
    expect(isVilFile({ ...validVilV1, keymap: 'bad' })).toBe(false)
  })

  it('returns false when macros is not an array', () => {
    expect(isVilFile({ ...validVilV1, macros: 'bad' })).toBe(false)
  })

  it('returns false when layoutOptions is not a number', () => {
    expect(isVilFile({ ...validVilV1, layoutOptions: 'bad' })).toBe(false)
  })

  it('returns false when tapDance is not an array', () => {
    expect(isVilFile({ ...validVilV1, tapDance: {} })).toBe(false)
  })

  it('returns false when qmkSettings is null', () => {
    expect(isVilFile({ ...validVilV1, qmkSettings: null })).toBe(false)
  })

  it('returns false when encoderLayout is missing', () => {
    const { encoderLayout: _enc, ...rest } = validVilV1
    expect(isVilFile(rest)).toBe(false)
  })

  it('returns false when combo is not an array', () => {
    expect(isVilFile({ ...validVilV1, combo: 'bad' })).toBe(false)
  })

  it('returns false when keyOverride is not an array', () => {
    expect(isVilFile({ ...validVilV1, keyOverride: 'bad' })).toBe(false)
  })

  it('returns false when altRepeatKey is not an array', () => {
    expect(isVilFile({ ...validVilV1, altRepeatKey: {} })).toBe(false)
  })

  it('returns true when extra unknown fields are present (v1)', () => {
    const extended = { ...validVilV1, customField: 'hello' }
    expect(isVilFile(extended)).toBe(true)
  })

  it('returns true when layerNames is present', () => {
    const withNames = { ...validVilV1, layerNames: ['Base', 'Nav', ''] }
    expect(isVilFile(withNames)).toBe(true)
  })

  it('returns true when layerNames is absent (backward compat)', () => {
    expect(isVilFile(validVilV1)).toBe(true)
    expect((validVilV1 as Record<string, unknown>).layerNames).toBeUndefined()
  })

  it('returns false when layerNames is not an array', () => {
    expect(isVilFile({ ...validVilV1, layerNames: 'bad' })).toBe(false)
  })

  it('returns false when layerNames contains non-strings', () => {
    expect(isVilFile({ ...validVilV1, layerNames: [123, null] })).toBe(false)
  })

  it('returns false when macroJson is a truthy non-array value', () => {
    expect(isVilFile({ ...validVilV1, macroJson: 'bad' })).toBe(false)
    expect(isVilFile({ ...validVilV1, macroJson: 42 })).toBe(false)
    expect(isVilFile({ ...validVilV1, macroJson: {} })).toBe(false)
  })

  it('returns true when macroJson is undefined, null, or an array', () => {
    expect(isVilFile({ ...validVilV1 })).toBe(true) // undefined
    expect(isVilFile({ ...validVilV1, macroJson: null })).toBe(true)
    expect(isVilFile({ ...validVilV1, macroJson: [['text', 'hi']] })).toBe(true)
  })

  it('returns false for Python vial-gui format (layout array, numeric uid)', () => {
    const pythonFormat = {
      version: 1,
      uid: 18147293849398344426,
      layout: [
        [['KC_RIGHT', 'KC_UP'], ['KC_MPLY']],
      ],
      encoder_layout: [[['KC_VOLD', 'KC_VOLU']]],
      layout_options: 0,
      macro: [[]],
      tap_dance: [['KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 150]],
      combo: [['KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO']],
      key_override: [],
      settings: { '1': 0 },
    }
    expect(isVilFile(pythonFormat)).toBe(false)
  })

  // --- Version-specific tests ---

  it('returns false when version is 2 but definition is missing', () => {
    expect(isVilFile({ ...validVilV1, version: 2 })).toBe(false)
  })

  it('returns false when version is 2 but definition is invalid', () => {
    expect(isVilFile({ ...validVilV1, version: 2, definition: 'bad' })).toBe(false)
    expect(isVilFile({ ...validVilV1, version: 2, definition: {} })).toBe(false)
    expect(isVilFile({ ...validVilV1, version: 2, definition: { matrix: {} } })).toBe(false)
  })

  it('returns false when version is negative', () => {
    expect(isVilFile({ ...validVilV1, version: -1 })).toBe(false)
  })

  it('returns false when version is not an integer', () => {
    expect(isVilFile({ ...validVilV1, version: 1.5 })).toBe(false)
  })

  it('returns false when version is zero', () => {
    expect(isVilFile({ ...validVilV1, version: 0 })).toBe(false)
  })

  it('accepts version: 1 without definition (explicit v1)', () => {
    expect(isVilFile({ ...validVilV1, version: 1 })).toBe(true)
  })

  it('accepts future version (> 2) gracefully', () => {
    // Future versions without definition are accepted (unknown future format)
    expect(isVilFile({ ...validVilV1, version: 3 })).toBe(true)
  })

  it('returns false when definition is present but invalid (any version)', () => {
    expect(isVilFile({ ...validVilV1, definition: 'not-an-object' })).toBe(false)
  })

  it('accepts v1 with a valid definition present', () => {
    // v1 files that happen to have a definition (e.g. partially migrated) are still valid
    expect(isVilFile({ ...validVilV1, definition: validDefinition })).toBe(true)
  })
})

describe('isRecord', () => {
  it('returns true for plain objects', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
  })

  it('returns false for non-objects', () => {
    expect(isRecord(null)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
    expect(isRecord(42)).toBe(false)
    expect(isRecord('string')).toBe(false)
    expect(isRecord([1, 2])).toBe(false)
  })
})

describe('isKeyboardDefinition', () => {
  it('returns true for valid definition', () => {
    expect(isKeyboardDefinition(validDefinition)).toBe(true)
  })

  it('returns true for minimal definition (no name)', () => {
    expect(isKeyboardDefinition({
      matrix: { rows: 1, cols: 1 },
      layouts: { keymap: [] },
    })).toBe(true)
  })

  it('returns true with dynamic_keymap.layer_count', () => {
    expect(isKeyboardDefinition({
      ...validDefinition,
      dynamic_keymap: { layer_count: 8 },
    })).toBe(true)
  })

  it('returns false for null', () => {
    expect(isKeyboardDefinition(null)).toBe(false)
  })

  it('returns false without matrix', () => {
    expect(isKeyboardDefinition({ layouts: { keymap: [] } })).toBe(false)
  })

  it('returns false without layouts', () => {
    expect(isKeyboardDefinition({ matrix: { rows: 1, cols: 1 } })).toBe(false)
  })

  it('returns false when matrix.rows is missing', () => {
    expect(isKeyboardDefinition({
      matrix: { cols: 1 },
      layouts: { keymap: [] },
    })).toBe(false)
  })

  it('returns false when layouts.keymap is not an array', () => {
    expect(isKeyboardDefinition({
      matrix: { rows: 1, cols: 1 },
      layouts: { keymap: 'bad' },
    })).toBe(false)
  })

  it('returns false when dynamic_keymap.layer_count is out of range', () => {
    expect(isKeyboardDefinition({
      ...validDefinition,
      dynamic_keymap: { layer_count: 0 },
    })).toBe(false)
    expect(isKeyboardDefinition({
      ...validDefinition,
      dynamic_keymap: { layer_count: 33 },
    })).toBe(false)
  })

  it('returns false when dynamic_keymap is not an object', () => {
    expect(isKeyboardDefinition({
      ...validDefinition,
      dynamic_keymap: 'bad',
    })).toBe(false)
  })
})

describe('isVilFileV1', () => {
  it('returns true for files without version', () => {
    expect(isVilFileV1(validVilV1 as VilFile)).toBe(true)
  })

  it('returns true for files with version: 1', () => {
    expect(isVilFileV1({ ...validVilV1, version: 1 } as VilFile)).toBe(true)
  })

  it('returns false for files with version: 2', () => {
    expect(isVilFileV1(validVilV2 as VilFile)).toBe(false)
  })
})

describe('migrateVilFileToV2', () => {
  it('adds version and definition to a v1 file', () => {
    const migrated = migrateVilFileToV2(validVilV1 as VilFile, validDefinition)
    expect(migrated.version).toBe(VILFILE_CURRENT_VERSION)
    expect(migrated.definition).toEqual(validDefinition)
    // Original data preserved
    expect(migrated.uid).toBe(validVilV1.uid)
    expect(migrated.keymap).toEqual(validVilV1.keymap)
  })

  it('does not mutate the original object', () => {
    const original = { ...validVilV1 } as VilFile
    const migrated = migrateVilFileToV2(original, validDefinition)
    expect(original).not.toHaveProperty('version')
    expect(original).not.toHaveProperty('definition')
    expect(migrated).not.toBe(original)
  })
})

describe('mapToRecord', () => {
  it('converts Map to Record', () => {
    const map = new Map([
      ['0,0,0', 4],
      ['0,0,1', 5],
    ])
    expect(mapToRecord(map)).toEqual({ '0,0,0': 4, '0,0,1': 5 })
  })

  it('handles empty Map', () => {
    expect(mapToRecord(new Map())).toEqual({})
  })
})

describe('recordToMap', () => {
  it('converts Record to Map', () => {
    const record = { '0,0,0': 4, '0,0,1': 5 }
    const map = recordToMap(record)
    expect(map.get('0,0,0')).toBe(4)
    expect(map.get('0,0,1')).toBe(5)
    expect(map.size).toBe(2)
  })

  it('handles empty Record', () => {
    expect(recordToMap({}).size).toBe(0)
  })
})

describe('deriveLayerCount', () => {
  it('returns correct layer count from keymap keys', () => {
    const keymap = {
      '0,0,0': 4,
      '0,0,1': 5,
      '1,0,0': 6,
      '1,0,1': 7,
      '2,0,0': 8,
    }
    expect(deriveLayerCount(keymap)).toBe(3)
  })

  it('returns 1 for empty keymap', () => {
    expect(deriveLayerCount({})).toBe(1)
  })

  it('returns 1 for single-layer keymap', () => {
    const keymap = { '0,0,0': 4, '0,1,0': 5 }
    expect(deriveLayerCount(keymap)).toBe(1)
  })
})
