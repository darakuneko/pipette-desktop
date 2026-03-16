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

// --- AnyKeycode expression evaluator (port of any_keycode.py) ---

type AnyFn1 = (kc: number) => number
type AnyFn2 = (a: number, b: number) => number

function buildAnyKeycodeFunctions(): Map<string, AnyFn1 | AnyFn2> {
  const r = resolve
  const fns = new Map<string, AnyFn1 | AnyFn2>()

  // Modifier wrappers (1-arg)
  const mod1: [string, () => number][] = [
    ['LCTL', () => r('QK_LCTL')],
    ['LSFT', () => r('QK_LSFT')],
    ['LALT', () => r('QK_LALT')],
    ['LGUI', () => r('QK_LGUI')],
    ['RCTL', () => r('QK_RCTL')],
    ['RSFT', () => r('QK_RSFT')],
    ['RALT', () => r('QK_RALT')],
    ['RGUI', () => r('QK_RGUI')],
  ]
  for (const [name, modFn] of mod1) {
    fns.set(name, (kc: number) => modFn() | kc)
  }
  // Aliases
  fns.set('LOPT', fns.get('LALT')!)
  fns.set('LCMD', fns.get('LGUI')!)
  fns.set('LWIN', fns.get('LGUI')!)
  fns.set('ALGR', fns.get('RALT')!)
  fns.set('ROPT', fns.get('RALT')!)
  fns.set('RCMD', fns.get('RGUI')!)
  fns.set('RWIN', fns.get('RGUI')!)
  fns.set('C', fns.get('LCTL')!)
  fns.set('S', fns.get('LSFT')!)
  fns.set('A', fns.get('LALT')!)
  fns.set('G', fns.get('LGUI')!)

  // Combined modifier wrappers (1-arg)
  fns.set('C_S', (kc: number) => r('QK_LCTL') | r('QK_LSFT') | kc)
  fns.set(
    'HYPR',
    (kc: number) => r('QK_LCTL') | r('QK_LSFT') | r('QK_LALT') | r('QK_LGUI') | kc,
  )
  fns.set('MEH', (kc: number) => r('QK_LCTL') | r('QK_LSFT') | r('QK_LALT') | kc)
  fns.set('LCAG', (kc: number) => r('QK_LCTL') | r('QK_LALT') | r('QK_LGUI') | kc)
  fns.set('SGUI', (kc: number) => r('QK_LGUI') | r('QK_LSFT') | kc)
  fns.set('SCMD', fns.get('SGUI')!)
  fns.set('SWIN', fns.get('SGUI')!)
  fns.set('LSG', fns.get('SGUI')!)
  fns.set('LCA', (kc: number) => r('QK_LCTL') | r('QK_LALT') | kc)
  fns.set('LSA', (kc: number) => r('QK_LSFT') | r('QK_LALT') | kc)
  fns.set('LAG', (kc: number) => r('QK_LALT') | r('QK_LGUI') | kc)
  fns.set('LCSG', (kc: number) => r('QK_LCTL') | r('QK_LSFT') | r('QK_LGUI') | kc)
  fns.set('LSAG', (kc: number) => r('QK_LSFT') | r('QK_LALT') | r('QK_LGUI') | kc)
  fns.set('RSA', (kc: number) => r('QK_RSFT') | r('QK_RALT') | kc)
  fns.set('RCS', (kc: number) => r('QK_RCTL') | r('QK_RSFT') | kc)
  fns.set('RCA', (kc: number) => r('QK_RCTL') | r('QK_RALT') | kc)
  fns.set('SAGR', fns.get('RSA')!)
  fns.set('LCG', (kc: number) => r('QK_LCTL') | r('QK_LGUI') | kc)
  fns.set('RCG', (kc: number) => r('QK_RCTL') | r('QK_RGUI') | kc)
  fns.set('RSG', (kc: number) => r('QK_RSFT') | r('QK_RGUI') | kc)
  fns.set('RAG', (kc: number) => r('QK_RALT') | r('QK_RGUI') | kc)
  fns.set('RMEH', (kc: number) => r('QK_RCTL') | r('QK_RSFT') | r('QK_RALT') | kc)
  fns.set('RCSG', (kc: number) => r('QK_RCTL') | r('QK_RSFT') | r('QK_RGUI') | kc)
  fns.set('RCAG', (kc: number) => r('QK_RCTL') | r('QK_RALT') | r('QK_RGUI') | kc)
  fns.set('RSAG', (kc: number) => r('QK_RSFT') | r('QK_RALT') | r('QK_RGUI') | kc)
  fns.set(
    'RHYPR',
    (kc: number) => r('QK_RCTL') | r('QK_RSFT') | r('QK_RALT') | r('QK_RGUI') | kc,
  )

  // Layer functions (1 or 2 arg)
  fns.set(
    'LT',
    ((layer: number, kc: number) =>
      r('QK_LAYER_TAP') | ((layer & 0x0f) << 8) | (kc & 0xff)) as AnyFn2,
  )
  fns.set('TO', (layer: number) => r('QK_TO') | (r('ON_PRESS') << 0x4) | (layer & 0xff))
  fns.set('MO', (layer: number) => r('QK_MOMENTARY') | (layer & 0xff))
  fns.set('DF', (layer: number) => r('QK_DEF_LAYER') | (layer & 0xff))
  fns.set('TG', (layer: number) => r('QK_TOGGLE_LAYER') | (layer & 0xff))
  fns.set('OSL', (layer: number) => r('QK_ONE_SHOT_LAYER') | (layer & 0xff))
  fns.set(
    'LM',
    ((layer: number, mod: number) =>
      r('QK_LAYER_MOD') |
      ((layer & 0x0f) << r('QMK_LM_SHIFT')) |
      (mod & r('QMK_LM_MASK'))) as AnyFn2,
  )
  // LM0-LM15: 1-arg wrappers for masked form deserialization (e.g. LM0(MOD_LCTL))
  for (let x = 0; x < 16; x++) {
    const layer = x
    fns.set(
      `LM${x}`,
      (mod: number) =>
        r('QK_LAYER_MOD') |
        ((layer & 0x0f) << r('QMK_LM_SHIFT')) |
        (mod & r('QMK_LM_MASK')),
    )
  }
  fns.set('OSM', (mod: number) => r('QK_ONE_SHOT_MOD') | (mod & 0xff))
  fns.set('TT', (layer: number) => r('QK_LAYER_TAP_TOGGLE') | (layer & 0xff))
  fns.set(
    'MT',
    ((mod: number, kc: number) =>
      r('QK_MOD_TAP') | ((mod & 0x1f) << 8) | (kc & 0xff)) as AnyFn2,
  )
  fns.set('TD', (n: number) => r('QK_TAP_DANCE') | (n & 0xff))
  fns.set('SH_T', (kc: number) => r('SH_T(kc)') | (kc & 0xff))

  // Mod-tap wrappers
  const MT_fn = fns.get('MT') as AnyFn2
  fns.set('LCTL_T', (kc: number) => MT_fn(r('MOD_LCTL'), kc))
  fns.set('RCTL_T', (kc: number) => MT_fn(r('MOD_RCTL'), kc))
  fns.set('CTL_T', fns.get('LCTL_T')!)
  fns.set('LSFT_T', (kc: number) => MT_fn(r('MOD_LSFT'), kc))
  fns.set('RSFT_T', (kc: number) => MT_fn(r('MOD_RSFT'), kc))
  fns.set('SFT_T', fns.get('LSFT_T')!)
  fns.set('LALT_T', (kc: number) => MT_fn(r('MOD_LALT'), kc))
  fns.set('RALT_T', (kc: number) => MT_fn(r('MOD_RALT'), kc))
  fns.set('LOPT_T', fns.get('LALT_T')!)
  fns.set('ROPT_T', fns.get('RALT_T')!)
  fns.set('ALGR_T', fns.get('RALT_T')!)
  fns.set('ALT_T', fns.get('LALT_T')!)
  fns.set('OPT_T', fns.get('LALT_T')!)
  fns.set('LGUI_T', (kc: number) => MT_fn(r('MOD_LGUI'), kc))
  fns.set('RGUI_T', (kc: number) => MT_fn(r('MOD_RGUI'), kc))
  fns.set('LCMD_T', fns.get('LGUI_T')!)
  fns.set('LWIN_T', fns.get('LGUI_T')!)
  fns.set('RCMD_T', fns.get('RGUI_T')!)
  fns.set('RWIN_T', fns.get('RGUI_T')!)
  fns.set('GUI_T', fns.get('LGUI_T')!)
  fns.set('CMD_T', fns.get('LGUI_T')!)
  fns.set('WIN_T', fns.get('LGUI_T')!)
  fns.set('C_S_T', (kc: number) => MT_fn(r('MOD_LCTL') | r('MOD_LSFT'), kc))
  fns.set(
    'MEH_T',
    (kc: number) => MT_fn(r('MOD_LCTL') | r('MOD_LSFT') | r('MOD_LALT'), kc),
  )
  fns.set(
    'LCAG_T',
    (kc: number) => MT_fn(r('MOD_LCTL') | r('MOD_LALT') | r('MOD_LGUI'), kc),
  )
  fns.set(
    'RCAG_T',
    (kc: number) => MT_fn(r('MOD_RCTL') | r('MOD_RALT') | r('MOD_RGUI'), kc),
  )
  fns.set(
    'HYPR_T',
    (kc: number) =>
      MT_fn(r('MOD_LCTL') | r('MOD_LSFT') | r('MOD_LALT') | r('MOD_LGUI'), kc),
  )
  fns.set('ALL_T', fns.get('HYPR_T')!)
  fns.set('SGUI_T', (kc: number) => MT_fn(r('MOD_LGUI') | r('MOD_LSFT'), kc))
  fns.set('SCMD_T', fns.get('SGUI_T')!)
  fns.set('SWIN_T', fns.get('SGUI_T')!)
  fns.set('LSG_T', fns.get('SGUI_T')!)
  fns.set('LCA_T', (kc: number) => MT_fn(r('MOD_LCTL') | r('MOD_LALT'), kc))
  fns.set('LSA_T', (kc: number) => MT_fn(r('MOD_LSFT') | r('MOD_LALT'), kc))
  fns.set('LAG_T', (kc: number) => MT_fn(r('MOD_LALT') | r('MOD_LGUI'), kc))
  fns.set('RSA_T', (kc: number) => MT_fn(r('MOD_RSFT') | r('MOD_RALT'), kc))
  fns.set('RCS_T', (kc: number) => MT_fn(r('MOD_RCTL') | r('MOD_RSFT'), kc))
  fns.set('SAGR_T', fns.get('RSA_T')!)
  fns.set('LCG_T', (kc: number) => MT_fn(r('MOD_LCTL') | r('MOD_LGUI'), kc))
  fns.set(
    'LCSG_T',
    (kc: number) => MT_fn(r('MOD_LCTL') | r('MOD_LSFT') | r('MOD_LGUI'), kc),
  )
  fns.set(
    'LSAG_T',
    (kc: number) => MT_fn(r('MOD_LSFT') | r('MOD_LALT') | r('MOD_LGUI'), kc),
  )
  fns.set('RCA_T', (kc: number) => MT_fn(r('MOD_RCTL') | r('MOD_RALT'), kc))
  fns.set('RCG_T', (kc: number) => MT_fn(r('MOD_RCTL') | r('MOD_RGUI'), kc))
  fns.set('RSG_T', (kc: number) => MT_fn(r('MOD_RSFT') | r('MOD_RGUI'), kc))
  fns.set('RAG_T', (kc: number) => MT_fn(r('MOD_RALT') | r('MOD_RGUI'), kc))
  fns.set(
    'RCSG_T',
    (kc: number) => MT_fn(r('MOD_RCTL') | r('MOD_RSFT') | r('MOD_RGUI'), kc),
  )
  fns.set(
    'RSAG_T',
    (kc: number) => MT_fn(r('MOD_RSFT') | r('MOD_RALT') | r('MOD_RGUI'), kc),
  )
  fns.set(
    'RMEH_T',
    (kc: number) => MT_fn(r('MOD_RCTL') | r('MOD_RSFT') | r('MOD_RALT'), kc),
  )
  fns.set(
    'RALL_T',
    (kc: number) =>
      MT_fn(r('MOD_RCTL') | r('MOD_RSFT') | r('MOD_RALT') | r('MOD_RGUI'), kc),
  )

  // LT0-LT15 shortcuts
  for (let x = 0; x < 16; x++) {
    const layer = x
    fns.set(
      `LT${x}`,
      (kc: number) => r('QK_LAYER_TAP') | ((layer & 0x0f) << 8) | (kc & 0xff),
    )
  }

  return fns
}

