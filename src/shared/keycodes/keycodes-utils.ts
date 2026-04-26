// SPDX-License-Identifier: GPL-2.0-or-later
// Logic / utility functions extracted from keycodes.ts

import { keycodesV5 } from './keycodes-v5'
import { keycodesV6 } from './keycodes-v6'
import type { CustomKeycodeDefinition, KeyboardKeycodeContext } from './keycodes-types'
import {
  Keycode,
  KEYCODES,
  KEYCODES_MAP,
  RAWCODES_MAP,
  KEYCODES_SPECIAL,
  KEYCODES_BASIC,
  KEYCODES_SHIFTED,
  KEYCODES_ISO,
  KEYCODES_INTERNATIONAL,
  KEYCODES_LANGUAGE,
  KEYCODES_JIS,
  KEYCODES_LAYERS,
  KEYCODES_BOOT,
  KEYCODES_MODIFIERS,
  KEYCODES_BEHAVIOR,
  KEYCODES_LIGHTING,
  KEYCODES_SYSTEM,
  KEYCODES_TAP_DANCE,
  KEYCODES_MACRO,
  KEYCODES_MACRO_M,
  KEYCODES_MACRO_BASE,
  KEYCODES_USER,
  KEYCODES_HIDDEN,
  KEYCODES_MIDI,
  KEYCODES_MIDI_BASIC,
  KEYCODES_MIDI_ADVANCED,
  KEYCODES_LM_MODS,
  KEYCODES_LAYERS_SPECIAL,
  KEYCODES_LAYERS_MO,
  KEYCODES_LAYERS_DF,
  KEYCODES_LAYERS_PDF,
  KEYCODES_LAYERS_TG,
  KEYCODES_LAYERS_TT,
  KEYCODES_LAYERS_OSL,
  KEYCODES_LAYERS_TO,
  KEYCODES_LAYERS_LT,
  KEYCODES_LAYERS_LM,
  RESET_KEYCODE,
  qmkIdToKeycode,
  maskedKeycodes,
  recorderAliasToKeycode,
  getProtocolValue,
  setProtocolValue,
  setKeycodeLayersSpecial,
  setKeycodeLayersMO,
  setKeycodeLayersDF,
  setKeycodeLayersPDF,
  setKeycodeLayersTG,
  setKeycodeLayersTT,
  setKeycodeLayersOSL,
  setKeycodeLayersTO,
  setKeycodeLayersLT,
  setKeycodeLayersLM,
  setKeycodeLayers,
  setKeycodeMacroM,
  setKeycodeMacro,
  setKeycodeTapDance,
  setKeycodeUser,
  setKeycodeMidi,
} from './keycodes'
import { decodeAnyKeycode } from './keycodes-any-keycode'

// Re-export for backward compatibility
export { decodeAnyKeycode } from './keycodes-any-keycode'

// --- resolve helper ---

export function resolve(qmkConstant: string): number {
  const protocol = getProtocolValue()
  const kcMap = protocol === 6 ? keycodesV6.kc : keycodesV5.kc
  if (!(qmkConstant in kcMap)) {
    throw new Error(`unable to resolve qmk_id=${qmkConstant}`)
  }
  return kcMap[qmkConstant]
}

// --- LM (Layer Mod) helpers ---

interface LMConfig {
  base: number
  shift: number
  modMask: number
  maxCode: number
}

function getLMConfig(): LMConfig {
  const protocol = getProtocolValue()
  const kcMap = protocol === 6 ? keycodesV6.kc : keycodesV5.kc
  const base = kcMap.QK_LAYER_MOD
  const shift = kcMap.QMK_LM_SHIFT
  const modMask = kcMap.QMK_LM_MASK
  return { base, shift, modMask, maxCode: base | (0x0f << shift) | modMask }
}

