// SPDX-License-Identifier: GPL-2.0-or-later
// Dataset and keycode-resolution helpers for the virtual GPK60-63R emulator.
// Keymap layers, macro/dynamic-entry sample data, and identity constants
// mirror the firmware source (keymaps/vial/keymap.c, keymaps/vial/vial.json)
// so the emulator's protocol responses are shaped exactly like a physical
// device. Small protocol-behavior helpers derived from the dataset (e.g. the
// QK_BOOT firewall check) also live here, since this is the one module that
// owns protocol-version-aware keycode resolution.

import * as lzmaModule from 'lzma'
// `keycodes.ts` must load before `keycodes-utils.ts` — the latter imports
// from the former at the top, while `keycodes.ts` imports back from
// `keycodes-utils.ts` at its own tail to run one-time init. Importing
// `keycodes-utils.ts` first would re-enter it mid-evaluation and trip a
// TDZ error on its module-level `let` state.
import { setProtocolValue } from '../../shared/keycodes/keycodes'
import { resolve, deserialize } from '../../shared/keycodes/keycodes-utils'
import { SS_QMK_PREFIX, SS_TAP_CODE } from '../../shared/constants/protocol'
import type { TapDanceEntry, ComboEntry, KeyOverrideEntry, AltRepeatKeyEntry } from '../../shared/types/protocol'
import definitionJson from './gpk60-63r-definition.json'

export const VIRTUAL_DEVICE_VID = 0x7a79
export const VIRTUAL_DEVICE_PID = 0xf063
export const VIRTUAL_DEVICE_NAME = 'Virtual Keyboard'
export const VIRTUAL_DEVICE_SERIAL = 'vial:f64c2b3c:virtual'
export const VIRTUAL_DEVICE_UID_BYTES = new Uint8Array([0x56, 0x49, 0x52, 0x54, 0x47, 0x50, 0x4b, 0x00])
/** (row, col) pairs — hold both to unlock, matching the firmware's vial unlock combo. */
export const VIRTUAL_DEVICE_UNLOCK_COMBO: readonly [number, number][] = [
  [0, 0],
  [0, 1],
]

export const VIAL_PROTOCOL = 6
export const VIA_PROTOCOL = 9
export const LAYERS = 4
export const ROWS = 5
export const COLS = 14
export const MACRO_COUNT = 16
export const MACRO_BUFFER_SIZE = 900

/**
 * Ascending list of VialRGB effect IDs the virtual keyboard reports as
 * supported. Effect 0 (OFF) is always first; effect 1 (DIRECT) is
 * deliberately excluded, matching how vial-qmk keyboards commonly omit
 * DIRECT mode from the VIA UI. The remaining IDs are a representative
 * spread of real rgb_matrix/vialrgb effect indices — exact values only
 * matter for ascending order and GET_SUPPORTED pagination.
 */
export const VIALRGB_SUPPORTED_EFFECTS: readonly number[] = [
  0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
]

// Column indices that have a physical switch, per matrix row (derived from
// the KLE layout in vial.json — some rows have gaps for wider keys).
const ROW_COLS: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  [0, 1, 2, 4, 6, 7, 8, 9, 10, 11],
]

