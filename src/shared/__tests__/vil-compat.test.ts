// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  uidHexToBigInt,
  uidBigIntToHex,
  extractUidFromJson,
  stringifyWithBigIntUid,
  isVialGuiFile,
  vilToVialGuiJson,
  vialGuiToVil,
  type VilExportContext,
} from '../vil-compat'
import { recreateKeyboardKeycodes } from '../keycodes/keycodes'
import type { VilFile } from '../types/protocol'

// Initialize keycodes for tests (needed for serialize/deserialize)
beforeAll(() => {
  recreateKeyboardKeycodes({
    vialProtocol: 6,
    layers: 9,
    macroCount: 16,
    tapDanceCount: 32,
    customKeycodes: null,
    midi: '',
    supportedFeatures: new Set(),
  })
})

// ---------------------------------------------------------------------------
// UID conversion
// ---------------------------------------------------------------------------

describe('UID conversion', () => {
  it('converts hex string to BigInt', () => {
    expect(uidHexToBigInt('0xFBF3B07838D7076A')).toBe(18155048553256781674n)
  })

  it('converts BigInt to hex string', () => {
    expect(uidBigIntToHex(18155048553256781674n)).toBe('0xFBF3B07838D7076A')
  })

  it('round-trips hex → BigInt → hex', () => {
    const hex = '0xFBF3B07838D7076A'
    expect(uidBigIntToHex(uidHexToBigInt(hex))).toBe(hex)
  })

  it('round-trips BigInt → hex → BigInt', () => {
    const n = 18155048553256781674n
    expect(uidHexToBigInt(uidBigIntToHex(n))).toBe(n)
  })

  it('handles 0x0 UID', () => {
    expect(uidHexToBigInt('0x0')).toBe(0n)
    expect(uidBigIntToHex(0n)).toBe('0x0')
  })
})

// ---------------------------------------------------------------------------
// BigInt-safe JSON stringify
// ---------------------------------------------------------------------------

describe('stringifyWithBigIntUid', () => {
  it('produces valid JSON with integer UID (not quoted)', () => {
    const obj = { version: 1, foo: 'bar' }
    const json = stringifyWithBigIntUid(obj, 18147293849398344554n)
    expect(json).toContain('18147293849398344554')
    expect(json).not.toContain('"18147293849398344554"')
    // Should parse without loss of structure (UID precision may be lost with JSON.parse)
    const parsed = JSON.parse(json)
    expect(parsed.version).toBe(1)
    expect(parsed.foo).toBe('bar')
  })
})

// ---------------------------------------------------------------------------
// extractUidFromJson
// ---------------------------------------------------------------------------

describe('extractUidFromJson', () => {
  it('extracts large integer UID from raw JSON', () => {
    const json = '{"version": 1, "uid": 18147293849398344426, "layout": []}'
    expect(extractUidFromJson(json)).toBe('0xFBD8239B8804FAEA')
  })

  it('returns 0x0 when no uid field', () => {
    expect(extractUidFromJson('{"version": 1}')).toBe('0x0')
  })
})

// ---------------------------------------------------------------------------
// isVialGuiFile
// ---------------------------------------------------------------------------