// Reverse map: mod numeric value -> MOD_* qmkId (built lazily per protocol)
let lmModValueMap: Map<number, string> | null = null
function getLMModValueMap(): Map<number, string> {
  if (lmModValueMap) return lmModValueMap
  lmModValueMap = new Map<number, string>()
  for (const kc of KEYCODES_LM_MODS) {
    lmModValueMap.set(resolve(kc.qmkId), kc.qmkId)
  }
  return lmModValueMap
}

/**
 * Returns MOD_* keycodes that can round-trip through the current protocol's
 * LM encoding.  In v5 the mod field is only 4 bits wide (mask 0x0f), so
 * right-side modifiers (MOD_RCTL=0x11, etc.) whose values exceed the mask
 * are excluded to prevent silent data loss.
 */
export function getAvailableLMMods(): Keycode[] {
  const modMask = resolve('QMK_LM_MASK')
  return KEYCODES_LM_MODS.filter((kc) => (resolve(kc.qmkId) & ~modMask) === 0)
}

function serializeLM(code: number): string | null {
  const { base, shift, modMask, maxCode } = getLMConfig()
  if (code < base || code > maxCode) return null

  const layer = (code >> shift) & 0x0f
  const mod = code & modMask
  const modName = getLMModValueMap().get(mod)
  if (modName) return `LM${layer}(${modName})`
  return `LM${layer}(${toHex(mod)})`
}

export function isLMKeycode(code: number): boolean {
  const { base, maxCode } = getLMConfig()
  return code >= base && code <= maxCode
}

// --- Serialize / Deserialize ---

function toHex(code: number): string {
  return '0x' + code.toString(16)
}

/** Shared serialization logic. getName controls how a Keycode is stringified. */
function serializeInternal(
  code: number,
  getName: (kc: Keycode) => string,
): string {
  // LM needs custom handling before standard masked path
  const lmResult = serializeLM(code)
  if (lmResult) return lmResult

  const protocol = getProtocolValue()
  const masked = protocol === 6 ? keycodesV6.masked : keycodesV5.masked

  if (!masked.has(code & 0xff00)) {
    const kc = RAWCODES_MAP.get(code)
    if (kc !== undefined) {
      return getName(kc)
    }
  } else {
    const outer = RAWCODES_MAP.get(code & 0xff00)
    const inner = RAWCODES_MAP.get(code & 0x00ff)
    if (outer !== undefined && inner !== undefined) {
      return getName(outer).replace('kc', getName(inner))
    }
    const kc = RAWCODES_MAP.get(code)
    if (kc !== undefined) {
      return getName(kc)
    }
    // Outer wasn't populated by recreateKeyboardKeycodes (e.g. the
    // Analyze view rendered before the keyboard's layer-count-driven
    // LT/LM Keycode objects were built). The protocol mask layout is
    // still known statically, so fall back to the template qmkId
    // (`LT1(kc)` → `LT1(KC_SPACE)`) instead of the bare hex.
    const protocolMap = protocol === 6 ? keycodesV6 : keycodesV5
    const template = protocolMap.maskedTemplates.get(code & 0xff00)
    if (template !== undefined) {
      const innerName = inner !== undefined ? getName(inner) : toHex(code & 0x00ff)
      return template.replace('kc', innerName)
    }
  }
  return toHex(code)
}

function qmkName(kc: Keycode): string {
  return kc.qmkId
}

export function serialize(code: number): string {
  return serializeInternal(code, qmkName)
}

// Outer mask qmkIds not defined in vial-qmk (cannot compile in keymap.c)
const NOT_IN_VIAL_QMK_OUTER_MASKS = new Set([
  // Modifier Masks (8)
  'LCSG(kc)', 'LSAG(kc)',
  'RCA(kc)', 'RMEH(kc)',
  'RCSG(kc)', 'RCAG(kc)', 'RSAG(kc)', 'RHYPR(kc)',
  // Mod-Tap (8)
  'LCSG_T(kc)', 'LSAG_T(kc)',
  'RCA_T(kc)', 'RCSG_T(kc)', 'RSAG_T(kc)',
  'RMEH_T(kc)', 'RALL_T(kc)', 'RCAG_T(kc)',
])

