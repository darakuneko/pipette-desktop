// SPDX-License-Identifier: GPL-2.0-or-later
// Ported from vial-gui keycodes/keycodes.py and any_keycode.py

import { keycodesV5 } from './keycodes-v5'
import { keycodesV6 } from './keycodes-v6'

// --- Keycode class ---

export interface KeycodeOptions {
  qmkId: string
  label: string
  tooltip?: string
  masked?: boolean
  printable?: string
  recorderAlias?: string[]
  alias?: string[]
  requiresFeature?: string
}

export class Keycode {
  readonly qmkId: string
  readonly label: string
  readonly tooltip: string | undefined
  readonly masked: boolean
  readonly printable: string | undefined
  readonly alias: string[]
  readonly requiresFeature: string | undefined
  hidden = false

  constructor(opts: KeycodeOptions) {
    this.qmkId = opts.qmkId
    this.label = opts.label
    this.tooltip = opts.tooltip
    this.masked = opts.masked ?? false
    this.printable = opts.printable
    this.alias = [this.qmkId, ...(opts.alias ?? [])]
    this.requiresFeature = opts.requiresFeature

    if (opts.recorderAlias) {
      for (const a of opts.recorderAlias) {
        if (recorderAliasToKeycode.has(a)) {
          throw new Error(
            `Misconfigured: two keycodes claim the same alias ${a}`,
          )
        }
        recorderAliasToKeycode.set(a, this)
      }
    }

    qmkIdToKeycode.set(this.qmkId, this)

    if (this.masked) {
      maskedKeycodes.add(this.qmkId.replace('(kc)', ''))
    }
  }

  isSupportedBy(supportedFeatures: Set<string>): boolean {
    if (this.requiresFeature === undefined) return true
    return supportedFeatures.has(this.requiresFeature)
  }
}

// --- Module state ---

let protocol = 0
const maskedKeycodes = new Set<string>()
const recorderAliasToKeycode = new Map<string, Keycode>()
const qmkIdToKeycode = new Map<string, Keycode>()

// --- Helper to create Keycode concisely ---

function K(
  qmkId: string,
  label: string,
  tooltipOrOpts?:
    | string
    | {
        tooltip?: string
        masked?: boolean
        printable?: string
        recorderAlias?: string[]
        alias?: string[]
        requiresFeature?: string
      },
  opts?: {
    masked?: boolean
    printable?: string
    recorderAlias?: string[]
    alias?: string[]
    requiresFeature?: string
  },
): Keycode {
  if (typeof tooltipOrOpts === 'string') {
    return new Keycode({ qmkId, label, tooltip: tooltipOrOpts, ...opts })
  }
  return new Keycode({ qmkId, label, ...tooltipOrOpts })
}

// --- Keycode category arrays ---

export const KEYCODES_SPECIAL: Keycode[] = [
  K('KC_NO', ''),
  K('KC_TRNS', '\u25BD', { alias: ['KC_TRANSPARENT'] }),
]

export const KEYCODES_BASIC_LETTERS: Keycode[] = [
  K('KC_A', 'A', { printable: 'a', recorderAlias: ['a'] }),
  K('KC_B', 'B', { printable: 'b', recorderAlias: ['b'] }),
  K('KC_C', 'C', { printable: 'c', recorderAlias: ['c'] }),
  K('KC_D', 'D', { printable: 'd', recorderAlias: ['d'] }),
  K('KC_E', 'E', { printable: 'e', recorderAlias: ['e'] }),
  K('KC_F', 'F', { printable: 'f', recorderAlias: ['f'] }),
  K('KC_G', 'G', { printable: 'g', recorderAlias: ['g'] }),
  K('KC_H', 'H', { printable: 'h', recorderAlias: ['h'] }),
  K('KC_I', 'I', { printable: 'i', recorderAlias: ['i'] }),
  K('KC_J', 'J', { printable: 'j', recorderAlias: ['j'] }),
  K('KC_K', 'K', { printable: 'k', recorderAlias: ['k'] }),
  K('KC_L', 'L', { printable: 'l', recorderAlias: ['l'] }),
  K('KC_M', 'M', { printable: 'm', recorderAlias: ['m'] }),
  K('KC_N', 'N', { printable: 'n', recorderAlias: ['n'] }),
  K('KC_O', 'O', { printable: 'o', recorderAlias: ['o'] }),
  K('KC_P', 'P', { printable: 'p', recorderAlias: ['p'] }),
  K('KC_Q', 'Q', { printable: 'q', recorderAlias: ['q'] }),
  K('KC_R', 'R', { printable: 'r', recorderAlias: ['r'] }),
  K('KC_S', 'S', { printable: 's', recorderAlias: ['s'] }),
  K('KC_T', 'T', { printable: 't', recorderAlias: ['t'] }),
  K('KC_U', 'U', { printable: 'u', recorderAlias: ['u'] }),
  K('KC_V', 'V', { printable: 'v', recorderAlias: ['v'] }),
  K('KC_W', 'W', { printable: 'w', recorderAlias: ['w'] }),
  K('KC_X', 'X', { printable: 'x', recorderAlias: ['x'] }),
  K('KC_Y', 'Y', { printable: 'y', recorderAlias: ['y'] }),
  K('KC_Z', 'Z', { printable: 'z', recorderAlias: ['z'] }),
]

export const KEYCODES_BASIC_NUMBERS: Keycode[] = [
  K('KC_1', '!\n1', { printable: '1', recorderAlias: ['1'] }),
  K('KC_2', '@\n2', { printable: '2', recorderAlias: ['2'] }),
  K('KC_3', '#\n3', { printable: '3', recorderAlias: ['3'] }),
  K('KC_4', '$\n4', { printable: '4', recorderAlias: ['4'] }),
  K('KC_5', '%\n5', { printable: '5', recorderAlias: ['5'] }),
  K('KC_6', '^\n6', { printable: '6', recorderAlias: ['6'] }),
  K('KC_7', '&\n7', { printable: '7', recorderAlias: ['7'] }),
  K('KC_8', '*\n8', { printable: '8', recorderAlias: ['8'] }),
  K('KC_9', '(\n9', { printable: '9', recorderAlias: ['9'] }),
  K('KC_0', ')\n0', { printable: '0', recorderAlias: ['0'] }),
]

export const KEYCODES_BASIC_SYMBOLS: Keycode[] = [
  K('KC_MINUS', '_\n-', { printable: '-', recorderAlias: ['-'], alias: ['KC_MINS'] }),
  K('KC_EQUAL', '+\n=', { printable: '=', recorderAlias: ['='], alias: ['KC_EQL'] }),
  K('KC_LBRACKET', '{\n[', { printable: '[', recorderAlias: ['['], alias: ['KC_LBRC'] }),
  K('KC_RBRACKET', '}\n]', { printable: ']', recorderAlias: [']'], alias: ['KC_RBRC'] }),
  K('KC_BSLASH', '|\n\\', { printable: '\\', recorderAlias: ['\\'], alias: ['KC_BSLS'] }),
  K('KC_SCOLON', ':\n;', { printable: ';', recorderAlias: [';'], alias: ['KC_SCLN'] }),
  K('KC_QUOTE', '"\n\'', { printable: "'", recorderAlias: ["'"], alias: ['KC_QUOT'] }),
  K('KC_GRAVE', '~\n`', {
    printable: '`',
    recorderAlias: ['`'],
    alias: ['KC_GRV', 'KC_ZKHK'],
  }),
  K('KC_COMMA', '<\n,', { printable: ',', recorderAlias: [','], alias: ['KC_COMM'] }),
  K('KC_DOT', '>\n.', { printable: '.', recorderAlias: ['.'] }),
  K('KC_SLASH', '?\n/', { printable: '/', recorderAlias: ['/'], alias: ['KC_SLSH'] }),
]

export const KEYCODES_BASIC_CHARACTERS: Keycode[] = [
  ...KEYCODES_BASIC_LETTERS,
  ...KEYCODES_BASIC_NUMBERS,
  ...KEYCODES_BASIC_SYMBOLS,
]

export const KEYCODES_BASIC_EDITING: Keycode[] = [
  K('KC_ENTER', 'Enter', { recorderAlias: ['enter'], alias: ['KC_ENT'] }),
  K('KC_SPACE', 'Space', { recorderAlias: ['space'], alias: ['KC_SPC'] }),
  K('KC_TAB', 'Tab', { recorderAlias: ['tab'] }),
  K('KC_BSPACE', 'Bksp', { recorderAlias: ['backspace'], alias: ['KC_BSPC'] }),
  K('KC_ESCAPE', 'Esc', { recorderAlias: ['esc'], alias: ['KC_ESC'] }),
]

export const KEYCODES_BASIC_MODS: Keycode[] = [
  K('KC_LSHIFT', 'LShift', {
    recorderAlias: ['left shift', 'shift'],
    alias: ['KC_LSFT'],
  }),
  K('KC_RSHIFT', 'RShift', { recorderAlias: ['right shift'], alias: ['KC_RSFT'] }),
  K('KC_LCTRL', 'LCtrl', { recorderAlias: ['left ctrl', 'ctrl'], alias: ['KC_LCTL'] }),
  K('KC_RCTRL', 'RCtrl', { recorderAlias: ['right ctrl'], alias: ['KC_RCTL'] }),
  K('KC_LALT', 'LAlt', { recorderAlias: ['alt'], alias: ['KC_LOPT'] }),
  K('KC_RALT', 'RAlt', { alias: ['KC_ALGR', 'KC_ROPT'] }),
  K('KC_LGUI', 'LGui', {
    recorderAlias: ['left windows', 'windows'],
    alias: ['KC_LCMD', 'KC_LWIN'],
  }),
  K('KC_RGUI', 'RGui', {
    recorderAlias: ['right windows'],
    alias: ['KC_RCMD', 'KC_RWIN'],
  }),
  K('KC_APPLICATION', 'Menu', {
    recorderAlias: ['menu', 'left menu', 'right menu'],
    alias: ['KC_APP'],
  }),
]