function buildAnyKeycodeNames(): Map<string, number> {
  const names = new Map<string, number>()
  for (const kc of [
    ...KEYCODES_SPECIAL,
    ...KEYCODES_BASIC,
    ...KEYCODES_SHIFTED,
    ...KEYCODES_ISO,
    ...KEYCODES_INTERNATIONAL,
    ...KEYCODES_LANGUAGE,
    ...KEYCODES_JIS,
    ...KEYCODES_LIGHTING,
    ...KEYCODES_SYSTEM,
    ...KEYCODES_USER,
  ]) {
    for (const alias of kc.alias) {
      names.set(alias, resolve(kc.qmkId))
    }
  }
  for (const s of [
    'MOD_LCTL',
    'MOD_LSFT',
    'MOD_LALT',
    'MOD_LGUI',
    'MOD_RCTL',
    'MOD_RSFT',
    'MOD_RALT',
    'MOD_RGUI',
    'MOD_MEH',
    'MOD_HYPR',
  ]) {
    names.set(s, resolve(s))
  }
  return names
}

// Tokenizer for expressions like "LT(0, KC_A)", "LSFT(KC_B)", "(MOD_LCTL | MOD_LSFT)"
// Supports: function calls, identifiers, numbers (decimal/hex), parentheses grouping,
// operators: |, ^, &, +, -, <<, >>, and unary -/+
// Matches Python simpleeval DEFAULT_OPERATORS + BitOr/BitXor/BitAnd
const TOKEN_RE =
  /([A-Za-z_][A-Za-z0-9_]*)\s*\(|(0[xX][0-9a-fA-F]+|\d+)|([A-Za-z_][A-Za-z0-9_]*)|(<<|>>)|\s*([,|&^+\-()])\s*/g

function tokenize(s: string): string[] {
  const tokens: string[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((match = TOKEN_RE.exec(s)) !== null) {
    // Check for unmatched characters between tokens (skipping whitespace)
    const skipped = s.slice(lastIndex, match.index)
    if (skipped.trim().length > 0) {
      throw new Error(`Invalid character in expression: ${s}`)
    }
    lastIndex = match.index + match[0].length

    if (match[1]) {
      tokens.push(match[1] + '(')
    } else if (match[2]) {
      tokens.push(match[2])
    } else if (match[3]) {
      tokens.push(match[3])
    } else if (match[4]) {
      // Shift operators: << or >>
      tokens.push(match[4])
    } else if (match[5]) {
      tokens.push(match[5])
    }
  }
  // Check for trailing unmatched characters
  const trailing = s.slice(lastIndex)
  if (trailing.trim().length > 0) {
    throw new Error(`Invalid character in expression: ${s}`)
  }
  return tokens
}

function decodeAnyKeycode(s: string): number {
  const functions = buildAnyKeycodeFunctions()
  const names = buildAnyKeycodeNames()

  let tokens: string[]
  try {
    tokens = tokenize(s)
  } catch {
    return 0
  }

  // Recursive descent parser
  // Operator precedence (lowest to highest): |, ^, &, <</>>, +/-, unary
  let pos = 0

  function parseExpr(): number {
    let left = parseXorExpr()
    while (pos < tokens.length && tokens[pos] === '|') {
      pos++
      left = left | parseXorExpr()
    }
    return left
  }

  function parseXorExpr(): number {
    let left = parseAndExpr()
    while (pos < tokens.length && tokens[pos] === '^') {
      pos++
      left = left ^ parseAndExpr()
    }
    return left
  }

  function parseAndExpr(): number {
    let left = parseShiftExpr()
    while (pos < tokens.length && tokens[pos] === '&') {
      pos++
      left = left & parseShiftExpr()
    }
    return left
  }

  function parseShiftExpr(): number {
    let left = parseAddExpr()
    while (pos < tokens.length && (tokens[pos] === '<<' || tokens[pos] === '>>')) {
      const op = tokens[pos]
      pos++
      const right = parseAddExpr()
      left = op === '<<' ? left << right : left >>> right
    }
    return left
  }

  function parseAddExpr(): number {
    let left = parseUnary()
    while (pos < tokens.length && (tokens[pos] === '+' || tokens[pos] === '-')) {
      const op = tokens[pos]
      pos++
      const right = parseUnary()
      left = op === '+' ? left + right : left - right
    }
    return left
  }

  function parseUnary(): number {
    if (pos < tokens.length && tokens[pos] === '-') {
      pos++
      return -parseUnary()
    }
    if (pos < tokens.length && tokens[pos] === '+') {
      pos++
      return parseUnary()
    }
    return parsePrimary()
  }

  function parsePrimary(): number {
    const tok = tokens[pos]
    if (tok === undefined) throw new Error(`Unexpected end of expression: ${s}`)

    // Parenthesized sub-expression (bare '(' not preceded by function name)
    if (tok === '(') {
      pos++
      const val = parseExpr()
      if (tokens[pos] !== ')') throw new Error(`Expected ')' in: ${s}`)
      pos++
      return val
    }

    // Function call: name(
    if (tok.endsWith('(')) {
      const fnName = tok.slice(0, -1)
      pos++
      const fn = functions.get(fnName)
      if (!fn) throw new Error(`Unknown function: ${fnName}`)
      const args: number[] = []
      if (tokens[pos] !== ')') {
        args.push(parseExpr())
        while (tokens[pos] === ',') {
          pos++
          args.push(parseExpr())
        }
      }
      if (tokens[pos] !== ')') throw new Error(`Expected ')' in: ${s}`)
      pos++
      if (args.length === 1) return (fn as AnyFn1)(args[0])
      if (args.length === 2) return (fn as AnyFn2)(args[0], args[1])
      throw new Error(`Wrong argument count for ${fnName} in: ${s}`)
    }

    // Number literal
    if (/^(\d|0x)/i.test(tok)) {
      pos++
      return parseInt(tok, tok.startsWith('0x') || tok.startsWith('0X') ? 16 : 10)
    }

    // Named constant
    const val = names.get(tok)
    if (val !== undefined) {
      pos++
      return val
    }

    throw new Error(`Unknown identifier: ${tok} in: ${s}`)
  }

  try {
    const result = parseExpr()
    if (pos < tokens.length) {
      throw new Error(`Unexpected trailing tokens in: ${s}`)
    }
    return result
  } catch {
    return 0
  }
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