function cExportName(kc: Keycode): string {
  return kc.cExportId ?? kc.qmkId
}

export function serializeForCExport(code: number): string {
  if (isLMKeycode(code)) return toHex(code)

  const protocol = getProtocolValue()
  const masked = protocol === 6 ? keycodesV6.masked : keycodesV5.masked

  if (masked.has(code & 0xff00)) {
    const outer = RAWCODES_MAP.get(code & 0xff00)
    if (outer !== undefined && NOT_IN_VIAL_QMK_OUTER_MASKS.has(outer.qmkId)) {
      return toHex(code)
    }
  }

  return serializeInternal(code, cExportName)
}

export function deserialize(val: string | number): number {
  if (typeof val === 'number') return val
  const kc = qmkIdToKeycode.get(val)
  if (kc !== undefined) {
    return resolve(kc.qmkId)
  }
  return decodeAnyKeycode(val)
}

export function normalize(code: string): string {
  return serialize(deserialize(code))
}

// --- isMask helper ---

export function isMask(qmkId: string): boolean {
  const parenIdx = qmkId.indexOf('(')
  if (parenIdx === -1) return false
  return maskedKeycodes.has(qmkId.substring(0, parenIdx))
}

export function isBasic(qmkId: string): boolean {
  return deserialize(qmkId) < 0x00ff
}

// --- Modifier mask helpers ---

/** Returns true when the keycode is in the modifier-mask+basic range (0x0100-0x1FFF). */
export function isModMaskKeycode(code: number): boolean {
  return code >= 0x0100 && code <= 0x1fff
}

/** Returns true when the keycode is a basic key (0x0000-0x00FF) or modifier-mask+basic (0x0100-0x1FFF). */
export function isModifiableKeycode(code: number): boolean {
  return code >= 0 && code <= 0x1fff
}

/** Extracts the 5-bit modifier mask from bits 8-12. */
export function extractModMask(code: number): number {
  return (code >> 8) & 0x1f
}

/** Extracts the basic key portion (bits 0-7). */
export function extractBasicKey(code: number): number {
  return code & 0xff
}

/** Combines a 5-bit modifier mask with a basic keycode. Returns the basic key if mask is 0. */
export function buildModMaskKeycode(modMask: number, basicKey: number): number {
  if (modMask === 0) return basicKey & 0xff
  return ((modMask & 0x1f) << 8) | (basicKey & 0xff)
}

// --- Mod-Tap helpers ---

/** Returns true when the keycode is in the Mod-Tap range. */
export function isModTapKeycode(code: number): boolean {
  const base = resolve('QK_MOD_TAP')
  return code >= base && code < base + 0x2000
}

/** Combines a 5-bit modifier mask with a basic keycode into a Mod-Tap keycode. Returns the basic key if mask is 0. */
export function buildModTapKeycode(modMask: number, basicKey: number): number {
  if (modMask === 0) return basicKey & 0xff
  const base = resolve('QK_MOD_TAP')
  return base | ((modMask & 0x1f) << 8) | (basicKey & 0xff)
}

// --- LT (Layer-Tap) helpers ---

/** Returns true when the keycode is in the Layer-Tap range (QK_LAYER_TAP to QK_LAYER_TAP + 0x0FFF). */
export function isLTKeycode(code: number): boolean {
  const base = resolve('QK_LAYER_TAP')
  return code >= base && code < base + 0x1000
}

/** Extracts the layer number (0-15) from a Layer-Tap keycode. */
export function extractLTLayer(code: number): number {
  return (code >> 8) & 0x0f
}

/** Combines a layer number (0-15) with a basic keycode into a Layer-Tap keycode. */
export function buildLTKeycode(layer: number, basicKey: number): number {
  return resolve('QK_LAYER_TAP') | ((layer & 0x0f) << 8) | (basicKey & 0xff)
}