describe('isVialGuiFile', () => {
  it('detects vial-gui format (has layout array + version)', () => {
    expect(isVialGuiFile({ version: 1, layout: [[['KC_A']]] })).toBe(true)
  })

  it('rejects Pipette format (has keymap record, no layout)', () => {
    expect(isVialGuiFile({ uid: '0x0', keymap: { '0,0,0': 4 } })).toBe(false)
  })

  it('rejects null', () => {
    expect(isVialGuiFile(null)).toBe(false)
  })

  it('rejects non-object', () => {
    expect(isVialGuiFile('string')).toBe(false)
  })

  it('rejects object with layout but no version', () => {
    expect(isVialGuiFile({ layout: [[['KC_A']]] })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Keymap conversion
// ---------------------------------------------------------------------------

describe('keymap export (flat Record → 3D array)', () => {
  it('converts keycodes to QMK strings', () => {
    const ctx: VilExportContext = {
      rows: 2, cols: 2, layers: 1,
      encoderCount: 0, vialProtocol: 6, viaProtocol: 9,
      macroActions: [],
    }
    const vil: VilFile = {
      uid: '0x0',
      keymap: { '0,0,0': 0x04, '0,0,1': 0x05, '0,1,0': 0x06, '0,1,1': 0x07 },
      encoderLayout: {},
      macros: [0],
      layoutOptions: 0,
      tapDance: [],
      combo: [],
      keyOverride: [],
      altRepeatKey: [],
      qmkSettings: {},
    }
    const json = vilToVialGuiJson(vil, ctx)
    const parsed = JSON.parse(json)
    expect(parsed.layout).toEqual([[['KC_A', 'KC_B'], ['KC_C', 'KC_D']]])
  })

  it('fills missing keys with -1', () => {
    const ctx: VilExportContext = {
      rows: 1, cols: 3, layers: 1,
      encoderCount: 0, vialProtocol: 6, viaProtocol: 9,
      macroActions: [],
    }
    const vil: VilFile = {
      uid: '0x0',
      keymap: { '0,0,0': 0x04 },
      encoderLayout: {},
      macros: [0],
      layoutOptions: 0,
      tapDance: [],
      combo: [],
      keyOverride: [],
      altRepeatKey: [],
      qmkSettings: {},
    }
    const json = vilToVialGuiJson(vil, ctx)
    const parsed = JSON.parse(json)
    expect(parsed.layout[0][0]).toEqual(['KC_A', -1, -1])
  })
})

describe('keymap import (3D array → flat Record)', () => {
  it('converts QMK strings to numeric keycodes', () => {
    const rawJson = '{"version": 1, "uid": 0, "layout": [[["KC_A", "KC_B"]]]}'
    const data = JSON.parse(rawJson)
    const vil = vialGuiToVil(data, rawJson, [0])
    expect(vil.keymap['0,0,0']).toBe(0x04)
    expect(vil.keymap['0,0,1']).toBe(0x05)
  })

  it('skips -1 entries', () => {
    const rawJson = '{"version": 1, "uid": 0, "layout": [[["KC_A", -1, "KC_B"]]]}'
    const data = JSON.parse(rawJson)
    const vil = vialGuiToVil(data, rawJson, [0])
    expect(vil.keymap['0,0,0']).toBe(0x04)
    expect('0,0,1' in vil.keymap).toBe(false)
    expect(vil.keymap['0,0,2']).toBe(0x05)
  })
})

// ---------------------------------------------------------------------------
// Encoder layout
// ---------------------------------------------------------------------------

describe('encoder layout round-trip', () => {
  it('converts encoder layout to 3D array and back', () => {
    const encoderLayout = { '0,0,0': 0x81, '0,0,1': 0x80, '1,0,0': 0x01, '1,0,1': 0x01 }
    const ctx: VilExportContext = {
      rows: 1, cols: 1, layers: 2,
      encoderCount: 1, vialProtocol: 6, viaProtocol: 9,
      macroActions: [],
    }
    const vil: VilFile = {
      uid: '0x0',
      keymap: { '0,0,0': 0x00, '1,0,0': 0x00 },
      encoderLayout,
      macros: [0],
      layoutOptions: 0,
      tapDance: [],
      combo: [],
      keyOverride: [],
      altRepeatKey: [],
      qmkSettings: {},
    }
    const json = vilToVialGuiJson(vil, ctx)
    const parsed = JSON.parse(json)

    // Check export format (v6 protocol uses KC__VOLDOWN/KC__VOLUP names)
    expect(parsed.encoder_layout).toEqual([
      [['KC__VOLDOWN', 'KC__VOLUP']],
      [['KC_TRNS', 'KC_TRNS']],
    ])

    // Round-trip back
    const restored = vialGuiToVil(parsed, json, [0])
    expect(restored.encoderLayout).toEqual(encoderLayout)
  })
})

// ---------------------------------------------------------------------------
// Tap dance
// ---------------------------------------------------------------------------

describe('tap dance conversion', () => {
  it('converts object to tuple and back', () => {
    const entries = [
      { onTap: 0x04, onHold: 0x05, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 },
    ]
    const ctx: VilExportContext = {
      rows: 1, cols: 1, layers: 1,
      encoderCount: 0, vialProtocol: 6, viaProtocol: 9,
      macroActions: [],
    }
    const vil: VilFile = {
      uid: '0x0',
      keymap: { '0,0,0': 0x00 },
      encoderLayout: {},
      macros: [0],
      layoutOptions: 0,
      tapDance: entries,
      combo: [],
      keyOverride: [],
      altRepeatKey: [],
      qmkSettings: {},
    }
    const json = vilToVialGuiJson(vil, ctx)
    const parsed = JSON.parse(json)

    // Verify tuple format
    expect(parsed.tap_dance[0]).toEqual(['KC_A', 'KC_B', 'KC_NO', 'KC_NO', 200])

    // Round-trip
    const restored = vialGuiToVil(parsed, json, [0])
    expect(restored.tapDance).toEqual(entries)
  })
})

// ---------------------------------------------------------------------------
// Combo
// ---------------------------------------------------------------------------

describe('combo conversion', () => {
  it('converts object to tuple and back', () => {
    const entries = [
      { key1: 0x04, key2: 0x05, key3: 0, key4: 0, output: 0x06 },
    ]
    const ctx: VilExportContext = {
      rows: 1, cols: 1, layers: 1,
      encoderCount: 0, vialProtocol: 6, viaProtocol: 9,
      macroActions: [],
    }
    const vil: VilFile = {
      uid: '0x0',
      keymap: { '0,0,0': 0x00 },
      encoderLayout: {},
      macros: [0],
      layoutOptions: 0,
      tapDance: [],
      combo: entries,
      keyOverride: [],
      altRepeatKey: [],
      qmkSettings: {},
    }
    const json = vilToVialGuiJson(vil, ctx)
    const parsed = JSON.parse(json)

    expect(parsed.combo[0]).toEqual(['KC_A', 'KC_B', 'KC_NO', 'KC_NO', 'KC_C'])

    const restored = vialGuiToVil(parsed, json, [0])
    expect(restored.combo).toEqual(entries)
  })
})

// ---------------------------------------------------------------------------
// Key override
// ---------------------------------------------------------------------------

describe('key override conversion', () => {
  it('merges enabled into options bit 7 on export', () => {
    const entries = [{
      triggerKey: 0x04,
      replacementKey: 0x05,
      layers: 0xffff,
      triggerMods: 2,
      negativeMods: 0,
      suppressedMods: 0,
      options: 7,
      enabled: true,
    }]
    const ctx: VilExportContext = {
      rows: 1, cols: 1, layers: 1,
      encoderCount: 0, vialProtocol: 6, viaProtocol: 9,
      macroActions: [],
    }
    const vil: VilFile = {
      uid: '0x0',
      keymap: { '0,0,0': 0x00 },
      encoderLayout: {},
      macros: [0],
      layoutOptions: 0,
      tapDance: [],
      combo: [],
      keyOverride: entries,
      altRepeatKey: [],
      qmkSettings: {},
    }
    const json = vilToVialGuiJson(vil, ctx)
    const parsed = JSON.parse(json)

    // enabled=true → options bit 7 set
    expect(parsed.key_override[0].options).toBe(7 | 0x80)
    expect(parsed.key_override[0].trigger).toBe('KC_A')
    expect(parsed.key_override[0].replacement).toBe('KC_B')
    expect(parsed.key_override[0].trigger_mods).toBe(2)
    expect(parsed.key_override[0].negative_mod_mask).toBe(0)
    expect(parsed.key_override[0].suppressed_mods).toBe(0)
  })

  it('extracts enabled from options bit 7 on import', () => {
    const rawJson = JSON.stringify({
      version: 1, uid: 0,
      layout: [[['KC_NO']]],
      key_override: [{
        trigger: 'KC_A',
        replacement: 'KC_B',
        layers: 0xffff,
        trigger_mods: 2,
        negative_mod_mask: 0,
        suppressed_mods: 0,
        options: 7 | 0x80,
      }],
    })
    const data = JSON.parse(rawJson)
    const vil = vialGuiToVil(data, rawJson, [0])

    expect(vil.keyOverride[0].enabled).toBe(true)
    expect(vil.keyOverride[0].options).toBe(7)
    expect(vil.keyOverride[0].triggerKey).toBe(0x04)
  })

  it('disabled key override has bit 7 cleared', () => {
    const entries = [{
      triggerKey: 0,
      replacementKey: 0,
      layers: 0xffff,
      triggerMods: 0,
      negativeMods: 0,
      suppressedMods: 0,
      options: 7,
      enabled: false,
    }]
    const ctx: VilExportContext = {
      rows: 1, cols: 1, layers: 1,
      encoderCount: 0, vialProtocol: 6, viaProtocol: 9,
      macroActions: [],
    }
    const vil: VilFile = {
      uid: '0x0',
      keymap: { '0,0,0': 0x00 },
      encoderLayout: {},
      macros: [0],
      layoutOptions: 0,
      tapDance: [],
      combo: [],
      keyOverride: entries,
      altRepeatKey: [],
      qmkSettings: {},
    }
    const json = vilToVialGuiJson(vil, ctx)
    const parsed = JSON.parse(json)

    expect(parsed.key_override[0].options).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// Alt repeat key
// ---------------------------------------------------------------------------

describe('alt repeat key conversion', () => {
  it('merges enabled into options bit 3 on export', () => {
    const entries = [{
      lastKey: 0x04,
      altKey: 0x05,
      allowedMods: 0,
      options: 3,
      enabled: true,
    }]
    const ctx: VilExportContext = {
      rows: 1, cols: 1, layers: 1,
      encoderCount: 0, vialProtocol: 6, viaProtocol: 9,
      macroActions: [],
    }
    const vil: VilFile = {
      uid: '0x0',
      keymap: { '0,0,0': 0x00 },
      encoderLayout: {},
      macros: [0],
      layoutOptions: 0,
      tapDance: [],
      combo: [],
      keyOverride: [],
      altRepeatKey: entries,
      qmkSettings: {},
    }
    const json = vilToVialGuiJson(vil, ctx)
    const parsed = JSON.parse(json)

    expect(parsed.alt_repeat_key[0].options).toBe(3 | 0x08)
    expect(parsed.alt_repeat_key[0].keycode).toBe('KC_A')
    expect(parsed.alt_repeat_key[0].alt_keycode).toBe('KC_B')
  })

  it('extracts enabled from options bit 3 on import', () => {
    const rawJson = JSON.stringify({
      version: 1, uid: 0,
      layout: [[['KC_NO']]],
      alt_repeat_key: [{
        keycode: 'KC_A',
        alt_keycode: 'KC_B',
        allowed_mods: 0,
        options: 3 | 0x08,
      }],
    })
    const data = JSON.parse(rawJson)
    const vil = vialGuiToVil(data, rawJson, [0])

    expect(vil.altRepeatKey[0].enabled).toBe(true)
    expect(vil.altRepeatKey[0].options).toBe(3)
  })

  it('disabled alt repeat key has bit 3 cleared', () => {
    const entries = [{
      lastKey: 0,
      altKey: 0,
      allowedMods: 0,
      options: 0,
      enabled: false,
    }]
    const ctx: VilExportContext = {
      rows: 1, cols: 1, layers: 1,
      encoderCount: 0, vialProtocol: 6, viaProtocol: 9,
      macroActions: [],
    }
    const vil: VilFile = {
      uid: '0x0',
      keymap: { '0,0,0': 0x00 },
      encoderLayout: {},
      macros: [0],
      layoutOptions: 0,
      tapDance: [],
      combo: [],
      keyOverride: [],
      altRepeatKey: entries,
      qmkSettings: {},
    }
    const json = vilToVialGuiJson(vil, ctx)
    const parsed = JSON.parse(json)

    expect(parsed.alt_repeat_key[0].options).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// QMK settings
// ---------------------------------------------------------------------------

describe('QMK settings conversion', () => {
  it('converts byte array to integer (single byte)', () => {
    const ctx: VilExportContext = {
      rows: 1, cols: 1, layers: 1,
      encoderCount: 0, vialProtocol: 6, viaProtocol: 9,
      macroActions: [],
    }
    const vil: VilFile = {
      uid: '0x0',
      keymap: { '0,0,0': 0x00 },
      encoderLayout: {},
      macros: [0],
      layoutOptions: 0,
      tapDance: [],
      combo: [],
      keyOverride: [],
      altRepeatKey: [],
      qmkSettings: { '1': [0], '2': [50] },
    }
    const json = vilToVialGuiJson(vil, ctx)
    const parsed = JSON.parse(json)

    expect(parsed.settings['1']).toBe(0)
    expect(parsed.settings['2']).toBe(50)
  })

  it('converts multi-byte LE array to integer', () => {
    const ctx: VilExportContext = {
      rows: 1, cols: 1, layers: 1,
      encoderCount: 0, vialProtocol: 6, viaProtocol: 9,
      macroActions: [],
    }
    const vil: VilFile = {
      uid: '0x0',
      keymap: { '0,0,0': 0x00 },
      encoderLayout: {},
      macros: [0],
      layoutOptions: 0,
      tapDance: [],
      combo: [],
      keyOverride: [],
      altRepeatKey: [],
      qmkSettings: { '6': [0x88, 0x13] }, // 5000 = 0x1388
    }
    const json = vilToVialGuiJson(vil, ctx)
    const parsed = JSON.parse(json)

    expect(parsed.settings['6']).toBe(5000)
  })

  it('converts integer to byte array on import', () => {
    const rawJson = JSON.stringify({
      version: 1, uid: 0,
      layout: [[['KC_NO']]],
      settings: { '1': 0, '2': 50, '6': 5000 },
    })
    const data = JSON.parse(rawJson)
    const vil = vialGuiToVil(data, rawJson, [0])

    expect(vil.qmkSettings['1']).toEqual([0])
    expect(vil.qmkSettings['2']).toEqual([50])
    expect(vil.qmkSettings['6']).toEqual([0x88, 0x13])
  })
})

// ---------------------------------------------------------------------------
// Full round-trip
// ---------------------------------------------------------------------------

describe('full VilFile → vial-gui → VilFile round-trip', () => {
  const FIXTURE_VIL: VilFile = {
    uid: '0xFBF3B07838D7076A',
    keymap: {
      '0,0,0': 0x4f, '0,0,1': 0x52, '0,0,2': 0x50,
      '0,1,0': 0x1e, '0,1,1': 0x1f, '0,1,2': 0x20,
    },
    encoderLayout: { '0,0,0': 0x81, '0,0,1': 0x80 },
    macros: [0],
    layoutOptions: 0,
    tapDance: [
      { onTap: 0x04, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 150 },
    ],
    combo: [{ key1: 0x04, key2: 0x05, key3: 0, key4: 0, output: 0x06 }],
    keyOverride: [{
      triggerKey: 0x04,
      replacementKey: 0x05,
      layers: 0xffff,
      triggerMods: 0,
      negativeMods: 0,
      suppressedMods: 0,
      options: 7,
      enabled: true,
    }],
    altRepeatKey: [{ lastKey: 0x04, altKey: 0x05, allowedMods: 0, options: 0, enabled: true }],
    qmkSettings: { '1': [0], '2': [50] },
  }

  const CTX: VilExportContext = {
    rows: 2, cols: 3, layers: 1,
    encoderCount: 1, vialProtocol: 6, viaProtocol: 9,
    macroActions: [[]],
  }

  it('preserves all data through round-trip', () => {
    const json = vilToVialGuiJson(FIXTURE_VIL, CTX)
    const parsed = JSON.parse(json)
    const restored = vialGuiToVil(parsed, json, FIXTURE_VIL.macros)

    expect(restored.uid).toBe(FIXTURE_VIL.uid)
    expect(restored.keymap).toEqual(FIXTURE_VIL.keymap)
    expect(restored.encoderLayout).toEqual(FIXTURE_VIL.encoderLayout)
    expect(restored.macros).toEqual(FIXTURE_VIL.macros)
    expect(restored.layoutOptions).toBe(FIXTURE_VIL.layoutOptions)
    expect(restored.tapDance).toEqual(FIXTURE_VIL.tapDance)
    expect(restored.combo).toEqual(FIXTURE_VIL.combo)
    expect(restored.keyOverride).toEqual(FIXTURE_VIL.keyOverride)
    expect(restored.altRepeatKey).toEqual(FIXTURE_VIL.altRepeatKey)
    expect(restored.qmkSettings).toEqual(FIXTURE_VIL.qmkSettings)
  })

  it('exported JSON has expected top-level keys', () => {
    const json = vilToVialGuiJson(FIXTURE_VIL, CTX)
    const parsed = JSON.parse(json)

    expect(parsed.version).toBe(1)
    expect(parsed.vial_protocol).toBe(6)
    expect(parsed.via_protocol).toBe(9)
    expect(Array.isArray(parsed.layout)).toBe(true)
    expect(Array.isArray(parsed.encoder_layout)).toBe(true)
    expect(parsed.layout_options).toBe(0)
    // Should NOT have Pipette-specific keys
    expect(parsed.keymap).toBeUndefined()
    expect(parsed.encoderLayout).toBeUndefined()
    expect(parsed.layerNames).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Real vial-gui file import
// ---------------------------------------------------------------------------

describe('real vial-gui file import', () => {
  it('imports bento-max.vil from vial-gui', () => {
    const rawJson = readFileSync(
      join(__dirname, '../../renderer/hooks/__tests__/fixtures/bento-max.vil'),
      'utf-8',
    )
    const data = JSON.parse(rawJson)

    expect(isVialGuiFile(data)).toBe(true)

    const vil = vialGuiToVil(data, rawJson, [0])

    // Check UID was extracted from raw JSON
    expect(vil.uid).toBe('0xFBD8239B8804FAEA')

    // Check keymap was properly converted
    expect(vil.keymap['0,0,0']).toBe(0x4f) // KC_RIGHT
    expect(vil.keymap['0,0,1']).toBe(0x52) // KC_UP
    expect(vil.keymap['0,0,2']).toBe(0x50) // KC_LEFT
    expect(vil.keymap['0,0,3']).toBe(0x51) // KC_DOWN

    // -1 entries should be omitted
    expect('0,0,4' in vil.keymap).toBe(false)

    // Check encoder layout (KC_VOLD/KC_VOLU resolve to v6 values)
    expect(typeof vil.encoderLayout['0,0,0']).toBe('number')
    expect(typeof vil.encoderLayout['0,0,1']).toBe('number')

    // Check tap dance
    expect(vil.tapDance[0].onTap).toBe(0) // KC_NO
    expect(vil.tapDance[0].tappingTerm).toBe(150)

    // Check combo
    expect(vil.combo.length).toBe(32)
    expect(vil.combo[0].key1).toBe(0) // KC_NO

    // Check key override
    expect(vil.keyOverride.length).toBe(32)
    expect(vil.keyOverride[0].options).toBe(7)
    expect(vil.keyOverride[0].enabled).toBe(false) // bit 7 not set in options=7

    // Check alt repeat key
    expect(vil.altRepeatKey.length).toBe(32)
    expect(vil.altRepeatKey[0].enabled).toBe(false) // bit 3 not set in options=0

    // Check QMK settings
    expect(vil.qmkSettings['1']).toEqual([0])
    expect(vil.qmkSettings['2']).toEqual([50])
    expect(vil.qmkSettings['6']).toEqual([0x88, 0x13]) // 5000
  })
})