export const KEYCODES_BASIC_NAV: Keycode[] = [
  K('KC_UP', 'Up', { recorderAlias: ['up'] }),
  K('KC_DOWN', 'Down', { recorderAlias: ['down'] }),
  K('KC_LEFT', 'Left', { recorderAlias: ['left'] }),
  K('KC_RIGHT', 'Right', { recorderAlias: ['right'], alias: ['KC_RGHT'] }),
  K('KC_HOME', 'Home', { recorderAlias: ['home'] }),
  K('KC_END', 'End', { recorderAlias: ['end'] }),
  K('KC_PGUP', 'Page\nUp', { recorderAlias: ['page up'] }),
  K('KC_PGDOWN', 'Page\nDown', { recorderAlias: ['page down'], alias: ['KC_PGDN'] }),
  K('KC_INSERT', 'Insert', { recorderAlias: ['insert'], alias: ['KC_INS'] }),
  K('KC_DELETE', 'Del', { recorderAlias: ['delete'], alias: ['KC_DEL'] }),
]

export const KEYCODES_BASIC_FUNCTION: Keycode[] = [
  K('KC_F1', 'F1', { recorderAlias: ['f1'] }),
  K('KC_F2', 'F2', { recorderAlias: ['f2'] }),
  K('KC_F3', 'F3', { recorderAlias: ['f3'] }),
  K('KC_F4', 'F4', { recorderAlias: ['f4'] }),
  K('KC_F5', 'F5', { recorderAlias: ['f5'] }),
  K('KC_F6', 'F6', { recorderAlias: ['f6'] }),
  K('KC_F7', 'F7', { recorderAlias: ['f7'] }),
  K('KC_F8', 'F8', { recorderAlias: ['f8'] }),
  K('KC_F9', 'F9', { recorderAlias: ['f9'] }),
  K('KC_F10', 'F10', { recorderAlias: ['f10'] }),
  K('KC_F11', 'F11', { recorderAlias: ['f11'] }),
  K('KC_F12', 'F12', { recorderAlias: ['f12'] }),
]

export const KEYCODES_BASIC_LOCK: Keycode[] = [
  K('KC_CAPSLOCK', 'Caps\nLock', {
    recorderAlias: ['caps lock'],
    alias: ['KC_CLCK', 'KC_CAPS'],
  }),
  K('KC_NUMLOCK', 'Num\nLock', { recorderAlias: ['num lock'], alias: ['KC_NLCK'] }),
  K('KC_SCROLLLOCK', 'Scroll\nLock', {
    recorderAlias: ['scroll lock'],
    alias: ['KC_SLCK', 'KC_BRMD'],
  }),
]

export const KEYCODES_BASIC_NUMPAD: Keycode[] = [
  K('KC_KP_1', '1', { alias: ['KC_P1'] }),
  K('KC_KP_2', '2', { alias: ['KC_P2'] }),
  K('KC_KP_3', '3', { alias: ['KC_P3'] }),
  K('KC_KP_4', '4', { alias: ['KC_P4'] }),
  K('KC_KP_5', '5', { alias: ['KC_P5'] }),
  K('KC_KP_6', '6', { alias: ['KC_P6'] }),
  K('KC_KP_7', '7', { alias: ['KC_P7'] }),
  K('KC_KP_8', '8', { alias: ['KC_P8'] }),
  K('KC_KP_9', '9', { alias: ['KC_P9'] }),
  K('KC_KP_0', '0', { alias: ['KC_P0'] }),
  K('KC_KP_DOT', '.', { alias: ['KC_PDOT'] }),
  K('KC_KP_PLUS', '+', { alias: ['KC_PPLS'] }),
  K('KC_KP_MINUS', '-', { alias: ['KC_PMNS'] }),
  K('KC_KP_ASTERISK', '*', { alias: ['KC_PAST'] }),
  K('KC_KP_SLASH', '/', { alias: ['KC_PSLS'] }),
  K('KC_KP_EQUAL', '=', { alias: ['KC_PEQL'] }),
  K('KC_KP_COMMA', ',', { alias: ['KC_PCMM'] }),
  K('KC_KP_ENTER', 'Num\nEnter', { alias: ['KC_PENT'] }),
]

export const KEYCODES_BASIC_SYSTEM: Keycode[] = [
  K('KC_PSCREEN', 'Print\nScreen', { alias: ['KC_PSCR'] }),
  K('KC_PAUSE', 'Pause', {
    recorderAlias: ['pause', 'break'],
    alias: ['KC_PAUS', 'KC_BRK', 'KC_BRMU'],
  }),
]

export const KEYCODES_BASIC: Keycode[] = [
  ...KEYCODES_BASIC_CHARACTERS,
  ...KEYCODES_BASIC_EDITING,
  ...KEYCODES_BASIC_MODS,
  ...KEYCODES_BASIC_NAV,
  ...KEYCODES_BASIC_FUNCTION,
  ...KEYCODES_BASIC_LOCK,
  ...KEYCODES_BASIC_NUMPAD,
  ...KEYCODES_BASIC_SYSTEM,
]

export const KEYCODES_SHIFTED: Keycode[] = [
  K('KC_TILD', '~'),
  K('KC_EXLM', '!'),
  K('KC_AT', '@'),
  K('KC_HASH', '#'),
  K('KC_DLR', '$'),
  K('KC_PERC', '%'),
  K('KC_CIRC', '^'),
  K('KC_AMPR', '&'),
  K('KC_ASTR', '*'),
  K('KC_LPRN', '('),
  K('KC_RPRN', ')'),
  K('KC_UNDS', '_'),
  K('KC_PLUS', '+'),
  K('KC_LCBR', '{'),
  K('KC_RCBR', '}'),
  K('KC_LT', '<'),
  K('KC_GT', '>'),
  K('KC_COLN', ':'),
  K('KC_PIPE', '|'),
  K('KC_QUES', '?'),
  K('KC_DQUO', '"'),
]

export const KEYCODES_ISO: Keycode[] = [
  K('KC_NONUS_HASH', '~\n#', 'Non-US # and ~', { alias: ['KC_NUHS'] }),
  K('KC_NONUS_BSLASH', '|\n\\', 'Non-US \\ and |', { alias: ['KC_NUBS'] }),
  K('KC_RO', '_\n\\', 'JIS \\ and _', { alias: ['KC_INT1'] }),
  K('KC_KANA', '\u30AB\u30BF\u30AB\u30CA\n\u3072\u3089\u304C\u306A', 'JIS Katakana/Hiragana', {
    alias: ['KC_INT2'],
  }),
  K('KC_JYEN', '|\n\u00A5', { alias: ['KC_INT3'] }),
  K('KC_HENK', '\u5909\u63DB', 'JIS Henkan', { alias: ['KC_INT4'] }),
  K('KC_MHEN', '\u7121\u5909\u63DB', 'JIS Muhenkan', { alias: ['KC_INT5'] }),
  K('KC_LANG1', '\uD55C\uC601\n\u304B\u306A', 'Korean Han/Yeong / JP Mac Kana', {
    alias: ['KC_HAEN'],
  }),
  K('KC_LANG2', '\u6F22\u5B57\n\u82F1\u6570', 'Korean Hanja / JP Mac Eisu', {
    alias: ['KC_HANJ'],
  }),
]

export let KEYCODES_LAYERS: Keycode[] = []
export let KEYCODES_LAYERS_SPECIAL: Keycode[] = []
export let KEYCODES_LAYERS_MO: Keycode[] = []
export let KEYCODES_LAYERS_DF: Keycode[] = []
export let KEYCODES_LAYERS_PDF: Keycode[] = []
export let KEYCODES_LAYERS_TG: Keycode[] = []
export let KEYCODES_LAYERS_TT: Keycode[] = []
export let KEYCODES_LAYERS_OSL: Keycode[] = []
export let KEYCODES_LAYERS_TO: Keycode[] = []
export let KEYCODES_LAYERS_LT: Keycode[] = []
export let KEYCODES_LAYERS_LM: Keycode[] = []

export const RESET_KEYCODE = 'QK_BOOT'

export const KEYCODES_BOOT: Keycode[] = [
  K('QK_BOOT', 'Boot-\nloader', 'Put the keyboard into bootloader mode for flashing', {
    alias: ['RESET'],
  }),
  K('QK_REBOOT', 'Reboot', 'Reboots the keyboard. Does not load the bootloader'),
  K(
    'QK_CLEAR_EEPROM',
    'Clear\nEEPROM',
    "Reinitializes the keyboard's EEPROM (persistent memory)",
    { alias: ['EE_CLR'] },
  ),
]

const KEYCODES_MOD_OSM_LEFT: Keycode[] = [
  K('OSM(MOD_LSFT)', 'OSM\nLSft', 'Enable Left Shift for one keypress'),
  K('OSM(MOD_LCTL)', 'OSM\nLCtl', 'Enable Left Control for one keypress'),
  K('OSM(MOD_LALT)', 'OSM\nLAlt', 'Enable Left Alt for one keypress'),
  K('OSM(MOD_LGUI)', 'OSM\nLGUI', 'Enable Left GUI for one keypress'),
  K('OSM(MOD_LCTL|MOD_LSFT)', 'OSM\nLCS', 'Enable Left Control and Shift for one keypress'),
  K('OSM(MOD_LCTL|MOD_LALT)', 'OSM\nLCA', 'Enable Left Control and Alt for one keypress'),
  K('OSM(MOD_LCTL|MOD_LGUI)', 'OSM\nLCG', 'Enable Left Control and GUI for one keypress'),
  K('OSM(MOD_LSFT|MOD_LALT)', 'OSM\nLSA', 'Enable Left Shift and Alt for one keypress'),
  K('OSM(MOD_LALT|MOD_LGUI)', 'OSM\nLAG', 'Enable Left Alt and GUI for one keypress'),
  K('OSM(MOD_LSFT|MOD_LGUI)', 'OSM\nLSG', 'Enable Left Shift and GUI for one keypress'),
  K('OSM(MOD_MEH)', 'OSM\nMeh', 'Enable Left Control, Shift, and Alt for one keypress'),
  K(
    'OSM(MOD_LCTL|MOD_LSFT|MOD_LGUI)',
    'OSM\nLCSG',
    'Enable Left Control, Shift, and GUI for one keypress',
  ),
  K(
    'OSM(MOD_LCTL|MOD_LALT|MOD_LGUI)',
    'OSM\nLCAG',
    'Enable Left Control, Alt, and GUI for one keypress',
  ),
  K(
    'OSM(MOD_LSFT|MOD_LALT|MOD_LGUI)',
    'OSM\nLSAG',
    'Enable Left Shift, Alt, and GUI for one keypress',
  ),
  K(
    'OSM(MOD_HYPR)',
    'OSM\nHyper',
    'Enable Left Control, Shift, Alt, and GUI for one keypress',
  ),
]