// --- SH_T (Swap Hands Tap) helpers ---

/** Returns true when the keycode is in the Swap Hands Tap range. */
export function isSHTKeycode(code: number): boolean {
  const base = resolve('SH_T(kc)')
  return code >= base && code <= base + 0xef
}

/** Combines a basic keycode into a Swap Hands Tap keycode. */
export function buildSHTKeycode(basicKey: number): number {
  return resolve('SH_T(kc)') | (basicKey & 0xff)
}

// --- LM additional helpers (isLMKeycode is already exported) ---

/** Extracts the layer number (0-15) from a Layer-Mod keycode. */
export function extractLMLayer(code: number): number {
  const { shift } = getLMConfig()
  return (code >> shift) & 0x0f
}

/** Extracts the modifier mask from a Layer-Mod keycode. */
export function extractLMMod(code: number): number {
  const { modMask } = getLMConfig()
  return code & modMask
}

/** Combines a layer number (0-15) with a modifier mask into a Layer-Mod keycode. */
export function buildLMKeycode(layer: number, mod: number): number {
  const { base, shift, modMask } = getLMConfig()
  return base | ((layer & 0x0f) << shift) | (mod & modMask)
}

// --- Tap Dance helpers ---

export function isTapDanceKeycode(code: number): boolean {
  return (code & 0xff00) === 0x5700
}

export function getTapDanceIndex(code: number): number {
  return code & 0xff
}

// --- Reset keycode helper ---

/**
 * Check whether a raw keycode is QK_BOOT (the bootloader reset keycode).
 * The numeric value differs between protocol v5 (0x5c00) and v6 (0x7c00),
 * so we go through serialize() to get the version-agnostic qmkId string.
 */
export function isResetKeycode(code: number): boolean {
  return serialize(code) === RESET_KEYCODE
}

// --- Macro helpers ---

/**
 * Check whether a raw keycode is a macro keycode (M0-M255).
 * Unlike tap dance, the macro base address differs between protocol versions,
 * so we go through serialize() to get the version-agnostic qmkId string.
 */
export function isMacroKeycode(code: number): boolean {
  return /^M\d+$/.test(serialize(code))
}

export function getMacroIndex(code: number): number {
  const match = /^M(\d+)$/.exec(serialize(code))
  return match ? Number(match[1]) : -1
}

export function findKeycode(qmkId: string): Keycode | undefined {
  if (qmkId === 'kc') qmkId = 'KC_NO'
  return KEYCODES_MAP.get(qmkId)
}

let LABEL_MAP: Map<string, Keycode> | null = null

/** Reverse-lookup: find a keycode whose label exactly matches the given string */
export function findKeycodeByLabel(label: string): Keycode | undefined {
  if (!LABEL_MAP) {
    LABEL_MAP = new Map()
    // Last-write-wins: KEYCODES_SHIFTED (loaded after numpad) takes priority
    // so e.g. '+' resolves to KC_PLUS rather than KC_KP_PLUS
    for (const kc of KEYCODES) {
      LABEL_MAP.set(kc.label, kc)
    }
  }
  return LABEL_MAP.get(label)
}

export function findOuterKeycode(qmkId: string): Keycode | undefined {
  if (isMask(qmkId)) {
    qmkId = qmkId.substring(0, qmkId.indexOf('('))
  }
  return findKeycode(qmkId)
}

export function findInnerKeycode(qmkId: string): Keycode | undefined {
  if (isMask(qmkId)) {
    qmkId = qmkId.substring(qmkId.indexOf('(') + 1, qmkId.length - 1)
  }
  return findKeycode(qmkId)
}

export function findByRecorderAlias(alias: string): Keycode | undefined {
  return recorderAliasToKeycode.get(alias)
}

export function findByQmkId(qmkId: string): Keycode | undefined {
  return qmkIdToKeycode.get(qmkId)
}

