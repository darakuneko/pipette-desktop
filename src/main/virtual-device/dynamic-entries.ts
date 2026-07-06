// SPDX-License-Identifier: GPL-2.0-or-later
// Tap dance / combo / key override / alt-repeat-key stores and wire codecs
// for the virtual GPK60-63R emulator.
//
// Entry counts mirror vial-qmk's quantum/vial.h tiering, which picks 32/16/8/4
// entries per kind from TOTAL_EEPROM_BYTE_COUNT. This board's EEPROM is
// emulated via wear-leveling on internal flash (STM32L4 has no real EEPROM):
// builddefs/common_features.mk selects EEPROM_WEAR_LEVELING with
// WEAR_LEVELING_DRIVER=embedded_flash for STM32L4xx, and
// platforms/chibios/drivers/wear_leveling/wear_leveling_efl_config.h defaults
// WEAR_LEVELING_BACKING_SIZE to 8192 (logical size = backing/2 = 4096), none
// of which the keyboard overrides. TOTAL_EEPROM_BYTE_COUNT = 4096 is > 4000,
// landing every dynamic-entry kind in the top (32-entry) tier.
//
// Alt-repeat-key entries require VIAL_ALT_REPEAT_KEY_ENABLE, which vial.h
// defines when REPEAT_KEY_ENABLE is set and NO_ALT_REPEAT_KEY is not.
// builddefs/build_vial.mk defaults REPEAT_KEY_ENABLE to yes for all
// VIAL_ENABLE builds, and the keyboard does not override it or define
// NO_ALT_REPEAT_KEY, so alt-repeat-key entries are supported.

import type { TapDanceEntry, ComboEntry, KeyOverrideEntry, AltRepeatKeyEntry } from '../../shared/types/protocol'
import { readLE16, writeLE16 } from './byte-utils'

export const TAP_DANCE_ENTRY_COUNT = 32
export const COMBO_ENTRY_COUNT = 32
export const KEY_OVERRIDE_ENTRY_COUNT = 32
export const ALT_REPEAT_KEY_ENTRY_COUNT = 32

/**
 * Feature flags byte from dynamic_vial_get_number_of_entries (bit 0 = Caps
 * Word, bit 1 = Layer Lock). Both CAPS_WORD_ENABLE and LAYER_LOCK_ENABLE
 * default to yes in build_vial.mk and the keyboard does not override either.
 */
export const DYNAMIC_ENTRY_FEATURE_FLAGS = 0x03

/** quantum/action_tapping.h TAPPING_TERM default, used by dynamic_keymap_reset(). */
const TAPPING_TERM_DEFAULT = 200

/**
 * Key override options bits set by dynamic_keymap_reset(): trigger-down +
 * required-mod-down + negative-mod-up activation. The vial_ko_enabled bit is
 * intentionally left unset — a freshly reset entry exists but is disabled
 * until a user configures it.
 */
const KEY_OVERRIDE_DEFAULT_OPTIONS = 0x07

function defaultTapDanceEntry(): TapDanceEntry {
  return { onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: TAPPING_TERM_DEFAULT }
}

function defaultComboEntry(): ComboEntry {
  return { key1: 0, key2: 0, key3: 0, key4: 0, output: 0 }
}

function defaultKeyOverrideEntry(): KeyOverrideEntry {
  return {
    triggerKey: 0,
    replacementKey: 0,
    layers: 0xffff,
    triggerMods: 0,
    negativeMods: 0,
    suppressedMods: 0,
    options: KEY_OVERRIDE_DEFAULT_OPTIONS,
    enabled: false,
  }
}

function defaultAltRepeatKeyEntry(): AltRepeatKeyEntry {
  return { lastKey: 0, altKey: 0, allowedMods: 0, options: 0, enabled: false }
}

/** Zero entries returned for out-of-range get() calls — mirror vial.c's
 *  stack-zero-initialized local struct that dynamic_keymap_get_* leaves
 *  untouched when the index is out of bounds. Frozen shared singletons:
 *  callers only serialize them, never mutate. */
const ZERO_TAP_DANCE: TapDanceEntry = Object.freeze({
  onTap: 0,
  onHold: 0,
  onDoubleTap: 0,
  onTapHold: 0,
  tappingTerm: 0,
})
const ZERO_COMBO: ComboEntry = Object.freeze({ key1: 0, key2: 0, key3: 0, key4: 0, output: 0 })
const ZERO_KEY_OVERRIDE: KeyOverrideEntry = Object.freeze({
  triggerKey: 0,
  replacementKey: 0,
  layers: 0,
  triggerMods: 0,
  negativeMods: 0,
  suppressedMods: 0,
  options: 0,
  enabled: false,
})
const ZERO_ALT_REPEAT_KEY: AltRepeatKeyEntry = Object.freeze({
  lastKey: 0,
  altKey: 0,
  allowedMods: 0,
  options: 0,
  enabled: false,
})

export function createDefaultTapDanceEntries(): TapDanceEntry[] {
  return Array.from({ length: TAP_DANCE_ENTRY_COUNT }, defaultTapDanceEntry)
}

export function createDefaultComboEntries(): ComboEntry[] {
  return Array.from({ length: COMBO_ENTRY_COUNT }, defaultComboEntry)
}

export function createDefaultKeyOverrideEntries(): KeyOverrideEntry[] {
  return Array.from({ length: KEY_OVERRIDE_ENTRY_COUNT }, defaultKeyOverrideEntry)
}

export function createDefaultAltRepeatKeyEntries(): AltRepeatKeyEntry[] {
  return Array.from({ length: ALT_REPEAT_KEY_ENTRY_COUNT }, defaultAltRepeatKeyEntry)
}