const KEYCODES_MOD_OSM_RIGHT: Keycode[] = [
  K('OSM(MOD_RSFT)', 'OSM\nRSft', 'Enable Right Shift for one keypress'),
  K('OSM(MOD_RCTL)', 'OSM\nRCtl', 'Enable Right Control for one keypress'),
  K('OSM(MOD_RALT)', 'OSM\nRAlt', 'Enable Right Alt for one keypress'),
  K('OSM(MOD_RGUI)', 'OSM\nRGUI', 'Enable Right GUI for one keypress'),
  K(
    'OSM(MOD_RCTL|MOD_RSFT)',
    'OSM\nRCS',
    'Enable Right Control and Shift for one keypress',
  ),
  K('OSM(MOD_RCTL|MOD_RALT)', 'OSM\nRCA', 'Enable Right Control and Alt for one keypress'),
  K('OSM(MOD_RCTL|MOD_RGUI)', 'OSM\nRCG', 'Enable Right Control and GUI for one keypress'),
  K('OSM(MOD_RSFT|MOD_RALT)', 'OSM\nRSA', 'Enable Right Shift and Alt for one keypress'),
  K('OSM(MOD_RALT|MOD_RGUI)', 'OSM\nRAG', 'Enable Right Alt and GUI for one keypress'),
  K('OSM(MOD_RSFT|MOD_RGUI)', 'OSM\nRSG', 'Enable Right Shift and GUI for one keypress'),
  K(
    'OSM(MOD_RCTL|MOD_RSFT|MOD_RALT)',
    'OSM\nRMeh',
    'Enable Right Control, Shift, and Alt for one keypress',
  ),
  K(
    'OSM(MOD_RCTL|MOD_RSFT|MOD_RGUI)',
    'OSM\nRCSG',
    'Enable Right Control, Shift, and GUI for one keypress',
  ),
  K(
    'OSM(MOD_RCTL|MOD_RALT|MOD_RGUI)',
    'OSM\nRCAG',
    'Enable Right Control, Alt, and GUI for one keypress',
  ),
  K(
    'OSM(MOD_RSFT|MOD_RALT|MOD_RGUI)',
    'OSM\nRSAG',
    'Enable Right Shift, Alt, and GUI for one keypress',
  ),
  K(
    'OSM(MOD_RCTL|MOD_RSFT|MOD_RALT|MOD_RGUI)',
    'OSM\nRHyper',
    'Enable Right Control, Shift, Alt, and GUI for one keypress',
  ),
]

export const KEYCODES_MOD_OSM: Keycode[] = [
  ...KEYCODES_MOD_OSM_LEFT,
  ...KEYCODES_MOD_OSM_RIGHT,
]

const KEYCODES_MOD_MASK_LEFT: Keycode[] = [
  K('LSFT(kc)', 'LSft\n(kc)', { masked: true }),
  K('LCTL(kc)', 'LCtl\n(kc)', { masked: true }),
  K('LALT(kc)', 'LAlt\n(kc)', { masked: true }),
  K('LGUI(kc)', 'LGui\n(kc)', { masked: true }),
  K('C_S(kc)', 'LCS\n(kc)', 'LCTL + LSFT', { masked: true, alias: ['LCS(kc)'] }),
  K('LCA(kc)', 'LCA\n(kc)', 'LCTL + LALT', { masked: true }),
  K('LCG(kc)', 'LCG\n(kc)', 'LCTL + LGUI', { masked: true }),
  K('LSA(kc)', 'LSA\n(kc)', 'LSFT + LALT', { masked: true }),
  K('LAG(kc)', 'LAG\n(kc)', 'LALT + LGUI', { masked: true }),
  K('SGUI(kc)', 'LSG\n(kc)', 'LGUI + LSFT', { masked: true, alias: ['LSG(kc)'] }),
  K('MEH(kc)', 'Meh\n(kc)', 'LCTL + LSFT + LALT', { masked: true }),
  K('LCSG(kc)', 'LCSG\n(kc)', 'LCTL + LSFT + LGUI', { masked: true }),
  K('LCAG(kc)', 'LCAG\n(kc)', 'LCTL + LALT + LGUI', { masked: true }),
  K('LSAG(kc)', 'LSAG\n(kc)', 'LSFT + LALT + LGUI', { masked: true }),
  K('HYPR(kc)', 'Hyper\n(kc)', 'LCTL + LSFT + LALT + LGUI', { masked: true }),
]

const KEYCODES_MOD_MASK_RIGHT: Keycode[] = [
  K('RSFT(kc)', 'RSft\n(kc)', { masked: true }),
  K('RCTL(kc)', 'RCtl\n(kc)', { masked: true }),
  K('RALT(kc)', 'RAlt\n(kc)', { masked: true }),
  K('RGUI(kc)', 'RGui\n(kc)', { masked: true }),
  K('RCS(kc)', 'RCS\n(kc)', 'RCTL + RSFT', { masked: true }),
  K('RCA(kc)', 'RCA\n(kc)', 'RCTL + RALT', { masked: true }),
  K('RSA(kc)', 'RSA\n(kc)', 'RSFT + RALT', { masked: true }),
  K('RCG(kc)', 'RCG\n(kc)', 'RCTL + RGUI', { masked: true }),
  K('RSG(kc)', 'RSG\n(kc)', 'RSFT + RGUI', { masked: true }),
  K('RAG(kc)', 'RAG\n(kc)', 'RALT + RGUI', { masked: true }),
  K('RMEH(kc)', 'RMeh\n(kc)', 'RCTL + RSFT + RALT', { masked: true }),
  K('RCSG(kc)', 'RCSG\n(kc)', 'RCTL + RSFT + RGUI', { masked: true }),
  K('RCAG(kc)', 'RCAG\n(kc)', 'RCTL + RALT + RGUI', { masked: true }),
  K('RSAG(kc)', 'RSAG\n(kc)', 'RSFT + RALT + RGUI', { masked: true }),
  K('RHYPR(kc)', 'RHyper\n(kc)', 'RCTL + RSFT + RALT + RGUI', { masked: true }),
]

export const KEYCODES_MOD_MASK: Keycode[] = [
  ...KEYCODES_MOD_MASK_LEFT,
  ...KEYCODES_MOD_MASK_RIGHT,
]

const KEYCODES_MOD_TAP_LEFT: Keycode[] = [
  K('LSFT_T(kc)', 'LSft_T\n(kc)', 'Left Shift when held, kc when tapped', { masked: true }),
  K('LCTL_T(kc)', 'LCtl_T\n(kc)', 'Left Control when held, kc when tapped', {
    masked: true,
  }),
  K('LALT_T(kc)', 'LAlt_T\n(kc)', 'Left Alt when held, kc when tapped', { masked: true }),
  K('LGUI_T(kc)', 'LGui_T\n(kc)', 'Left GUI when held, kc when tapped', { masked: true }),
  K('C_S_T(kc)', 'LCS_T\n(kc)', 'Left Control + Left Shift when held, kc when tapped', {
    masked: true,
    alias: ['LCS_T(kc)'],
  }),
  K('LCA_T(kc)', 'LCA_T\n(kc)', 'LCTL + LALT when held, kc when tapped', { masked: true }),
  K('LCG_T(kc)', 'LCG_T\n(kc)', 'LCTL + LGUI when held, kc when tapped', { masked: true }),
  K('LSA_T(kc)', 'LSA_T\n(kc)', 'LSFT + LALT when held, kc when tapped', { masked: true }),
  K('LAG_T(kc)', 'LAG_T\n(kc)', 'LALT + LGUI when held, kc when tapped', { masked: true }),
  K('SGUI_T(kc)', 'LSG_T\n(kc)', 'LGUI + LSFT when held, kc when tapped', {
    masked: true,
    alias: ['LSG_T(kc)'],
  }),
  K('MEH_T(kc)', 'Meh_T\n(kc)', 'LCTL + LSFT + LALT when held, kc when tapped', {
    masked: true,
  }),
  K('LCSG_T(kc)', 'LCSG_T\n(kc)', 'LCTL + LSFT + LGUI when held, kc when tapped', {
    masked: true,
  }),
  K('LCAG_T(kc)', 'LCAG_T\n(kc)', 'LCTL + LALT + LGUI when held, kc when tapped', {
    masked: true,
  }),
  K('LSAG_T(kc)', 'LSAG_T\n(kc)', 'LSFT + LALT + LGUI when held, kc when tapped', {
    masked: true,
  }),
  K('ALL_T(kc)', 'ALL_T\n(kc)', 'LCTL + LSFT + LALT + LGUI when held, kc when tapped', {
    masked: true,
    alias: ['HYPR_T(kc)'],
  }),
]