export function keycodeLabel(qmkId: string): string {
  const kc = findOuterKeycode(qmkId)
  return kc?.label ?? qmkId
}

/** Short human-readable label for a raw keycode value.
 *  For masked keycodes (e.g. LT, MT) returns the full serialized form with KC_/QK_ prefixes stripped.
 *  For simple keycodes returns the compact label (e.g. "A", "Enter"). */
export function codeToLabel(code: number): string {
  const qmkId = serialize(code)
  if (isMask(qmkId)) return qmkId.replace(/KC_|QK_|RGB_|BL_/g, '')
  return keycodeLabel(qmkId).replaceAll('\n', ' ')
}

export function keycodeTooltip(qmkId: string): string | undefined {
  const kc = findOuterKeycode(qmkId)
  if (kc === undefined) return undefined
  if (kc.tooltip) return `${kc.qmkId}: ${kc.tooltip}`
  return kc.qmkId
}

// LT/LM write the layer digit directly after the op (`LT1(kc)`); MO-family
// ops put the layer inside parens (`MO(1)`) and carry no inner keycode.
const LAYER_MASK_RE = /^(LT|LM)(\d+)(?:\((.+)\))?$/
const LAYER_SINGLE_RE = /^(MO|DF|PDF|TG|TT|OSL|TO)\((\d+)\)$/

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
 * on `RAWCODES_MAP` / `recreateKeycodes()` state. */
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
 *  that `findOuterKeycode` doesn't know about). Unknowns land in `other`. */
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

/** Resolve display labels for a serialized QMK id without depending on
 *  the current `recreateKeyboardKeycodes` state. Falls back to standalone
 *  pattern matching when the live registration does not cover the
 *  composite, so snapshot viewers render pretty labels even for layer
 *  counts the connected keyboard hasn't registered. */
export function resolveSnapshotLabel(
  qmkId: string,
): { outer: string; inner: string; masked: boolean } {
  if (!qmkId) return { outer: '', inner: '', masked: false }

  const outerKc = findOuterKeycode(qmkId)
  if (outerKc) {
    if (isMask(qmkId)) {
      const innerKc = findInnerKeycode(qmkId)
      return {
        outer: outerKc.label.replace(/\n?\(kc\)$/, ''),
        inner: innerKc?.label ?? '',
        masked: true,
      }
    }
    return { outer: outerKc.label, inner: '', masked: false }
  }

  const layerMask = qmkId.match(LAYER_MASK_RE)
  if (layerMask) {
    const [, op, lyr, inner] = layerMask
    const outer = `${op} ${lyr}`
    if (inner !== undefined) {
      const innerKc = findKeycode(inner)
      return { outer, inner: innerKc?.label ?? inner, masked: true }
    }
    return { outer, inner: '', masked: false }
  }

  const layerSingle = qmkId.match(LAYER_SINGLE_RE)
  if (layerSingle) {
    const [, op, lyr] = layerSingle
    return { outer: `${op}(${lyr})`, inner: '', masked: false }
  }

  const parenIdx = qmkId.indexOf('(')
  if (parenIdx > 0 && qmkId.endsWith(')')) {
    const op = qmkId.substring(0, parenIdx)
    const inner = qmkId.substring(parenIdx + 1, qmkId.length - 1)
    const innerKc = findKeycode(inner)
    return { outer: op, inner: innerKc?.label ?? inner, masked: true }
  }

  return { outer: qmkId, inner: '', masked: false }
}


// --- Recreate keycodes ---

let keycodeRevision = 0
export function getKeycodeRevision(): number {
  return keycodeRevision
}

