// SPDX-License-Identifier: GPL-2.0-or-later
// AnyKeycode expression evaluator (port of any_keycode.py)

import { resolve } from './keycodes-utils'
import {
  KEYCODES_SPECIAL,
  KEYCODES_BASIC,
  KEYCODES_SHIFTED,
  KEYCODES_ISO,
  KEYCODES_INTERNATIONAL,
  KEYCODES_LANGUAGE,
  KEYCODES_JIS,
  KEYCODES_LIGHTING,
  KEYCODES_SYSTEM,
  KEYCODES_USER,
} from './keycodes'

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
const TOKEN_RE =
  /([A-Za-z_][A-Za-z0-9_]*)\s*\(|(0[xX][0-9a-fA-F]+|\d+)|([A-Za-z_][A-Za-z0-9_]*)|(<<|>>)|\s*([,|&^+\-()])\s*/g

function tokenize(s: string): string[] {
  const tokens: string[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((match = TOKEN_RE.exec(s)) !== null) {
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
      tokens.push(match[4])
    } else if (match[5]) {
      tokens.push(match[5])
    }
  }
  const trailing = s.slice(lastIndex)
  if (trailing.trim().length > 0) {
    throw new Error(`Invalid character in expression: ${s}`)
  }
  return tokens
}

export function decodeAnyKeycode(s: string): number {
  const functions = buildAnyKeycodeFunctions()
  const names = buildAnyKeycodeNames()

  let tokens: string[]
  try {
    tokens = tokenize(s)
  } catch {
    return 0
  }

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

    if (tok === '(') {
      pos++
      const val = parseExpr()
      if (tokens[pos] !== ')') throw new Error(`Expected ')' in: ${s}`)
      pos++
      return val
    }

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

    if (/^(\d|0x)/i.test(tok)) {
      pos++
      return parseInt(tok, tok.startsWith('0x') || tok.startsWith('0X') ? 16 : 10)
    }

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
