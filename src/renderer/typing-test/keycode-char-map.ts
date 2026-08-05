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

/** Check whether a code falls in the LT or MT keycode ranges (v5 & v6).
 * Exported so the typing-view tap/hold detector can distinguish LT/MT
 * presses (which need release-edge-or-deadline timing to classify as
 * tap vs hold) from non-tap masked keys like LSFT(kc) that fire together
 * without a tap/hold ambiguity. */
export function isTapKeycode(code: number): boolean {
  // LT (Layer Tap): 0x4000–0x4FFF (both v5 and v6)
  if ((code & 0xf000) === 0x4000) return true
  // MT (Mod Tap) v6: 0x2000–0x3FFF
  if ((code & 0xe000) === 0x2000) return true
  // MT (Mod Tap) v5: 0x6000–0x7FFF
  if ((code & 0xe000) === 0x6000) return true
  return false
}

const ENTER_QMKIDS = new Set(['KC_ENTER', 'KC_ENT'])

/** Shared resolution cascade for both `resolveCharFromMatrix` (a live
 * row/col + keymap lookup) and `producesChar` (an already-resolved
 * keycode, e.g. off a queued/emitted analytics event): try the code
 * directly first (handles basic keycodes), then — for LT/MT tap-hold
 * ranges only, to avoid false positives for TD/TT/LM/etc — fall back to
 * the inner keycode extracted from the low byte. */
function resolveCodeWithTapFallback(code: number, shifted: boolean): CharResult {
  const direct = resolveCode(code, shifted)
  if (direct) return direct
  if (isTapKeycode(code)) {
    const inner = code & 0xff
    if (inner !== 0) return resolveCode(inner, shifted)
  }
  return null
}

/** Whether a resolved keycode can ever produce a character — the same
 * resolution `resolveCharFromMatrix` performs internally, exposed for a
 * caller that already has the effective keycode rather than a live
 * row/col + keymap to look it up from. Used by run-log-recorder.ts to
 * decide whether a matrix keystroke can ever be joined against a later
 * DOM `char` event, so a key that will never produce one (a bare
 * modifier, a layer key) isn't left permanently queued for a
 * confirmation that will never arrive.
 *
 * Enter is deliberately excluded even though `SPECIAL_ACTIONS` maps it
 * to the same 'space' action as literal Space: Space's DOM `key` is
 * `' '` (length 1, passes the char-event gate in
 * useTypingTest.processKeyEvent), but Enter's DOM `key` is `'Enter'`
 * (length 5, never passes it) — so Enter never actually produces a
 * `char` event despite resolving to an action here. Unshifted only —
 * its only caller (the run-log recorder) has no notion of shift state
 * for a matrix press and only ever needs the yes/no answer.
 *
 * Mode-agnostic by design: kana mode ADDITIONALLY treats a handful of
 * JIS-specific keycodes as char-producing while it's active, but that is
 * a kana-input.ts concern (see `isKanaPhysicalPositionKeycode` there) —
 * this function doesn't know about input methods, only about whether
 * `resolveCode`'s printable-character domain covers `code`. */
export function producesChar(code: number): boolean {
  const qmkId = serialize(code)
  if (qmkId && ENTER_QMKIDS.has(qmkId)) return false
  return resolveCodeWithTapFallback(code, false) !== null
}

/** Resolve a char/action directly from an already-effective keycode,
 * without a live row/col + keymap + layer lookup — used by
 * word-timeline.ts, whose `RunKeystroke.keycode` is already the resolved
 * matrix keycode captured at press time (see `RunKeystrokeLog`'s module
 * doc comment), so there is no keymap/layer to look it up from. Same
 * resolution cascade as `resolveCharFromMatrix`, minus the keymap step.
 * Unshifted only — its only caller has no notion of shift state for a
 * captured matrix keystroke (the run log never records one), so a
 * `shifted` parameter would be permanently unreachable dead code. */
export function resolveCharFromKeycode(code: number): CharResult {
  return resolveCodeWithTapFallback(code, false)
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
  return resolveCodeWithTapFallback(code, shifted)
}