const KEYCODES_MOD_TAP_RIGHT: Keycode[] = [
  K('RSFT_T(kc)', 'RSft_T\n(kc)', 'Right Shift when held, kc when tapped', { masked: true }),
  K('RCTL_T(kc)', 'RCtl_T\n(kc)', 'Right Control when held, kc when tapped', {
    masked: true,
  }),
  K('RALT_T(kc)', 'RAlt_T\n(kc)', 'Right Alt when held, kc when tapped', { masked: true }),
  K('RGUI_T(kc)', 'RGui_T\n(kc)', 'Right GUI when held, kc when tapped', { masked: true }),
  K('RCS_T(kc)', 'RCS_T\n(kc)', 'RCTL + RSFT when held, kc when tapped', { masked: true }),
  K('RCA_T(kc)', 'RCA_T\n(kc)', 'RCTL + RALT when held, kc when tapped', { masked: true }),
  K('RCG_T(kc)', 'RCG_T\n(kc)', 'RCTL + RGUI when held, kc when tapped', { masked: true }),
  K('RSA_T(kc)', 'RSA_T\n(kc)', 'RSFT + RALT when held, kc when tapped', { masked: true }),
  K('RAG_T(kc)', 'RAG_T\n(kc)', 'RALT + RGUI when held, kc when tapped', { masked: true }),
  K('RSG_T(kc)', 'RSG_T\n(kc)', 'RSFT + RGUI when held, kc when tapped', { masked: true }),
  K('RCSG_T(kc)', 'RCSG_T\n(kc)', 'RCTL + RSFT + RGUI when held, kc when tapped', {
    masked: true,
  }),
  K('RCAG_T(kc)', 'RCAG_T\n(kc)', 'RCTL + RALT + RGUI when held, kc when tapped', {
    masked: true,
  }),
  K('RSAG_T(kc)', 'RSAG_T\n(kc)', 'RSFT + RALT + RGUI when held, kc when tapped', {
    masked: true,
  }),
  K('RMEH_T(kc)', 'RMeh_T\n(kc)', 'RCTL + RSFT + RALT when held, kc when tapped', {
    masked: true,
  }),
  K('RALL_T(kc)', 'RALL_T\n(kc)', 'RCTL + RSFT + RALT + RGUI when held, kc when tapped', {
    masked: true,
  }),
]

export const KEYCODES_MOD_TAP: Keycode[] = [
  ...KEYCODES_MOD_TAP_LEFT,
  ...KEYCODES_MOD_TAP_RIGHT,
]

export const KEYCODES_MOD_SPECIAL: Keycode[] = [
  K('KC_GESC', '~\nEsc', 'Esc normally, but ~ when Shift or GUI is pressed'),
  K('KC_LSPO', 'LS\n(', 'Left Shift when held, ( when tapped'),
  K('KC_RSPC', 'RS\n)', 'Right Shift when held, ) when tapped'),
  K('KC_LCPO', 'LC\n(', 'Left Control when held, ( when tapped'),
  K('KC_RCPC', 'RC\n)', 'Right Control when held, ) when tapped'),
  K('KC_LAPO', 'LA\n(', 'Left Alt when held, ( when tapped'),
  K('KC_RAPC', 'RA\n)', 'Right Alt when held, ) when tapped'),
  K('KC_SFTENT', 'RS\nEnter', 'Right Shift when held, Enter when tapped'),
]

export const KEYCODES_MODIFIERS: Keycode[] = [
  ...KEYCODES_MOD_OSM,
  ...KEYCODES_MOD_MASK,
  ...KEYCODES_MOD_TAP,
  ...KEYCODES_MOD_SPECIAL,
]

// MOD_* Keycode entries for LM inner display — NOT added to RAWCODES_MAP
// to avoid conflicting with basic keycodes at the same numeric values.
export const KEYCODES_LM_MODS: Keycode[] = [
  new Keycode({ qmkId: 'MOD_LCTL', label: 'LCtl', tooltip: 'Left Control' }),
  new Keycode({ qmkId: 'MOD_LSFT', label: 'LSft', tooltip: 'Left Shift' }),
  new Keycode({ qmkId: 'MOD_LALT', label: 'LAlt', tooltip: 'Left Alt' }),
  new Keycode({ qmkId: 'MOD_LGUI', label: 'LGui', tooltip: 'Left GUI' }),
  new Keycode({ qmkId: 'MOD_RCTL', label: 'RCtl', tooltip: 'Right Control' }),
  new Keycode({ qmkId: 'MOD_RSFT', label: 'RSft', tooltip: 'Right Shift' }),
  new Keycode({ qmkId: 'MOD_RALT', label: 'RAlt', tooltip: 'Right Alt' }),
  new Keycode({ qmkId: 'MOD_RGUI', label: 'RGui', tooltip: 'Right GUI' }),
  new Keycode({ qmkId: 'MOD_MEH', label: 'Meh', tooltip: 'Meh (LCTL+LSFT+LALT)' }),
  new Keycode({ qmkId: 'MOD_HYPR', label: 'Hypr', tooltip: 'Hyper (LCTL+LSFT+LALT+LGUI)' }),
]

// Reverse map: mod numeric value → MOD_* qmkId (built lazily per protocol)
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

export const KEYCODES_QUANTUM_MAGIC: Keycode[] = [
  K('MAGIC_SWAP_CONTROL_CAPSLOCK', 'Swap\nCtrl\nCaps', 'Swap Caps Lock and Left Control', {
    alias: ['CL_SWAP'],
  }),
  K(
    'MAGIC_UNSWAP_CONTROL_CAPSLOCK',
    'Unswap\nCtrl\nCaps',
    'Unswap Caps Lock and Left Control',
    { alias: ['CL_NORM'] },
  ),
  K('MAGIC_CAPSLOCK_TO_CONTROL', 'Caps\nto\nCtrl', 'Treat Caps Lock as Control', {
    alias: ['CL_CTRL'],
  }),
  K(
    'MAGIC_UNCAPSLOCK_TO_CONTROL',
    'Caps\nnot to\nCtrl',
    'Stop treating Caps Lock as Control',
    { alias: ['CL_CAPS'] },
  ),
  K('MAGIC_SWAP_LCTL_LGUI', 'Swap\nLCtl\nLGui', 'Swap Left Control and GUI', {
    alias: ['LCG_SWP'],
  }),
  K('MAGIC_UNSWAP_LCTL_LGUI', 'Unswap\nLCtl\nLGui', 'Unswap Left Control and GUI', {
    alias: ['LCG_NRM'],
  }),
  K('MAGIC_SWAP_RCTL_RGUI', 'Swap\nRCtl\nRGui', 'Swap Right Control and GUI', {
    alias: ['RCG_SWP'],
  }),
  K('MAGIC_UNSWAP_RCTL_RGUI', 'Unswap\nRCtl\nRGui', 'Unswap Right Control and GUI', {
    alias: ['RCG_NRM'],
  }),
  K('MAGIC_SWAP_CTL_GUI', 'Swap\nCtl\nGui', 'Swap Control and GUI on both sides', {
    alias: ['CG_SWAP'],
  }),
  K('MAGIC_UNSWAP_CTL_GUI', 'Unswap\nCtl\nGui', 'Unswap Control and GUI on both sides', {
    alias: ['CG_NORM'],
  }),
  K(
    'MAGIC_TOGGLE_CTL_GUI',
    'Toggle\nCtl\nGui',
    'Toggle Control and GUI swap on both sides',
    { alias: ['CG_TOGG'] },
  ),
  K('MAGIC_SWAP_LALT_LGUI', 'Swap\nLAlt\nLGui', 'Swap Left Alt and GUI', {
    alias: ['LAG_SWP'],
  }),
  K('MAGIC_UNSWAP_LALT_LGUI', 'Unswap\nLAlt\nLGui', 'Unswap Left Alt and GUI', {
    alias: ['LAG_NRM'],
  }),
  K('MAGIC_SWAP_RALT_RGUI', 'Swap\nRAlt\nRGui', 'Swap Right Alt and GUI', {
    alias: ['RAG_SWP'],
  }),
  K('MAGIC_UNSWAP_RALT_RGUI', 'Unswap\nRAlt\nRGui', 'Unswap Right Alt and GUI', {
    alias: ['RAG_NRM'],
  }),
  K('MAGIC_SWAP_ALT_GUI', 'Swap\nAlt\nGui', 'Swap Alt and GUI on both sides', {
    alias: ['AG_SWAP'],
  }),
  K('MAGIC_UNSWAP_ALT_GUI', 'Unswap\nAlt\nGui', 'Unswap Alt and GUI on both sides', {
    alias: ['AG_NORM'],
  }),
  K('MAGIC_TOGGLE_ALT_GUI', 'Toggle\nAlt\nGui', 'Toggle Alt and GUI swap on both sides', {
    alias: ['AG_TOGG'],
  }),
  K('MAGIC_NO_GUI', 'GUI\nOff', 'Disable the GUI keys', { alias: ['GUI_OFF'] }),
  K('MAGIC_UNNO_GUI', 'GUI\nOn', 'Enable the GUI keys', { alias: ['GUI_ON'] }),
  K('MAGIC_TOGGLE_GUI', 'GUI\nToggle', 'Toggle the GUI keys on and off', {
    alias: ['GUI_TOGG'],
  }),
  K('MAGIC_SWAP_GRAVE_ESC', 'Swap\n`\nEsc', 'Swap ` and Escape', { alias: ['GE_SWAP'] }),
  K('MAGIC_UNSWAP_GRAVE_ESC', 'Unswap\n`\nEsc', 'Unswap ` and Escape', {
    alias: ['GE_NORM'],
  }),
  K('MAGIC_SWAP_BACKSLASH_BACKSPACE', 'Swap\n\\\nBS', 'Swap \\ and Backspace', {
    alias: ['BS_SWAP'],
  }),
  K('MAGIC_UNSWAP_BACKSLASH_BACKSPACE', 'Unswap\n\\\nBS', 'Unswap \\ and Backspace', {
    alias: ['BS_NORM'],
  }),
  K('MAGIC_HOST_NKRO', 'NKRO\nOn', 'Enable N-key rollover', { alias: ['NK_ON'] }),
  K('MAGIC_UNHOST_NKRO', 'NKRO\nOff', 'Disable N-key rollover', { alias: ['NK_OFF'] }),
  K('MAGIC_TOGGLE_NKRO', 'NKRO\nToggle', 'Toggle N-key rollover', { alias: ['NK_TOGG'] }),
  K(
    'MAGIC_EE_HANDS_LEFT',
    'EEH\nLeft',
    'Set the master half of a split keyboard as the left hand (for EE_HANDS)',
    { alias: ['EH_LEFT'] },
  ),
  K(
    'MAGIC_EE_HANDS_RIGHT',
    'EEH\nRight',
    'Set the master half of a split keyboard as the right hand (for EE_HANDS)',
    { alias: ['EH_RGHT'] },
  ),
]

