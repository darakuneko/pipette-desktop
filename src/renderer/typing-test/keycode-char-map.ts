// SPDX-License-Identifier: GPL-2.0-or-later

import { serialize, findByQmkId, isLMKeycode } from '../../shared/keycodes/keycodes'

export type CharResult =
  | { kind: 'char'; char: string }
  | { kind: 'action'; action: 'space' | 'backspace' }
  | null

const SPECIAL_ACTIONS: Record<string, 'space' | 'backspace'> = {
  KC_SPACE: 'space',
  KC_SPC: 'space',
  KC_ENTER: 'space',
  KC_ENT: 'space',
  KC_BSPACE: 'backspace',
  KC_BSPC: 'backspace',
}

const SHIFT_QMKIDS = new Set(['KC_LSHIFT', 'KC_LSFT', 'KC_RSHIFT', 'KC_RSFT'])

/** US ANSI layout: unshifted → shifted mapping for non-letter keys. */
const SHIFT_MAP: Record<string, string> = {
  '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
  '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
  '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|',
  ';': ':', "'": '"', '`': '~', ',': '<', '.': '>', '/': '?',
}

/** Check whether a keycode is a shift modifier. */
export function isShiftKeycode(code: number): boolean {
  const qmkId = serialize(code)
  return qmkId !== null && SHIFT_QMKIDS.has(qmkId)
}

function applyShift(char: string): string {
  // Letters: uppercase
  if (char >= 'a' && char <= 'z') return char.toUpperCase()
  // Symbols/numbers: lookup shifted equivalent
  return SHIFT_MAP[char] ?? char
}

function resolveCode(code: number, shifted: boolean): CharResult {
  const qmkId = serialize(code)
  if (!qmkId) return null

  const action = SPECIAL_ACTIONS[qmkId]
  if (action) return { kind: 'action', action }

  const kc = findByQmkId(qmkId)
  if (kc?.printable) {
    const char = shifted ? applyShift(kc.printable) : kc.printable
    return { kind: 'char', char }
  }

  return null
}

/** Extract layer number from an MO keycode, or null if not MO.
 * Works for both v5 (0x5100+layer) and v6 (0x5220+layer). */
export function extractMOLayer(code: number): number | null {
  const base = code & 0xffe0
  if (base === 0x5100 || base === 0x5220) return code & 0x1f
  return null
}

/** Extract layer number from an LT keycode, or null if not LT. */
export function extractLTLayer(code: number): number | null {
  // LT range: 0x4000–0x4FFF (both v5 and v6)
  if ((code & 0xf000) !== 0x4000) return null
  return (code >> 8) & 0x0f
}

/** Extract layer number from an LM keycode, or null if not LM.
 * Uses serialize() for protocol-aware detection since LM bit layout
 * differs between v5 and v6 and is not directly exposed. */
export function extractLMLayer(code: number): number | null {
  if (!isLMKeycode(code)) return null
  const qmkId = serialize(code)
  const match = qmkId.match(/^LM(\d+)\(/)
  return match ? Number(match[1]) : null
}

/** Check whether a code falls in the LT or MT keycode ranges (v5 & v6). */
function isTapKeycode(code: number): boolean {
  // LT (Layer Tap): 0x4000–0x4FFF (both v5 and v6)
  if ((code & 0xf000) === 0x4000) return true
  // MT (Mod Tap) v6: 0x2000–0x3FFF
  if ((code & 0xe000) === 0x2000) return true
  // MT (Mod Tap) v5: 0x6000–0x7FFF
  if ((code & 0xe000) === 0x6000) return true
  return false
}

export function resolveCharFromMatrix(
  row: number,
  col: number,
  keymap: Map<string, number>,
  layer: number = 0,
  shifted: boolean = false,
): CharResult {
  const code = keymap.get(`${layer},${row},${col}`)
  if (code == null) return null

  // Try resolving the full keycode first (handles basic keycodes)
  const result = resolveCode(code, shifted)
  if (result) return result

  // For LT/MT keycodes, extract the inner keycode from the low byte
  // and try again. Only apply to known tap-key ranges to avoid
  // false positives for TD, TT, LM, etc.
  if (isTapKeycode(code)) {
    const inner = code & 0xff
    if (inner !== 0) {
      return resolveCode(inner, shifted)
    }
  }

  return null
}