export function recreateKeycodes(): void {
  keycodeRevision++
  KEYCODES.length = 0
  KEYCODES.push(
    ...KEYCODES_SPECIAL,
    ...KEYCODES_BASIC,
    ...KEYCODES_SHIFTED,
    ...KEYCODES_ISO,
    ...KEYCODES_INTERNATIONAL,
    ...KEYCODES_LANGUAGE,
    ...KEYCODES_JIS,
    ...KEYCODES_LAYERS,
    ...KEYCODES_BOOT,
    ...KEYCODES_MODIFIERS,
    ...KEYCODES_BEHAVIOR,
    ...KEYCODES_LIGHTING,
    ...KEYCODES_SYSTEM,
    ...KEYCODES_TAP_DANCE,
    ...KEYCODES_MACRO,
    ...KEYCODES_USER,
    ...KEYCODES_HIDDEN,
    ...KEYCODES_MIDI,
  )
  KEYCODES_MAP.clear()
  RAWCODES_MAP.clear()
  LABEL_MAP = null
  for (const keycode of KEYCODES) {
    KEYCODES_MAP.set(keycode.qmkId.replace('(kc)', ''), keycode)
    RAWCODES_MAP.set(deserialize(keycode.qmkId), keycode)
  }
  // Add MOD_* entries to KEYCODES_MAP for LM inner display (not to RAWCODES_MAP
  // because their numeric values conflict with basic keycodes)
  for (const modKc of KEYCODES_LM_MODS) {
    KEYCODES_MAP.set(modKc.qmkId, modKc)
  }
  // Reset lazy LM mod value map so it rebuilds with current protocol
  lmModValueMap = null
}

// --- User keycodes ---

export function createUserKeycodes(): void {
  const arr: Keycode[] = []
  for (let x = 0; x < 16; x++) {
    arr.push(
      new Keycode({
        qmkId: `USER${String(x).padStart(2, '0')}`,
        label: `User ${x}`,
        tooltip: `User keycode ${x}`,
      }),
    )
  }
  setKeycodeUser(arr)
}

export function createCustomUserKeycodes(
  customKeycodes: CustomKeycodeDefinition[],
): void {
  const arr: Keycode[] = []
  for (let x = 0; x < customKeycodes.length; x++) {
    const c = customKeycodes[x]
    arr.push(
      new Keycode({
        qmkId: `USER${String(x).padStart(2, '0')}`,
        label: c.shortName ?? `USER${String(x).padStart(2, '0')}`,
        tooltip: c.title ?? `USER${String(x).padStart(2, '0')}`,
        alias: [c.name ?? `USER${String(x).padStart(2, '0')}`],
        cExportId: c.name,
      }),
    )
  }
  setKeycodeUser(arr)
}

// --- MIDI keycodes ---

export function createMidiKeycodes(midiSettingLevel: string): void {
  const arr: Keycode[] = []
  if (midiSettingLevel === 'basic' || midiSettingLevel === 'advanced') {
    arr.push(...KEYCODES_MIDI_BASIC)
  }
  if (midiSettingLevel === 'advanced') {
    arr.push(...KEYCODES_MIDI_ADVANCED)
  }
  setKeycodeMidi(arr)
}

// --- Keyboard-specific keycodes ---