export const KEYCODES_QUANTUM_AUDIO: Keycode[] = [
  K('AU_ON', 'Audio\nON', 'Audio mode on'),
  K('AU_OFF', 'Audio\nOFF', 'Audio mode off'),
  K('AU_TOG', 'Audio\nToggle', 'Toggles Audio mode'),
  K('CLICKY_TOGGLE', 'Clicky\nToggle', 'Toggles Audio clicky mode', { alias: ['CK_TOGG'] }),
  K('CLICKY_UP', 'Clicky\nUp', 'Increases frequency of the clicks', { alias: ['CK_UP'] }),
  K('CLICKY_DOWN', 'Clicky\nDown', 'Decreases frequency of the clicks', {
    alias: ['CK_DOWN'],
  }),
  K('CLICKY_RESET', 'Clicky\nReset', 'Resets frequency to default', { alias: ['CK_RST'] }),
  K('MU_ON', 'Music\nOn', 'Turns on Music Mode'),
  K('MU_OFF', 'Music\nOff', 'Turns off Music Mode'),
  K('MU_TOG', 'Music\nToggle', 'Toggles Music Mode'),
  K('MU_MOD', 'Music\nCycle', 'Cycles through the music modes'),
]

export const KEYCODES_QUANTUM_HAPTIC: Keycode[] = [
  K('HPT_ON', 'Haptic\nOn', 'Turn haptic feedback on'),
  K('HPT_OFF', 'Haptic\nOff', 'Turn haptic feedback off'),
  K('HPT_TOG', 'Haptic\nToggle', 'Toggle haptic feedback on/off'),
  K('HPT_RST', 'Haptic\nReset', 'Reset haptic feedback config to default'),
  K(
    'HPT_FBK',
    'Haptic\nFeed\nback',
    'Toggle feedback to occur on keypress, release or both',
  ),
  K('HPT_BUZ', 'Haptic\nBuzz', 'Toggle solenoid buzz on/off'),
  K('HPT_MODI', 'Haptic\nNext', 'Go to next DRV2605L waveform'),
  K('HPT_MODD', 'Haptic\nPrev', 'Go to previous DRV2605L waveform'),
  K('HPT_CONT', 'Haptic\nCont.', 'Toggle continuous haptic mode on/off'),
  K('HPT_CONI', 'Haptic\n+', 'Increase DRV2605L continous haptic strength'),
  K('HPT_COND', 'Haptic\n-', 'Decrease DRV2605L continous haptic strength'),
  K('HPT_DWLI', 'Haptic\nDwell+', 'Increase Solenoid dwell time'),
  K('HPT_DWLD', 'Haptic\nDwell-', 'Decrease Solenoid dwell time'),
]

export const KEYCODES_QUANTUM_AUTOSHIFT: Keycode[] = [
  K('KC_ASDN', 'Auto-\nshift\nDown', 'Lower the Auto Shift timeout variable (down)'),
  K('KC_ASUP', 'Auto-\nshift\nUp', 'Raise the Auto Shift timeout variable (up)'),
  K('KC_ASRP', 'Auto-\nshift\nReport', 'Report your current Auto Shift timeout value'),
  K('KC_ASON', 'Auto-\nshift\nOn', 'Turns on the Auto Shift Function'),
  K('KC_ASOFF', 'Auto-\nshift\nOff', 'Turns off the Auto Shift Function'),
  K('KC_ASTG', 'Auto-\nshift\nToggle', 'Toggles the state of the Auto Shift feature'),
]

export const KEYCODES_QUANTUM_COMBO: Keycode[] = [
  K('CMB_ON', 'Combo\nOn', 'Turns on Combo feature'),
  K('CMB_OFF', 'Combo\nOff', 'Turns off Combo feature'),
  K('CMB_TOG', 'Combo\nToggle', 'Toggles Combo feature on and off'),
]

export const KEYCODES_QUANTUM_KEY_OVERRIDE: Keycode[] = [
  K('QK_KEY_OVERRIDE_TOGGLE', 'Key\nOverride\nToggle', 'Toggle key overrides', {
    alias: ['KO_TOGG'],
  }),
  K('QK_KEY_OVERRIDE_ON', 'Key\nOverride\nOn', 'Turn on key overrides', {
    alias: ['KO_ON'],
  }),
  K('QK_KEY_OVERRIDE_OFF', 'Key\nOverride\nOff', 'Turn off key overrides', {
    alias: ['KO_OFF'],
  }),
]

export const KEYCODES_QUANTUM_REPEAT: Keycode[] = [
  K('QK_REPEAT_KEY', 'Repeat', 'Repeats the last pressed key', {
    alias: ['QK_REP'],
    requiresFeature: 'repeat_key',
  }),
  K('QK_ALT_REPEAT_KEY', 'Alt\nRepeat', 'Alt repeats the last pressed key', {
    alias: ['QK_AREP'],
    requiresFeature: 'repeat_key',
  }),
]

export const KEYCODES_QUANTUM_CAPS_WORD: Keycode[] = [
  K('QK_CAPS_WORD_TOGGLE', 'Caps\nWord', 'Capitalizes until end of current word', {
    alias: ['CW_TOGG'],
    requiresFeature: 'caps_word',
  }),
]

export const KEYCODES_QUANTUM_SWAP_HANDS: Keycode[] = [
  K('SH_TOGG', 'SH\nToggle', 'Toggle swap hands'),
  K('SH_TT', 'SH\nTT', 'Momentary swap when held, toggle when tapped'),
  K('SH_MON', 'SH\nMOn', 'Momentary swap hands on'),
  K('SH_MOFF', 'SH\nMOff', 'Momentary swap hands off'),
  K('SH_OFF', 'SH\nOff', 'Turn off swap hands'),
  K('SH_ON', 'SH\nOn', 'Turn on swap hands'),
  K('SH_OS', 'SH\nOS', 'One-shot swap hands'),
]

export const KEYCODES_QUANTUM_SWAP_HANDS_TAP: Keycode[] = [
  K('SH_T(kc)', 'SH_T\n(kc)', 'Swap hands when held, kc when tapped', { masked: true }),
]

export const KEYCODES_QUANTUM: Keycode[] = [
  ...KEYCODES_QUANTUM_MAGIC,
  ...KEYCODES_QUANTUM_AUDIO,
  ...KEYCODES_QUANTUM_HAPTIC,
  ...KEYCODES_QUANTUM_AUTOSHIFT,
  ...KEYCODES_QUANTUM_COMBO,
  ...KEYCODES_QUANTUM_KEY_OVERRIDE,
  ...KEYCODES_QUANTUM_CAPS_WORD,
  ...KEYCODES_QUANTUM_REPEAT,
  ...KEYCODES_QUANTUM_SWAP_HANDS,
  ...KEYCODES_QUANTUM_SWAP_HANDS_TAP,
]

export const KEYCODES_LIGHTING_BL: Keycode[] = [
  K('BL_TOGG', 'BL\nToggle', 'Turn the backlight on or off'),
  K('BL_STEP', 'BL\nCycle', 'Cycle through backlight levels'),
  K('BL_BRTG', 'BL\nBreath', 'Toggle backlight breathing'),
  K('BL_ON', 'BL On', 'Set the backlight to max brightness'),
  K('BL_OFF', 'BL Off', 'Turn the backlight off'),
  K('BL_INC', 'BL +', 'Increase the backlight level'),
  K('BL_DEC', 'BL - ', 'Decrease the backlight level'),
]

export const KEYCODES_LIGHTING_RGB: Keycode[] = [
  K('RGB_TOG', 'RGB\nToggle', 'Toggle RGB lighting on or off'),
  K('RGB_MOD', 'RGB\nMode +', 'Next RGB mode'),
  K('RGB_RMOD', 'RGB\nMode -', 'Previous RGB mode'),
  K('RGB_HUI', 'Hue +', 'Increase hue'),
  K('RGB_HUD', 'Hue -', 'Decrease hue'),
  K('RGB_SAI', 'Sat +', 'Increase saturation'),
  K('RGB_SAD', 'Sat -', 'Decrease saturation'),
  K('RGB_VAI', 'Bright +', 'Increase value'),
  K('RGB_VAD', 'Bright -', 'Decrease value'),
  K('RGB_SPI', 'Effect +', 'Increase RGB effect speed'),
  K('RGB_SPD', 'Effect -', 'Decrease RGB effect speed'),
  K('RGB_M_P', 'RGB\nMode P', 'RGB Mode: Plain'),
  K('RGB_M_B', 'RGB\nMode B', 'RGB Mode: Breathe'),
  K('RGB_M_R', 'RGB\nMode R', 'RGB Mode: Rainbow'),
  K('RGB_M_SW', 'RGB\nMode SW', 'RGB Mode: Swirl'),
  K('RGB_M_SN', 'RGB\nMode SN', 'RGB Mode: Snake'),
  K('RGB_M_K', 'RGB\nMode K', 'RGB Mode: Knight Rider'),
  K('RGB_M_X', 'RGB\nMode X', 'RGB Mode: Christmas'),
  K('RGB_M_G', 'RGB\nMode G', 'RGB Mode: Gradient'),
  K('RGB_M_T', 'RGB\nMode T', 'RGB Mode: Test'),
]

