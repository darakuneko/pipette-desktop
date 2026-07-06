// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  TAP_DANCE_ENTRY_COUNT,
  COMBO_ENTRY_COUNT,
  KEY_OVERRIDE_ENTRY_COUNT,
  ALT_REPEAT_KEY_ENTRY_COUNT,
  createDefaultTapDanceEntries,
  createDefaultComboEntries,
  createDefaultKeyOverrideEntries,
  createDefaultAltRepeatKeyEntries,
  getTapDance,
  setTapDance,
  getCombo,
  setCombo,
  getKeyOverride,
  setKeyOverride,
  getAltRepeatKey,
  setAltRepeatKey,
  readTapDanceEntry,
  writeTapDanceEntry,
  readComboEntry,
  writeComboEntry,
  readKeyOverrideEntry,
  writeKeyOverrideEntry,
  readAltRepeatKeyEntry,
  writeAltRepeatKeyEntry,
} from '../virtual-device/dynamic-entries'

describe('default entry factories', () => {
  it('create arrays sized to the 32-entry tier', () => {
    expect(createDefaultTapDanceEntries()).toHaveLength(TAP_DANCE_ENTRY_COUNT)
    expect(createDefaultComboEntries()).toHaveLength(COMBO_ENTRY_COUNT)
    expect(createDefaultKeyOverrideEntries()).toHaveLength(KEY_OVERRIDE_ENTRY_COUNT)
    expect(createDefaultAltRepeatKeyEntries()).toHaveLength(ALT_REPEAT_KEY_ENTRY_COUNT)
    expect(TAP_DANCE_ENTRY_COUNT).toBe(32)
    expect(COMBO_ENTRY_COUNT).toBe(32)
    expect(KEY_OVERRIDE_ENTRY_COUNT).toBe(32)
    expect(ALT_REPEAT_KEY_ENTRY_COUNT).toBe(32)
  })

  it('tap dance defaults match dynamic_keymap_reset(): all-KC_NO with TAPPING_TERM', () => {
    const entries = createDefaultTapDanceEntries()
    for (const entry of entries) {
      expect(entry).toEqual({ onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 })
    }
  })

  it('combo defaults are all-zero', () => {
    for (const entry of createDefaultComboEntries()) {
      expect(entry).toEqual({ key1: 0, key2: 0, key3: 0, key4: 0, output: 0 })
    }
  })

  it('key override defaults match dynamic_keymap_reset(): all layers, disabled, activation options set', () => {
    for (const entry of createDefaultKeyOverrideEntries()) {
      expect(entry.layers).toBe(0xffff)
      expect(entry.options).toBe(0x07)
      expect(entry.enabled).toBe(false)
    }
  })

  it('alt repeat key defaults are all-zero/disabled', () => {
    for (const entry of createDefaultAltRepeatKeyEntries()) {
      expect(entry).toEqual({ lastKey: 0, altKey: 0, allowedMods: 0, options: 0, enabled: false })
    }
  })
})

