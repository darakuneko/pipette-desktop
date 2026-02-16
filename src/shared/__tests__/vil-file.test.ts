// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { isVilFile, mapToRecord, recordToMap, deriveLayerCount } from '../vil-file'

const validVil = {
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

describe('isVilFile', () => {
  it('returns true for valid VilFile', () => {
    expect(isVilFile(validVil)).toBe(true)
  })

  it('returns false for null', () => {
    expect(isVilFile(null)).toBe(false)
  })

  it('returns false for non-object', () => {
    expect(isVilFile('string')).toBe(false)
    expect(isVilFile(42)).toBe(false)
  })

  it('returns false when uid is missing', () => {
    const { uid: _uid, ...rest } = validVil
    expect(isVilFile(rest)).toBe(false)
  })

  it('returns false when keymap is not an object', () => {
    expect(isVilFile({ ...validVil, keymap: 'bad' })).toBe(false)
  })

  it('returns false when macros is not an array', () => {
    expect(isVilFile({ ...validVil, macros: 'bad' })).toBe(false)
  })

  it('returns false when layoutOptions is not a number', () => {
    expect(isVilFile({ ...validVil, layoutOptions: 'bad' })).toBe(false)
  })

  it('returns false when tapDance is not an array', () => {
    expect(isVilFile({ ...validVil, tapDance: {} })).toBe(false)
  })

  it('returns false when qmkSettings is null', () => {
    expect(isVilFile({ ...validVil, qmkSettings: null })).toBe(false)
  })

  it('returns false when encoderLayout is missing', () => {
    const { encoderLayout: _enc, ...rest } = validVil
    expect(isVilFile(rest)).toBe(false)
  })

  it('returns false when combo is not an array', () => {
    expect(isVilFile({ ...validVil, combo: 'bad' })).toBe(false)
  })

  it('returns false when keyOverride is not an array', () => {
    expect(isVilFile({ ...validVil, keyOverride: 'bad' })).toBe(false)
  })

  it('returns false when altRepeatKey is not an array', () => {
    expect(isVilFile({ ...validVil, altRepeatKey: {} })).toBe(false)
  })

  it('returns true when extra unknown fields are present', () => {
    const extended = { ...validVil, version: 2, customField: 'hello' }
    expect(isVilFile(extended)).toBe(true)
  })

  it('returns true when layerNames is present', () => {
    const withNames = { ...validVil, layerNames: ['Base', 'Nav', ''] }
    expect(isVilFile(withNames)).toBe(true)
  })

  it('returns true when layerNames is absent (backward compat)', () => {
    expect(isVilFile(validVil)).toBe(true)
    expect((validVil as Record<string, unknown>).layerNames).toBeUndefined()
  })

  it('returns false when layerNames is not an array', () => {
    expect(isVilFile({ ...validVil, layerNames: 'bad' })).toBe(false)
  })

  it('returns false when layerNames contains non-strings', () => {
    expect(isVilFile({ ...validVil, layerNames: [123, null] })).toBe(false)
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