export const KEYCODES_LIGHTING_MATRIX: Keycode[] = [
  K('RM_ON', 'RGBM\nOn', 'Turn on RGB Matrix'),
  K('RM_OFF', 'RGBM\nOff', 'Turn off RGB Matrix'),
  K('RM_TOGG', 'RGBM\nTogg', 'Toggle RGB Matrix on or off'),
  K('RM_NEXT', 'RGBM\nNext', 'Cycle through animations'),
  K('RM_PREV', 'RGBM\nPrev', 'Cycle through animations in reverse'),
  K('RM_HUEU', 'RGBM\nHue +', 'Cycle through hue'),
  K('RM_HUED', 'RGBM\nHue -', 'Cycle through hue in reverse'),
  K('RM_SATU', 'RGBM\nSat +', 'Increase the saturation'),
  K('RM_SATD', 'RGBM\nSat -', 'Decrease the saturation'),
  K('RM_VALU', 'RGBM\nBright +', 'Increase the brightness level'),
  K('RM_VALD', 'RGBM\nBright -', 'Decrease the brightness level'),
  K('RM_SPDU', 'RGBM\nSpeed +', 'Increase the animation speed'),
  K('RM_SPDD', 'RGBM\nSpeed -', 'Decrease the animation speed'),
]

export const KEYCODES_LIGHTING_LED_MATRIX: Keycode[] = [
  K('LM_ON', 'LED\nOn', 'Turn on LED Matrix'),
  K('LM_OFF', 'LED\nOff', 'Turn off LED Matrix'),
  K('LM_TOGG', 'LED\nTogg', 'Toggle LED Matrix on or off'),
  K('LM_NEXT', 'LED\nNext', 'Cycle through LED Matrix animations'),
  K('LM_PREV', 'LED\nPrev', 'Cycle through LED Matrix animations in reverse'),
  K('LM_BRIU', 'LED\nBright +', 'Increase LED Matrix brightness'),
  K('LM_BRID', 'LED\nBright -', 'Decrease LED Matrix brightness'),
  K('LM_SPDU', 'LED\nSpeed +', 'Increase LED Matrix animation speed'),
  K('LM_SPDD', 'LED\nSpeed -', 'Decrease LED Matrix animation speed'),
]

export const KEYCODES_BACKLIGHT: Keycode[] = [
  ...KEYCODES_LIGHTING_BL,
  ...KEYCODES_LIGHTING_RGB,
  ...KEYCODES_LIGHTING_MATRIX,
  ...KEYCODES_LIGHTING_LED_MATRIX,
]

export const KEYCODES_MEDIA_FKEYS: Keycode[] = [
  K('KC_F13', 'F13'),
  K('KC_F14', 'F14'),
  K('KC_F15', 'F15'),
  K('KC_F16', 'F16'),
  K('KC_F17', 'F17'),
  K('KC_F18', 'F18'),
  K('KC_F19', 'F19'),
  K('KC_F20', 'F20'),
  K('KC_F21', 'F21'),
  K('KC_F22', 'F22'),
  K('KC_F23', 'F23'),
  K('KC_F24', 'F24'),
]

export const KEYCODES_MEDIA_SYSTEM: Keycode[] = [
  K('KC_PWR', 'Power', 'System Power Down', { alias: ['KC_SYSTEM_POWER'] }),
  K('KC_SLEP', 'Sleep', 'System Sleep', { alias: ['KC_SYSTEM_SLEEP'] }),
  K('KC_WAKE', 'Wake', 'System Wake', { alias: ['KC_SYSTEM_WAKE'] }),
  K('KC_EXEC', 'Exec', 'Execute', { alias: ['KC_EXECUTE'] }),
  K('KC_HELP', 'Help'),
  K('KC_SLCT', 'Select', { alias: ['KC_SELECT'] }),
  K('KC_STOP', 'Stop'),
  K('KC_AGIN', 'Again', { alias: ['KC_AGAIN'] }),
  K('KC_UNDO', 'Undo'),
  K('KC_CUT', 'Cut'),
  K('KC_COPY', 'Copy'),
  K('KC_PSTE', 'Paste', { alias: ['KC_PASTE'] }),
  K('KC_FIND', 'Find'),
]

export const KEYCODES_MEDIA_APP: Keycode[] = [
  K('KC_CALC', 'Calc', 'Launch Calculator (Windows)', { alias: ['KC_CALCULATOR'] }),
  K('KC_MAIL', 'Mail', 'Launch Mail (Windows)'),
  K('KC_MSEL', 'Media\nPlayer', 'Launch Media Player (Windows)', {
    alias: ['KC_MEDIA_SELECT'],
  }),
  K('KC_MYCM', 'My\nPC', 'Launch My Computer (Windows)', { alias: ['KC_MY_COMPUTER'] }),
  K('KC_WSCH', 'Browser\nSearch', 'Browser Search (Windows)', { alias: ['KC_WWW_SEARCH'] }),
  K('KC_WHOM', 'Browser\nHome', 'Browser Home (Windows)', { alias: ['KC_WWW_HOME'] }),
  K('KC_WBAK', 'Browser\nBack', 'Browser Back (Windows)', { alias: ['KC_WWW_BACK'] }),
  K('KC_WFWD', 'Browser\nForward', 'Browser Forward (Windows)', {
    alias: ['KC_WWW_FORWARD'],
  }),
  K('KC_WSTP', 'Browser\nStop', 'Browser Stop (Windows)', { alias: ['KC_WWW_STOP'] }),
  K('KC_WREF', 'Browser\nRefresh', 'Browser Refresh (Windows)', {
    alias: ['KC_WWW_REFRESH'],
  }),
  K('KC_WFAV', 'Browser\nFav.', 'Browser Favorites (Windows)', {
    alias: ['KC_WWW_FAVORITES'],
  }),
  K('KC_BRIU', 'Bright.\nUp', 'Increase the brightness of screen (Laptop)', {
    alias: ['KC_BRIGHTNESS_UP'],
  }),
  K('KC_BRID', 'Bright.\nDown', 'Decrease the brightness of screen (Laptop)', {
    alias: ['KC_BRIGHTNESS_DOWN'],
  }),
]

export const KEYCODES_MEDIA_PLAYBACK: Keycode[] = [
  K('KC_MPRV', 'Media\nPrev', 'Previous Track', { alias: ['KC_MEDIA_PREV_TRACK'] }),
  K('KC_MNXT', 'Media\nNext', 'Next Track', { alias: ['KC_MEDIA_NEXT_TRACK'] }),
  K('KC_MUTE', 'Mute', 'Mute Audio', { alias: ['KC_AUDIO_MUTE'] }),
  K('KC_VOLD', 'Vol -', 'Volume Down', { alias: ['KC_AUDIO_VOL_DOWN'] }),
  K('KC_VOLU', 'Vol +', 'Volume Up', { alias: ['KC_AUDIO_VOL_UP'] }),
  K('KC__VOLDOWN', 'Vol -\nAlt', 'Volume Down Alternate'),
  K('KC__VOLUP', 'Vol +\nAlt', 'Volume Up Alternate'),
  K('KC_MSTP', 'Media\nStop', { alias: ['KC_MEDIA_STOP'] }),
  K('KC_MPLY', 'Media\nPlay', 'Play/Pause', { alias: ['KC_MEDIA_PLAY_PAUSE'] }),
  K('KC_MRWD', 'Prev\nTrack\n(macOS)', 'Previous Track / Rewind (macOS)', {
    alias: ['KC_MEDIA_REWIND'],
  }),
  K('KC_MFFD', 'Next\nTrack\n(macOS)', 'Next Track / Fast Forward (macOS)', {
    alias: ['KC_MEDIA_FAST_FORWARD'],
  }),
  K('KC_EJCT', 'Eject', 'Eject (macOS)', { alias: ['KC_MEDIA_EJECT'] }),
]

export const KEYCODES_MEDIA_MOUSE: Keycode[] = [
  K('KC_MS_U', 'Mouse\nUp', 'Mouse Cursor Up', { alias: ['KC_MS_UP'] }),
  K('KC_MS_D', 'Mouse\nDown', 'Mouse Cursor Down', { alias: ['KC_MS_DOWN'] }),
  K('KC_MS_L', 'Mouse\nLeft', 'Mouse Cursor Left', { alias: ['KC_MS_LEFT'] }),
  K('KC_MS_R', 'Mouse\nRight', 'Mouse Cursor Right', { alias: ['KC_MS_RIGHT'] }),
  K('KC_BTN1', 'Mouse\n1', 'Mouse Button 1', { alias: ['KC_MS_BTN1'] }),
  K('KC_BTN2', 'Mouse\n2', 'Mouse Button 2', { alias: ['KC_MS_BTN2'] }),
  K('KC_BTN3', 'Mouse\n3', 'Mouse Button 3', { alias: ['KC_MS_BTN3'] }),
  K('KC_BTN4', 'Mouse\n4', 'Mouse Button 4', { alias: ['KC_MS_BTN4'] }),
  K('KC_BTN5', 'Mouse\n5', 'Mouse Button 5', { alias: ['KC_MS_BTN5'] }),
  K('KC_WH_U', 'Mouse\nWheel\nUp', { alias: ['KC_MS_WH_UP'] }),
  K('KC_WH_D', 'Mouse\nWheel\nDown', { alias: ['KC_MS_WH_DOWN'] }),
  K('KC_WH_L', 'Mouse\nWheel\nLeft', { alias: ['KC_MS_WH_LEFT'] }),
  K('KC_WH_R', 'Mouse\nWheel\nRight', { alias: ['KC_MS_WH_RIGHT'] }),
  K('KC_ACL0', 'Mouse\nAccel\n0', 'Set mouse acceleration to 0', {
    alias: ['KC_MS_ACCEL0'],
  }),
  K('KC_ACL1', 'Mouse\nAccel\n1', 'Set mouse acceleration to 1', {
    alias: ['KC_MS_ACCEL1'],
  }),
  K('KC_ACL2', 'Mouse\nAccel\n2', 'Set mouse acceleration to 2', {
    alias: ['KC_MS_ACCEL2'],
  }),
]