describe('bounds-checked get/set', () => {
  it('tap dance: get out of range returns status 0xff and an all-zero entry (not the factory default)', () => {
    const entries = createDefaultTapDanceEntries()
    const { status, entry } = getTapDance(entries, 32)
    expect(status).toBe(0xff)
    expect(entry).toEqual({ onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 0 })
  })

  it('tap dance: set out of range does not mutate the store', () => {
    const entries = createDefaultTapDanceEntries()
    const status = setTapDance(entries, 32, { onTap: 4, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 1 })
    expect(status).toBe(0xff)
    expect(entries[31]).toEqual({ onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 })
  })

  it('tap dance: in-range set/get round-trips', () => {
    const entries = createDefaultTapDanceEntries()
    const entry = { onTap: 4, onHold: 224, onDoubleTap: 0, onTapHold: 0, tappingTerm: 175 }
    expect(setTapDance(entries, 3, entry)).toBe(0)
    expect(getTapDance(entries, 3)).toEqual({ status: 0, entry })
  })

  it('combo/key-override/alt-repeat: out-of-range index rejected, in-range round-trips', () => {
    const combos = createDefaultComboEntries()
    expect(setCombo(combos, -1, { key1: 0, key2: 0, key3: 0, key4: 0, output: 0 })).toBe(0xff)
    const combo = { key1: 0x0d, key2: 0x0e, key3: 0, key4: 0, output: 0x29 }
    expect(setCombo(combos, 2, combo)).toBe(0)
    expect(getCombo(combos, 2)).toEqual({ status: 0, entry: combo })
    expect(getCombo(combos, 32).status).toBe(0xff)

    const keyOverrides = createDefaultKeyOverrideEntries()
    const keyOverride = {
      triggerKey: 0x2a,
      replacementKey: 0x4c,
      layers: 0xffff,
      triggerMods: 0x02,
      negativeMods: 0,
      suppressedMods: 0x02,
      options: 0x07,
      enabled: true,
    }
    expect(setKeyOverride(keyOverrides, 999, keyOverride)).toBe(0xff)
    expect(setKeyOverride(keyOverrides, 1, keyOverride)).toBe(0)
    expect(getKeyOverride(keyOverrides, 1)).toEqual({ status: 0, entry: keyOverride })
    expect(getKeyOverride(keyOverrides, 999).status).toBe(0xff)

    const altRepeatKeys = createDefaultAltRepeatKeyEntries()
    const altRepeatKey = { lastKey: 0x06, altKey: 0x19, allowedMods: 0, options: 0x03, enabled: true }
    expect(setAltRepeatKey(altRepeatKeys, 32, altRepeatKey)).toBe(0xff)
    expect(setAltRepeatKey(altRepeatKeys, 4, altRepeatKey)).toBe(0)
    expect(getAltRepeatKey(altRepeatKeys, 4)).toEqual({ status: 0, entry: altRepeatKey })
    expect(getAltRepeatKey(altRepeatKeys, 32).status).toBe(0xff)
  })
})

describe('wire codecs', () => {
  it('tap dance entry round-trips through LE16 x5', () => {
    const buf = new Uint8Array(10)
    const entry = { onTap: 0x0004, onHold: 0x00e0, onDoubleTap: 0x1234, onTapHold: 0xabcd, tappingTerm: 200 }
    writeTapDanceEntry(buf, 0, entry)
    expect(readTapDanceEntry(buf, 0)).toEqual(entry)
  })

  it('combo entry round-trips through LE16 x5', () => {
    const buf = new Uint8Array(10)
    const entry = { key1: 0x0d, key2: 0x0e, key3: 0, key4: 0, output: 0x29 }
    writeComboEntry(buf, 0, entry)
    expect(readComboEntry(buf, 0)).toEqual(entry)
  })

  it('key override entry packs enabled into bit 7 of the combined options byte', () => {
    const buf = new Uint8Array(10)
    const entry = {
      triggerKey: 0x2a,
      replacementKey: 0x4c,
      layers: 0xffff,
      triggerMods: 0x02,
      negativeMods: 0,
      suppressedMods: 0x02,
      options: 0x07,
      enabled: true,
    }
    writeKeyOverrideEntry(buf, 0, entry)
    expect(buf[9]).toBe(0x87)
    expect(readKeyOverrideEntry(buf, 0)).toEqual(entry)
  })

  it('alt repeat key entry packs enabled into bit 3 of the combined options byte', () => {
    const buf = new Uint8Array(6)
    const entry = { lastKey: 0x06, altKey: 0x19, allowedMods: 0, options: 0x03, enabled: true }
    writeAltRepeatKeyEntry(buf, 0, entry)
    expect(buf[5]).toBe(0x0b)
    expect(readAltRepeatKeyEntry(buf, 0)).toEqual(entry)
  })
})