// Layer contents transcribed from keymaps/vial/keymap.c LAYOUT() calls.
// Plain identifiers use the canonical (non-alias) qmkId so `resolve()` can
// look them up directly; parenthesized function-call tokens (LT/LCTL/MO)
// go through `deserialize()`'s expression evaluator instead. Each row's
// token count matches ROW_COLS[row].length; XXXXXXX in the firmware
// source is KC_NO here.
const LAYER_TOKENS: readonly (readonly string[])[][] = [
  // Layer 0 — base
  [
    ['KC_ESCAPE', 'KC_1', 'KC_2', 'KC_3', 'KC_4', 'KC_5', 'KC_6', 'KC_7', 'KC_8', 'KC_9', 'KC_0', 'KC_MINUS', 'KC_EQUAL', 'KC_BSPACE'],
    ['KC_TAB', 'KC_Q', 'KC_W', 'KC_E', 'KC_R', 'KC_T', 'KC_Y', 'KC_U', 'KC_I', 'KC_O', 'KC_P', 'KC_LBRACKET', 'KC_RBRACKET', 'KC_BSLASH'],
    ['KC_LCTRL', 'KC_A', 'KC_S', 'KC_D', 'KC_F', 'KC_G', 'KC_H', 'KC_J', 'KC_K', 'KC_L', 'KC_SCOLON', 'KC_QUOTE', 'KC_ENTER'],
    ['KC_LSHIFT', 'KC_Z', 'KC_X', 'KC_C', 'KC_V', 'KC_B', 'KC_N', 'KC_M', 'KC_COMMA', 'KC_DOT', 'KC_SLASH', 'KC_RSHIFT'],
    ['LCTL(KC_SPACE)', 'KC_LGUI', 'KC_LALT', 'LT(1, KC_SPACE)', 'LT(1, KC_BSPACE)', 'KC_RALT', 'KC_RGUI', 'KC_APPLICATION', 'MO(1)', 'KC_DELETE'],
  ],
  // Layer 1 — Fn
  [
    ['KC_GRAVE', 'KC_F1', 'KC_F2', 'KC_F3', 'KC_F4', 'KC_F5', 'KC_F6', 'KC_F7', 'KC_F8', 'KC_F9', 'KC_F10', 'KC_F11', 'KC_F12', 'KC_NO'],
    ['KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO'],
    ['KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_LEFT', 'KC_DOWN', 'KC_UP', 'KC_RIGHT', 'KC_NO', 'KC_NO', 'KC_NO'],
    ['KC_LSHIFT', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_UP', 'KC_NO', 'KC_RSHIFT'],
    ['KC_NO', 'KC_NO', 'KC_NO', 'KC_LSHIFT', 'KC_LSHIFT', 'KC_LEFT', 'KC_DOWN', 'KC_RIGHT', 'KC_NO', 'MO(2)'],
  ],
  // Layer 2 — RGB / custom keycodes / boot
  [
    ['KC_NO', 'RGB_VAI', 'RGB_SAI', 'RGB_HUI', 'RGB_SPI', 'RGB_MOD', 'RGB_TOG', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'QK_CLEAR_EEPROM'],
    ['KC_NO', 'RGB_VAD', 'RGB_SAD', 'RGB_HUD', 'RGB_SPD', 'RGB_RMOD', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO'],
    ['USER00', 'USER01', 'USER02', 'USER03', 'USER04', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'QK_BOOT'],
    ['KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO'],
    ['KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO'],
  ],
  // Layer 3 — unused, all KC_NO
  [
    new Array<string>(14).fill('KC_NO'),
    new Array<string>(14).fill('KC_NO'),
    new Array<string>(13).fill('KC_NO'),
    new Array<string>(12).fill('KC_NO'),
    new Array<string>(10).fill('KC_NO'),
  ],
]

/**
 * Resolve a keymap.c token to its raw keycode value. Plain identifiers
 * (e.g. `KC_ESCAPE`) go straight through `resolve()`'s canonical lookup;
 * function-call tokens (e.g. `LT(1, KC_SPACE)`, `MO(1)`) are evaluated by
 * `deserialize()`'s expression parser, which resolves its own operands
 * internally and does not depend on keyboard-specific Keycode registration.
 */
function kc(token: string): number {
  return token.includes('(') ? deserialize(token) : resolve(token)
}

/** True for the QK_BOOT keycode — vial-qmk's vial_keycode_firewall() blocks writing this
 *  value into any dynamic store (keymap, tap dance, combo, key override, alt-repeat-key)
 *  while the board is locked. */
export function isBootKeycode(keycode: number): boolean {
  setProtocolValue(VIAL_PROTOCOL)
  return keycode === resolve('QK_BOOT')
}

/** Build the flat 4x5x14 keymap (layer-major, row-major, col order) as raw BE16-ready keycode values. */
export function buildDefaultKeymap(): Uint16Array {
  setProtocolValue(VIAL_PROTOCOL)
  const keymap = new Uint16Array(LAYERS * ROWS * COLS)

  for (let layer = 0; layer < LAYERS; layer++) {
    for (let row = 0; row < ROWS; row++) {
      const cols = ROW_COLS[row]
      const tokens = LAYER_TOKENS[layer][row]
      for (let i = 0; i < cols.length; i++) {
        const index = (layer * ROWS + row) * COLS + cols[i]
        keymap[index] = kc(tokens[i])
      }
    }
  }

  return keymap
}

/**
 * Build a sample macro buffer: macro 0 is a plain text macro ("Hello"),
 * macro 1 is a single tap-KC_A action in Vial v2 (SS_QMK_PREFIX-escaped)
 * format. Remaining macro slots are empty. Total length is always
 * MACRO_BUFFER_SIZE, zero-padded.
 */
export function buildDefaultMacroBuffer(): Uint8Array {
  setProtocolValue(VIAL_PROTOCOL)
  const buffer = new Uint8Array(MACRO_BUFFER_SIZE)
  let offset = 0

  for (const ch of 'Hello') {
    buffer[offset++] = ch.charCodeAt(0)
  }
  buffer[offset++] = 0x00 // macro 0 terminator

  const kcA = resolve('KC_A') & 0xff
  buffer[offset++] = SS_QMK_PREFIX
  buffer[offset++] = SS_TAP_CODE
  buffer[offset++] = kcA
  buffer[offset++] = 0x00 // macro 1 terminator

  return buffer
}

/**
 * Sample dynamic entries seeded at index 0 of each store so the doc
 * screenshots (and a fresh app run) show a configured tile instead of an
 * empty one, mirroring how buildDefaultMacroBuffer() seeds sample macros.
 */
export function buildSampleTapDance(): TapDanceEntry {
  setProtocolValue(VIAL_PROTOCOL)
  return {
    onTap: resolve('KC_A'),
    onHold: resolve('KC_LCTRL'),
    onDoubleTap: 0,
    onTapHold: 0,
    tappingTerm: 200,
  }
}

export function buildSampleCombo(): ComboEntry {
  setProtocolValue(VIAL_PROTOCOL)
  return { key1: resolve('KC_J'), key2: resolve('KC_K'), key3: 0, key4: 0, output: resolve('KC_ESCAPE') }
}

export function buildSampleKeyOverride(): KeyOverrideEntry {
  setProtocolValue(VIAL_PROTOCOL)
  const shift = resolve('MOD_LSFT')
  return {
    triggerKey: resolve('KC_BSPACE'),
    replacementKey: resolve('KC_DELETE'),
    layers: 0xffff,
    triggerMods: shift,
    negativeMods: 0,
    suppressedMods: shift,
    options: 0x07, // trigger-down + required-mod-down + negative-mod-up activation
    enabled: true,
  }
}

export function buildSampleAltRepeatKey(): AltRepeatKeyEntry {
  setProtocolValue(VIAL_PROTOCOL)
  return { lastKey: resolve('KC_C'), altKey: resolve('KC_V'), allowedMods: 0, options: 0, enabled: true }
}

function compressLzma(text: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    try {
      lzmaModule.compress(text, 1, (result: number[] | null, error?: unknown) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
          return
        }
        if (result == null) {
          reject(new Error('LZMA compression produced no output'))
          return
        }
        // lzma.compress yields a plain array of signed bytes (-128..127).
        const bytes = new Uint8Array(result.length)
        for (let i = 0; i < result.length; i++) {
          bytes[i] = result[i] & 0xff
        }
        resolve(bytes)
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

let cachedCompressedDefinition: Uint8Array | null = null

/** Lazily compress the JSON keyboard definition (LZMA), caching the result. */
export async function getCompressedDefinition(): Promise<Uint8Array> {
  if (cachedCompressedDefinition) return cachedCompressedDefinition
  const json = JSON.stringify(definitionJson)
  cachedCompressedDefinition = await compressLzma(json)
  return cachedCompressedDefinition
}