export function recreateKeyboardKeycodes(keyboard: KeyboardKeycodeContext): void {
  setProtocolValue(keyboard.vialProtocol)
  const layers = keyboard.layers

  const layersSpecial: Keycode[] = [
    new Keycode({
      qmkId: 'QK_LAYER_LOCK',
      label: 'Layer\nLock',
      tooltip: 'Locks the current layer',
      alias: ['QK_LLCK'],
      requiresFeature: 'layer_lock',
    }),
  ]
  if (layers >= 4) {
    layersSpecial.push(new Keycode({ qmkId: 'FN_MO13', label: 'Fn1\n(Fn3)' }))
    layersSpecial.push(new Keycode({ qmkId: 'FN_MO23', label: 'Fn2\n(Fn3)' }))
  }
  setKeycodeLayersSpecial(layersSpecial)

  const mo: Keycode[] = []
  const df: Keycode[] = []
  const pdf: Keycode[] = []
  const tg: Keycode[] = []
  const tt: Keycode[] = []
  const osl: Keycode[] = []
  const to: Keycode[] = []

  const layerKeycodeTypes: [string, string, Keycode[], string?][] = [
    ['MO', 'Momentarily turn on layer when pressed (requires KC_TRNS on destination layer)', mo],
    ['DF', 'Set the base (default) layer', df],
    ['PDF', 'Persistently set the base (default) layer', pdf, 'persistent_default_layer'],
    ['TG', 'Toggle layer on or off', tg],
    ['TT', 'Normally acts like MO unless it\'s tapped multiple times, which toggles layer on', tt],
    ['OSL', 'Momentarily activates layer until a key is pressed', osl],
    ['TO', 'Turns on layer and turns off all other layers, except the default layer', to],
  ]
  for (const [label, description, target, feature] of layerKeycodeTypes) {
    for (let layer = 0; layer < layers; layer++) {
      const lbl = `${label}(${layer})`
      target.push(
        new Keycode({
          qmkId: lbl,
          label: lbl,
          tooltip: description,
          requiresFeature: feature,
        }),
      )
    }
  }

  setKeycodeLayersMO(mo)
  setKeycodeLayersDF(df)
  setKeycodeLayersPDF(pdf)
  setKeycodeLayersTG(tg)
  setKeycodeLayersTT(tt)
  setKeycodeLayersOSL(osl)
  setKeycodeLayersTO(to)

  const lt: Keycode[] = []
  for (let x = 0; x < Math.min(layers, 16); x++) {
    lt.push(
      new Keycode({
        qmkId: `LT${x}(kc)`,
        label: `LT ${x}\n(kc)`,
        tooltip: `kc on tap, switch to layer ${x} while held`,
        masked: true,
      }),
    )
  }
  setKeycodeLayersLT(lt)

  const lm: Keycode[] = []
  for (let x = 0; x < Math.min(layers, 16); x++) {
    lm.push(
      new Keycode({
        qmkId: `LM${x}(kc)`,
        label: `LM ${x}\n(kc)`,
        tooltip: `Momentarily activates layer ${x} with modifier`,
        masked: true,
      }),
    )
  }
  setKeycodeLayersLM(lm)

  setKeycodeLayers([
    ...KEYCODES_LAYERS_SPECIAL,
    ...KEYCODES_LAYERS_MO,
    ...KEYCODES_LAYERS_DF,
    ...KEYCODES_LAYERS_PDF,
    ...KEYCODES_LAYERS_TG,
    ...KEYCODES_LAYERS_TT,
    ...KEYCODES_LAYERS_OSL,
    ...KEYCODES_LAYERS_TO,
    ...KEYCODES_LAYERS_LT,
    ...KEYCODES_LAYERS_LM,
  ])

  const macroM: Keycode[] = []
  for (let x = 0; x < keyboard.macroCount; x++) {
    const lbl = `M${x}`
    macroM.push(new Keycode({ qmkId: lbl, label: lbl }))
  }
  setKeycodeMacroM(macroM)
  setKeycodeMacro([...KEYCODES_MACRO_M, ...KEYCODES_MACRO_BASE])

  const td: Keycode[] = []
  for (let x = 0; x < keyboard.tapDanceCount; x++) {
    const lbl = `TD(${x})`
    td.push(
      new Keycode({ qmkId: lbl, label: lbl, tooltip: 'Tap dance keycode' }),
    )
  }
  setKeycodeTapDance(td)

  if (keyboard.customKeycodes && keyboard.customKeycodes.length > 0) {
    createCustomUserKeycodes(keyboard.customKeycodes)
  } else {
    createUserKeycodes()
  }

  createMidiKeycodes(keyboard.midi)

  recreateKeycodes()

  for (const kc of KEYCODES) {
    kc.hidden = !kc.isSupportedBy(keyboard.supportedFeatures)
  }
}

// --- Protocol getter/setter ---

export function getProtocol(): number {
  return getProtocolValue()
}

export function setProtocol(p: number): void {
  setProtocolValue(p)
}