// --- Wire codecs — byte layouts match vial_*_entry_t in vial-qmk's quantum/vial.h ---

export function writeTapDanceEntry(buf: Uint8Array, offset: number, entry: TapDanceEntry): void {
  writeLE16(buf, offset, entry.onTap)
  writeLE16(buf, offset + 2, entry.onHold)
  writeLE16(buf, offset + 4, entry.onDoubleTap)
  writeLE16(buf, offset + 6, entry.onTapHold)
  writeLE16(buf, offset + 8, entry.tappingTerm)
}

export function readTapDanceEntry(buf: Uint8Array, offset: number): TapDanceEntry {
  return {
    onTap: readLE16(buf, offset),
    onHold: readLE16(buf, offset + 2),
    onDoubleTap: readLE16(buf, offset + 4),
    onTapHold: readLE16(buf, offset + 6),
    tappingTerm: readLE16(buf, offset + 8),
  }
}

export function writeComboEntry(buf: Uint8Array, offset: number, entry: ComboEntry): void {
  writeLE16(buf, offset, entry.key1)
  writeLE16(buf, offset + 2, entry.key2)
  writeLE16(buf, offset + 4, entry.key3)
  writeLE16(buf, offset + 6, entry.key4)
  writeLE16(buf, offset + 8, entry.output)
}

export function readComboEntry(buf: Uint8Array, offset: number): ComboEntry {
  return {
    key1: readLE16(buf, offset),
    key2: readLE16(buf, offset + 2),
    key3: readLE16(buf, offset + 4),
    key4: readLE16(buf, offset + 6),
    output: readLE16(buf, offset + 8),
  }
}

export function writeKeyOverrideEntry(buf: Uint8Array, offset: number, entry: KeyOverrideEntry): void {
  writeLE16(buf, offset, entry.triggerKey)
  writeLE16(buf, offset + 2, entry.replacementKey)
  writeLE16(buf, offset + 4, entry.layers)
  buf[offset + 6] = entry.triggerMods
  buf[offset + 7] = entry.negativeMods
  buf[offset + 8] = entry.suppressedMods
  buf[offset + 9] = (entry.options & 0x7f) | (entry.enabled ? 0x80 : 0)
}

export function readKeyOverrideEntry(buf: Uint8Array, offset: number): KeyOverrideEntry {
  const optionsByte = buf[offset + 9]
  return {
    triggerKey: readLE16(buf, offset),
    replacementKey: readLE16(buf, offset + 2),
    layers: readLE16(buf, offset + 4),
    triggerMods: buf[offset + 6],
    negativeMods: buf[offset + 7],
    suppressedMods: buf[offset + 8],
    options: optionsByte & 0x7f,
    enabled: (optionsByte & 0x80) !== 0,
  }
}

export function writeAltRepeatKeyEntry(buf: Uint8Array, offset: number, entry: AltRepeatKeyEntry): void {
  writeLE16(buf, offset, entry.lastKey)
  writeLE16(buf, offset + 2, entry.altKey)
  buf[offset + 4] = entry.allowedMods
  buf[offset + 5] = (entry.options & 0x07) | (entry.enabled ? 0x08 : 0)
}

export function readAltRepeatKeyEntry(buf: Uint8Array, offset: number): AltRepeatKeyEntry {
  const optionsByte = buf[offset + 5]
  return {
    lastKey: readLE16(buf, offset),
    altKey: readLE16(buf, offset + 2),
    allowedMods: buf[offset + 4],
    options: optionsByte & 0x07,
    enabled: (optionsByte & 0x08) !== 0,
  }
}

// --- Bounds-checked get/set — mirrors nvm_dynamic_keymap.c's `index >= COUNT -> -1` guard.
// get() always yields an entry (the zero entry when out of range) because the real firmware's
// get handlers memcpy their local (possibly untouched) struct into the response regardless of
// the status byte. set() only writes to the store when the index is in range. ---

export interface EntryLookup<T> {
  status: number
  entry: T
}

function lookupEntry<T>(entries: T[], index: number, zero: T): EntryLookup<T> {
  if (index >= 0 && index < entries.length) {
    return { status: 0, entry: entries[index] }
  }
  return { status: 0xff, entry: zero }
}

function storeEntry<T>(entries: T[], index: number, entry: T): number {
  if (index >= 0 && index < entries.length) {
    entries[index] = entry
    return 0
  }
  return 0xff
}

export function getTapDance(entries: TapDanceEntry[], index: number): EntryLookup<TapDanceEntry> {
  return lookupEntry(entries, index, ZERO_TAP_DANCE)
}

export function setTapDance(entries: TapDanceEntry[], index: number, entry: TapDanceEntry): number {
  return storeEntry(entries, index, entry)
}

export function getCombo(entries: ComboEntry[], index: number): EntryLookup<ComboEntry> {
  return lookupEntry(entries, index, ZERO_COMBO)
}

export function setCombo(entries: ComboEntry[], index: number, entry: ComboEntry): number {
  return storeEntry(entries, index, entry)
}

export function getKeyOverride(entries: KeyOverrideEntry[], index: number): EntryLookup<KeyOverrideEntry> {
  return lookupEntry(entries, index, ZERO_KEY_OVERRIDE)
}

export function setKeyOverride(entries: KeyOverrideEntry[], index: number, entry: KeyOverrideEntry): number {
  return storeEntry(entries, index, entry)
}

export function getAltRepeatKey(entries: AltRepeatKeyEntry[], index: number): EntryLookup<AltRepeatKeyEntry> {
  return lookupEntry(entries, index, ZERO_ALT_REPEAT_KEY)
}

export function setAltRepeatKey(entries: AltRepeatKeyEntry[], index: number, entry: AltRepeatKeyEntry): number {
  return storeEntry(entries, index, entry)
}
