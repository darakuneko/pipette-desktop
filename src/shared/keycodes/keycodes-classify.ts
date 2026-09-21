// SPDX-License-Identifier: GPL-2.0-or-later
// Pattern-based QMK id classification: layer-op target parsing
// (getLayerOpTarget) and the Analyze ranking filter's high-level groups
// (keycodeGroup). Depends on no state from keycodes.ts/keycodes-utils.ts
// (no RAWCODES_MAP, no live keyboard registration), so it stays correct
// for a snapshot viewer's composites too.

// LT/LM write the layer digit directly after the op (`LT1(kc)`); MO-family
// ops put the layer inside parens (`MO(1)`) and carry no inner keycode.
// Exported (not module-private) only so `resolveSnapshotLabel`
// (keycodes-utils.ts) can share the same two patterns.
export const LAYER_MASK_RE = /^(LT|LM)(\d+)(?:\((.+)\))?$/
export const LAYER_SINGLE_RE = /^(MO|DF|PDF|TG|TT|OSL|TO)\((\d+)\)$/

export type KeycodeGroup = 'modifier' | 'char' | 'layerOp' | 'other'

const LAYER_OP_PREFIX_RE = /^(LT|LM|MO|DF|PDF|TG|TT|OSL|TO)[\d(]/
const MOD_MASK_PREFIX_RE =
  /^(LCTL|LSFT|LALT|LGUI|RCTL|RSFT|RALT|RGUI|HYPR|MEH|LCA|LSA|LCG|LSG|LAG|ALL|LCAG|LSAG|RCA|RCSG|RCAG|RSAG|RHYPR|RMEH|RALL)(_T)?\(/
const MOD_BASIC_RE = /^KC_[LR](CTL|SFT|ALT|GUI|SHIFT|CTRL)$/
const CHAR_LETTER_RE = /^KC_[A-Z]$/
const CHAR_DIGIT_RE = /^KC_\d$/
const CHAR_F_RE = /^KC_F\d{1,2}$/
const CHAR_SYMBOL_RE =
  /^KC_(GRV|MINS|EQL|LBRC|RBRC|BSLS|SCLN|QUOT|COMM|DOT|SLSH|NUHS|NUBS|TILD|UNDS|PLUS|LCBR|RCBR|PIPE|COLN|DQUO|LABK|RABK|QUES|EXLM|AT|HASH|DLR|PERC|CIRC|AMPR|ASTR|LPRN|RPRN)$/
const CHAR_EDIT_RE =
  /^KC_(ENT|ENTER|ESC|ESCAPE|BSPC|BSPACE|TAB|SPC|SPACE|DEL|DELETE|INS|INSERT)$/
const CHAR_NAV_RE =
  /^KC_(HOME|END|PGUP|PGDN|PAGEUP|PAGEDOWN|UP|DOWN|LEFT|RIGHT|RGHT|DN)$/
const CHAR_LOCK_APP_RE =
  /^KC_(CAPS|CAPSLOCK|NLCK|SLCK|SCROLL|NUMLOCK|SCROLLLOCK|APP|APPLICATION|MENU|PSCR|PRINT|PAUSE|PAUS|BREAK|BRK)$/
const CHAR_NUMPAD_RE = /^KC_P[A-Z0-9_]+$/
const CHAR_INTL_RE = /^KC_(JPN|INT|LANG|KANA|RO)/

export interface LayerOpTarget {
  /** Target layer index encoded in the op (e.g. `3` for `MO(3)` or `LT3(KC_A)`). */
  layer: number
  /** How many times the op activates the target layer per recorded press.
   * `'press'` — every press activates (MO / TG / TO / DF / PDF / OSL / TT).
   * `'hold'` — only the hold arm activates; taps go to the inner keycode
   * without touching the layer stack (LT / LM). */
  kind: 'press' | 'hold'
}

/** Parse a serialized layer-op QMK id and return the target layer index
 * plus which press category (full count vs. hold-only) contributes to
 * "the user activated that layer". Returns `null` for anything that
 * isn't a layer op. Purely pattern-based so it works without relying
 * on `RAWCODES_MAP` (keycodes.ts) / `recreateKeycodes()`
 * (keycodes-utils.ts) state. */
export function getLayerOpTarget(qmkId: string): LayerOpTarget | null {
  if (!qmkId) return null
  const mask = qmkId.match(LAYER_MASK_RE)
  if (mask) {
    const layer = Number.parseInt(mask[2], 10)
    if (!Number.isFinite(layer) || layer < 0) return null
    return { layer, kind: 'hold' }
  }
  const single = qmkId.match(LAYER_SINGLE_RE)
  if (single) {
    const layer = Number.parseInt(single[2], 10)
    if (!Number.isFinite(layer) || layer < 0) return null
    return { layer, kind: 'press' }
  }
  return null
}

/** Classify a QMK id into one of the high-level groups the Analyze
 *  ranking filter offers. Pattern-based so it works without depending on
 *  the current keyboard registration (snapshot viewer may see composites
 *  that `findOuterKeycode` (keycodes-utils.ts) doesn't know about).
 *  Unknowns land in `other`. */
export function keycodeGroup(qmkId: string): KeycodeGroup {
  if (!qmkId || qmkId === 'KC_NO' || qmkId === 'KC_TRNS' || qmkId === 'KC_TRANS') return 'other'
  if (LAYER_OP_PREFIX_RE.test(qmkId)) return 'layerOp'
  if (qmkId === 'QK_LAYER_LOCK' || /^FN_MO/.test(qmkId)) return 'layerOp'
  if (MOD_MASK_PREFIX_RE.test(qmkId)) return 'modifier'
  if (/^OSM\(/.test(qmkId)) return 'modifier'
  if (MOD_BASIC_RE.test(qmkId)) return 'modifier'
  if (CHAR_LETTER_RE.test(qmkId)) return 'char'
  if (CHAR_DIGIT_RE.test(qmkId)) return 'char'
  if (CHAR_F_RE.test(qmkId)) return 'char'
  if (CHAR_SYMBOL_RE.test(qmkId)) return 'char'
  if (CHAR_EDIT_RE.test(qmkId)) return 'char'
  if (CHAR_NAV_RE.test(qmkId)) return 'char'
  if (CHAR_LOCK_APP_RE.test(qmkId)) return 'char'
  if (CHAR_NUMPAD_RE.test(qmkId)) return 'char'
  if (CHAR_INTL_RE.test(qmkId)) return 'char'
  return 'other'
}