export const KEYCODES_MEDIA_LOCK: Keycode[] = [
  K('KC_LCAP', 'Locking\nCaps', 'Locking Caps Lock', { alias: ['KC_LOCKING_CAPS'] }),
  K('KC_LNUM', 'Locking\nNum', 'Locking Num Lock', { alias: ['KC_LOCKING_NUM'] }),
  K('KC_LSCR', 'Locking\nScroll', 'Locking Scroll Lock', { alias: ['KC_LOCKING_SCROLL'] }),
]

export const KEYCODES_MEDIA_JOYSTICK: Keycode[] = Array.from({ length: 32 }, (_, i) =>
  K(`JS_${i}`, `JS\n${i}`, `Joystick button ${i}`),
)

export const KEYCODES_MEDIA: Keycode[] = [
  ...KEYCODES_MEDIA_FKEYS,
  ...KEYCODES_MEDIA_SYSTEM,
  ...KEYCODES_MEDIA_APP,
  ...KEYCODES_MEDIA_PLAYBACK,
  ...KEYCODES_MEDIA_MOUSE,
  ...KEYCODES_MEDIA_LOCK,
  ...KEYCODES_MEDIA_JOYSTICK,
]

export let KEYCODES_TAP_DANCE: Keycode[] = []
export let KEYCODES_USER: Keycode[] = []
export let KEYCODES_MACRO: Keycode[] = []
export let KEYCODES_MACRO_M: Keycode[] = []

export const KEYCODES_MACRO_BASE: Keycode[] = [
  K('DYN_REC_START1', 'DM1\nRec', 'Dynamic Macro 1 Rec Start', { alias: ['DM_REC1'] }),
  K('DYN_REC_START2', 'DM2\nRec', 'Dynamic Macro 2 Rec Start', { alias: ['DM_REC2'] }),
  K('DYN_REC_STOP', 'DM Rec\nStop', 'Dynamic Macro Rec Stop', { alias: ['DM_RSTP'] }),
  K('DYN_MACRO_PLAY1', 'DM1\nPlay', 'Dynamic Macro 1 Play', { alias: ['DM_PLY1'] }),
  K('DYN_MACRO_PLAY2', 'DM2\nPlay', 'Dynamic Macro 2 Play', { alias: ['DM_PLY2'] }),
]

export const KEYCODES_MIDI_BASIC: Keycode[] = [
  K('MI_C', 'MI\nC', 'Midi send note C'),
  K('MI_Cs', 'MI\nC#/Db', 'Midi send note C#/Db', { alias: ['MI_Db'] }),
  K('MI_D', 'MI\nD', 'Midi send note D'),
  K('MI_Ds', 'MI\nD#/Eb', 'Midi send note D#/Eb', { alias: ['MI_Eb'] }),
  K('MI_E', 'MI\nE', 'Midi send note E'),
  K('MI_F', 'MI\nF', 'Midi send note F'),
  K('MI_Fs', 'MI\nF#/Gb', 'Midi send note F#/Gb', { alias: ['MI_Gb'] }),
  K('MI_G', 'MI\nG', 'Midi send note G'),
  K('MI_Gs', 'MI\nG#/Ab', 'Midi send note G#/Ab', { alias: ['MI_Ab'] }),
  K('MI_A', 'MI\nA', 'Midi send note A'),
  K('MI_As', 'MI\nA#/Bb', 'Midi send note A#/Bb', { alias: ['MI_Bb'] }),
  K('MI_B', 'MI\nB', 'Midi send note B'),
  ...Array.from({ length: 5 }, (_, oct) =>
    ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B'].map((note) =>
      K(`MI_${note}_${oct + 1}`, `MI\n${note}${oct + 1}`, `Midi send note ${note}${oct + 1}`),
    ),
  ).flat(),
  K('MI_ALLOFF', 'MI\nNotesOff', 'Midi send all notes OFF'),
]

export const KEYCODES_MIDI_OCTAVE: Keycode[] = [
  K('MI_OCT_N2', 'MI\nOct-2', 'Midi set octave to -2'),
  K('MI_OCT_N1', 'MI\nOct-1', 'Midi set octave to -1'),
  K('MI_OCT_0', 'MI\nOct0', 'Midi set octave to 0'),
  K('MI_OCT_1', 'MI\nOct+1', 'Midi set octave to 1'),
  K('MI_OCT_2', 'MI\nOct+2', 'Midi set octave to 2'),
  K('MI_OCT_3', 'MI\nOct+3', 'Midi set octave to 3'),
  K('MI_OCT_4', 'MI\nOct+4', 'Midi set octave to 4'),
  K('MI_OCT_5', 'MI\nOct+5', 'Midi set octave to 5'),
  K('MI_OCT_6', 'MI\nOct+6', 'Midi set octave to 6'),
  K('MI_OCT_7', 'MI\nOct+7', 'Midi set octave to 7'),
  K('MI_OCTD', 'MI\nOctDN', 'Midi move down an octave'),
  K('MI_OCTU', 'MI\nOctUP', 'Midi move up an octave'),
]

export const KEYCODES_MIDI_TRANSPOSE: Keycode[] = [
  ...Array.from({ length: 13 }, (_, i) => {
    const n = i - 6
    const sign = n < 0 ? '' : n > 0 ? '+' : ''
    return K(
      `MI_TRNS_${n < 0 ? 'N' + Math.abs(n) : String(n)}`,
      `MI\nTrans${sign}${n}`,
      `Midi set transposition to ${n} semitones`,
    )
  }),
  K('MI_TRNSD', 'MI\nTransDN', 'Midi decrease transposition'),
  K('MI_TRNSU', 'MI\nTransUP', 'Midi increase transposition'),
]

export const KEYCODES_MIDI_VELOCITY: Keycode[] = [
  ...Array.from({ length: 10 }, (_, i) =>
    K(`MI_VEL_${i + 1}`, `MI\nVel${i + 1}`, `Midi set velocity to ${i + 1}`),
  ),
  K('MI_VELD', 'MI\nVelDN', 'Midi decrease velocity'),
  K('MI_VELU', 'MI\nVelUP', 'Midi increase velocity'),
]

export const KEYCODES_MIDI_CHANNEL: Keycode[] = [
  ...Array.from({ length: 16 }, (_, i) =>
    K(`MI_CH${i + 1}`, `MI\nCH${i + 1}`, `Midi set channel to ${i + 1}`),
  ),
  K('MI_CHD', 'MI\nCHDN', 'Midi decrease channel'),
  K('MI_CHU', 'MI\nCHUP', 'Midi increase channel'),
]

export const KEYCODES_MIDI_CONTROL: Keycode[] = [
  K('MI_SUS', 'MI\nSust', 'Midi Sustain'),
  K('MI_PORT', 'MI\nPort', 'Midi Portmento'),
  K('MI_SOST', 'MI\nSost', 'Midi Sostenuto'),
  K('MI_SOFT', 'MI\nSPedal', 'Midi Soft Pedal'),
  K('MI_LEG', 'MI\nLegat', 'Midi Legato'),
  K('MI_MOD', 'MI\nModul', 'Midi Modulation'),
  K('MI_MODSD', 'MI\nModulDN', 'Midi decrease modulation speed'),
  K('MI_MODSU', 'MI\nModulUP', 'Midi increase modulation speed'),
  K('MI_BENDD', 'MI\nBendDN', 'Midi bend pitch down'),
  K('MI_BENDU', 'MI\nBendUP', 'Midi bend pitch up'),
]

export const KEYCODES_MIDI_SEQUENCER: Keycode[] = [
  K('SQ_ON', 'SQ\nOn', 'Sequencer on'),
  K('SQ_OFF', 'SQ\nOff', 'Sequencer off'),
  K('SQ_TOGG', 'SQ\nToggle', 'Toggle sequencer'),
  K('SQ_TMPD', 'SQ\nTempo-', 'Decrease sequencer tempo'),
  K('SQ_TMPU', 'SQ\nTempo+', 'Increase sequencer tempo'),
  K('SQ_RESD', 'SQ\nRes-', 'Decrease sequencer resolution'),
  K('SQ_RESU', 'SQ\nRes+', 'Increase sequencer resolution'),
  K('SQ_SALL', 'SQ\nAll', 'Select all sequencer steps'),
  K('SQ_SCLR', 'SQ\nClear', 'Clear all sequencer steps'),
]

export const KEYCODES_MIDI_ADVANCED: Keycode[] = [
  ...KEYCODES_MIDI_OCTAVE,
  ...KEYCODES_MIDI_TRANSPOSE,
  ...KEYCODES_MIDI_VELOCITY,
  ...KEYCODES_MIDI_CHANNEL,
  ...KEYCODES_MIDI_CONTROL,
  ...KEYCODES_MIDI_SEQUENCER,
]

export let KEYCODES_MIDI: Keycode[] = []

// Hidden keycodes: TD(0)-TD(255)
export const KEYCODES_HIDDEN: Keycode[] = Array.from({ length: 256 }, (_, x) =>
  K(`TD(${x})`, `TD(${x})`),
)

// --- Global keycode maps ---

export let KEYCODES: Keycode[] = []
export let KEYCODES_MAP: Map<string, Keycode> = new Map()
export let RAWCODES_MAP: Map<number, Keycode> = new Map()

// --- resolve helper ---

export function resolve(qmkConstant: string): number {
  const kcMap = protocol === 6 ? keycodesV6.kc : keycodesV5.kc
  if (!(qmkConstant in kcMap)) {
    throw new Error(`unable to resolve qmk_id=${qmkConstant}`)
  }
  return kcMap[qmkConstant]
}

// --- LM (Layer Mod) helpers ---
// LM bit layout doesn't align with the standard 0xff00/0x00ff masked split,
// so we handle it with custom serialize/detect functions.

interface LMConfig {
  base: number
  shift: number
  modMask: number
  maxCode: number
}

function getLMConfig(): LMConfig {
  const kcMap = protocol === 6 ? keycodesV6.kc : keycodesV5.kc
  const base = kcMap.QK_LAYER_MOD
  const shift = kcMap.QMK_LM_SHIFT
  const modMask = kcMap.QMK_LM_MASK
  return { base, shift, modMask, maxCode: base | (0x0f << shift) | modMask }
}

function serializeLM(code: number): string | null {
  const { base, shift, modMask, maxCode } = getLMConfig()
  if (code < base || code > maxCode) return null

  const layer = (code >> shift) & 0x0f
  const mod = code & modMask
  const modName = getLMModValueMap().get(mod)
  if (modName) return `LM${layer}(${modName})`
  return `LM${layer}(0x${mod.toString(16)})`
}

export function isLMKeycode(code: number): boolean {
  const { base, maxCode } = getLMConfig()
  return code >= base && code <= maxCode
}

// --- Serialize / Deserialize ---

export function serialize(code: number): string {
  // LM needs custom handling before standard masked path
  const lmResult = serializeLM(code)
  if (lmResult) return lmResult

  const masked = protocol === 6 ? keycodesV6.masked : keycodesV5.masked

  if (!masked.has(code & 0xff00)) {
    const kc = RAWCODES_MAP.get(code)
    if (kc !== undefined) {
      return kc.qmkId
    }
  } else {
    const outer = RAWCODES_MAP.get(code & 0xff00)
    const inner = RAWCODES_MAP.get(code & 0x00ff)
    if (outer !== undefined && inner !== undefined) {
      return outer.qmkId.replace('kc', inner.qmkId)
    }
    const kc = RAWCODES_MAP.get(code)
    if (kc !== undefined) {
      return kc.qmkId
    }
  }
  return '0x' + code.toString(16)
}

// Outer mask qmkIds not defined in vial-gui/vial-qmk
const PIPETTE_ONLY_OUTER_MASKS = new Set([
  // Modifier Masks (12)
  'LCSG(kc)', 'LSAG(kc)',
  'RCS(kc)', 'RCA(kc)', 'RSA(kc)', 'RMEH(kc)', 'RSG(kc)',
  'RCSG(kc)', 'RAG(kc)', 'RCAG(kc)', 'RSAG(kc)', 'RHYPR(kc)',
  // Mod-Tap (11)
  'LCSG_T(kc)', 'LSAG_T(kc)',
  'RCS_T(kc)', 'RCA_T(kc)', 'RSA_T(kc)', 'RAG_T(kc)', 'RSG_T(kc)',
  'RCSG_T(kc)', 'RSAG_T(kc)', 'RMEH_T(kc)', 'RALL_T(kc)',
  // Swap Hands Tap (1)
  'SH_T(kc)',
])

const PIPETTE_ONLY_PREFIXES = ['SH_', 'SQ_', 'LM_', 'JS_', 'PB_', 'QK_KEY_OVERRIDE_']

function isPipetteOnlyNonMasked(qmkId: string): boolean {
  return PIPETTE_ONLY_PREFIXES.some((p) => qmkId.startsWith(p))
}

function toHex(code: number): string {
  return '0x' + code.toString(16)
}

export function serializeForCExport(code: number): string {
  if (isLMKeycode(code)) return toHex(code)

  const masked = protocol === 6 ? keycodesV6.masked : keycodesV5.masked

  if (masked.has(code & 0xff00)) {
    const outer = RAWCODES_MAP.get(code & 0xff00)
    if (outer !== undefined && PIPETTE_ONLY_OUTER_MASKS.has(outer.qmkId)) {
      return toHex(code)
    }
  } else {
    const kc = RAWCODES_MAP.get(code)
    if (kc !== undefined && isPipetteOnlyNonMasked(kc.qmkId)) {
      return toHex(code)
    }
  }

  return serialize(code)
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
    ...KEYCODES_BACKLIGHT,
    ...KEYCODES_MEDIA,
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
    ...KEYCODES_LAYERS,
    ...KEYCODES_BOOT,
    ...KEYCODES_MODIFIERS,
    ...KEYCODES_QUANTUM,
    ...KEYCODES_BACKLIGHT,
    ...KEYCODES_MEDIA,
    ...KEYCODES_TAP_DANCE,
    ...KEYCODES_MACRO,
    ...KEYCODES_USER,
    ...KEYCODES_HIDDEN,
    ...KEYCODES_MIDI,
  )
  KEYCODES_MAP.clear()
  RAWCODES_MAP.clear()
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
  KEYCODES_USER = []
  for (let x = 0; x < 16; x++) {
    KEYCODES_USER.push(
      new Keycode({
        qmkId: `USER${String(x).padStart(2, '0')}`,
        label: `User ${x}`,
        tooltip: `User keycode ${x}`,
      }),
    )
  }
}

export interface CustomKeycodeDefinition {
  name?: string
  title?: string
  shortName?: string
}

export function createCustomUserKeycodes(
  customKeycodes: CustomKeycodeDefinition[],
): void {
  KEYCODES_USER = []
  for (let x = 0; x < customKeycodes.length; x++) {
    const c = customKeycodes[x]
    KEYCODES_USER.push(
      new Keycode({
        qmkId: `USER${String(x).padStart(2, '0')}`,
        label: c.shortName ?? `USER${String(x).padStart(2, '0')}`,
        tooltip: c.title ?? `USER${String(x).padStart(2, '0')}`,
        alias: [c.name ?? `USER${String(x).padStart(2, '0')}`],
      }),
    )
  }
}

// --- MIDI keycodes ---

export function createMidiKeycodes(midiSettingLevel: string): void {
  KEYCODES_MIDI = []
  if (midiSettingLevel === 'basic' || midiSettingLevel === 'advanced') {
    KEYCODES_MIDI.push(...KEYCODES_MIDI_BASIC)
  }
  if (midiSettingLevel === 'advanced') {
    KEYCODES_MIDI.push(...KEYCODES_MIDI_ADVANCED)
  }
}

// --- Keyboard-specific keycodes ---

export interface KeyboardKeycodeContext {
  vialProtocol: number
  layers: number
  macroCount: number
  tapDanceCount: number
  customKeycodes: CustomKeycodeDefinition[] | null
  midi: string
  supportedFeatures: Set<string>
}

export function recreateKeyboardKeycodes(keyboard: KeyboardKeycodeContext): void {
  protocol = keyboard.vialProtocol
  const layers = keyboard.layers

  KEYCODES_LAYERS_SPECIAL = [
    new Keycode({
      qmkId: 'QK_LAYER_LOCK',
      label: 'Layer\nLock',
      tooltip: 'Locks the current layer',
      alias: ['QK_LLCK'],
      requiresFeature: 'layer_lock',
    }),
  ]
  if (layers >= 4) {
    KEYCODES_LAYERS_SPECIAL.push(new Keycode({ qmkId: 'FN_MO13', label: 'Fn1\n(Fn3)' }))
    KEYCODES_LAYERS_SPECIAL.push(new Keycode({ qmkId: 'FN_MO23', label: 'Fn2\n(Fn3)' }))
  }

  KEYCODES_LAYERS_MO = []
  KEYCODES_LAYERS_DF = []
  KEYCODES_LAYERS_PDF = []
  KEYCODES_LAYERS_TG = []
  KEYCODES_LAYERS_TT = []
  KEYCODES_LAYERS_OSL = []
  KEYCODES_LAYERS_TO = []

  const layerKeycodeTypes: [string, string, Keycode[], string?][] = [
    ['MO', 'Momentarily turn on layer when pressed (requires KC_TRNS on destination layer)', KEYCODES_LAYERS_MO],
    ['DF', 'Set the base (default) layer', KEYCODES_LAYERS_DF],
    ['PDF', 'Persistently set the base (default) layer', KEYCODES_LAYERS_PDF, 'persistent_default_layer'],
    ['TG', 'Toggle layer on or off', KEYCODES_LAYERS_TG],
    ['TT', 'Normally acts like MO unless it\'s tapped multiple times, which toggles layer on', KEYCODES_LAYERS_TT],
    ['OSL', 'Momentarily activates layer until a key is pressed', KEYCODES_LAYERS_OSL],
    ['TO', 'Turns on layer and turns off all other layers, except the default layer', KEYCODES_LAYERS_TO],
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

  KEYCODES_LAYERS_LT = []
  for (let x = 0; x < Math.min(layers, 16); x++) {
    KEYCODES_LAYERS_LT.push(
      new Keycode({
        qmkId: `LT${x}(kc)`,
        label: `LT ${x}\n(kc)`,
        tooltip: `kc on tap, switch to layer ${x} while held`,
        masked: true,
      }),
    )
  }

  KEYCODES_LAYERS_LM = []
  for (let x = 0; x < Math.min(layers, 16); x++) {
    KEYCODES_LAYERS_LM.push(
      new Keycode({
        qmkId: `LM${x}(kc)`,
        label: `LM ${x}\n(kc)`,
        tooltip: `Momentarily activates layer ${x} with modifier`,
        masked: true,
      }),
    )
  }

  KEYCODES_LAYERS = [
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
  ]

  KEYCODES_MACRO_M = []
  for (let x = 0; x < keyboard.macroCount; x++) {
    const lbl = `M${x}`
    KEYCODES_MACRO_M.push(new Keycode({ qmkId: lbl, label: lbl }))
  }
  KEYCODES_MACRO = [...KEYCODES_MACRO_M, ...KEYCODES_MACRO_BASE]

  KEYCODES_TAP_DANCE = []
  for (let x = 0; x < keyboard.tapDanceCount; x++) {
    const lbl = `TD(${x})`
    KEYCODES_TAP_DANCE.push(
      new Keycode({ qmkId: lbl, label: lbl, tooltip: 'Tap dance keycode' }),
    )
  }

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
  return protocol
}

export function setProtocol(p: number): void {
  protocol = p
}

// --- Initialize ---
recreateKeycodes()
