// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach } from 'vitest'
import { keycodesV5 } from '../keycodes-v5'
import { keycodesV6 } from '../keycodes-v6'
import {
  Keycode,
  serialize,
  deserialize,
  normalize,
  resolve,
  isMask,
  isBasic,
  findKeycode,
  findOuterKeycode,
  findInnerKeycode,
  findByRecorderAlias,
  findByQmkId,
  keycodeLabel,
  keycodeTooltip,
  recreateKeycodes,
  recreateKeyboardKeycodes,
  setProtocol,
  getProtocol,
  isTapDanceKeycode,
  getTapDanceIndex,
  isMacroKeycode,
  getMacroIndex,
  isResetKeycode,
  KEYCODES,
  KEYCODES_MAP,
  KEYCODES_BASIC,
  KEYCODES_SPECIAL,
  KEYCODES_SHIFTED,
  KEYCODES_ISO,
  KEYCODES_BOOT,
  KEYCODES_MODIFIERS,
  KEYCODES_QUANTUM,
  KEYCODES_BACKLIGHT,
  KEYCODES_MEDIA,
  KEYCODES_MIDI_BASIC,
  KEYCODES_MIDI_ADVANCED,
  KEYCODES_MACRO_BASE,
  KEYCODES_HIDDEN,
  createCustomUserKeycodes,
  isLMKeycode,
  KEYCODES_LM_MODS,
  getAvailableLMMods,
  KEYCODES_QUANTUM_SWAP_HANDS,
  KEYCODES_QUANTUM_SWAP_HANDS_TAP,
  KEYCODES_MIDI_SEQUENCER,
  KEYCODES_MEDIA_JOYSTICK,
  KEYCODES_LIGHTING_LED_MATRIX,
  type KeyboardKeycodeContext,
  type CustomKeycodeDefinition,
} from '../keycodes'

// --- V5 mapping tests ---

describe('keycodesV5', () => {
  it('has correct base addresses', () => {
    expect(keycodesV5.kc.QK_MOMENTARY).toBe(0x5100)
    expect(keycodesV5.kc.QK_MOD_TAP).toBe(0x6000)
    expect(keycodesV5.kc.QK_LAYER_MOD).toBe(0x5900)
    expect(keycodesV5.kc.QK_LAYER_TAP).toBe(0x4000)
    expect(keycodesV5.kc.QK_BOOT).toBe(0x5c00)
  })

  it('generates MO(0)-MO(31)', () => {
    expect(keycodesV5.kc['MO(0)']).toBe(0x5100)
    expect(keycodesV5.kc['MO(1)']).toBe(0x5101)
    expect(keycodesV5.kc['MO(31)']).toBe(0x511f)
  })

  it('generates TD(0)-TD(255)', () => {
    expect(keycodesV5.kc['TD(0)']).toBe(0x5700)
    expect(keycodesV5.kc['TD(255)']).toBe(0x57ff)
  })

  it('generates M0-M255 macro keycodes', () => {
    expect(keycodesV5.kc.M0).toBe(keycodesV5.kc.QK_MACRO)
    expect(keycodesV5.kc.M1).toBe(keycodesV5.kc.QK_MACRO + 1)
    expect(keycodesV5.kc.M255).toBe(keycodesV5.kc.QK_MACRO + 255)
  })

  it('generates LT0(kc)-LT15(kc) masked keycodes', () => {
    expect(keycodesV5.kc['LT0(kc)']).toBe(0x4000)
    expect(keycodesV5.kc['LT1(kc)']).toBe(0x4100)
    expect(keycodesV5.kc['LT15(kc)']).toBe(0x4f00)
  })

  it('generates USER00-USER63', () => {
    expect(keycodesV5.kc.USER00).toBe(keycodesV5.kc.QK_KB)
    expect(keycodesV5.kc.USER63).toBe(keycodesV5.kc.QK_KB + 63)
  })

  it('populates masked set from entries ending with (kc)', () => {
    expect(keycodesV5.masked.has(keycodesV5.kc['LSFT(kc)'])).toBe(true)
    expect(keycodesV5.masked.has(keycodesV5.kc['LCTL(kc)'])).toBe(true)
    expect(keycodesV5.masked.has(keycodesV5.kc['LT0(kc)'])).toBe(true)
    expect(keycodesV5.masked.has(keycodesV5.kc.KC_A)).toBe(false)
  })

  it('has basic keycodes matching HID usage codes', () => {
    expect(keycodesV5.kc.KC_A).toBe(0x04)
    expect(keycodesV5.kc.KC_Z).toBe(0x1d)
    expect(keycodesV5.kc.KC_1).toBe(0x1e)
    expect(keycodesV5.kc.KC_0).toBe(0x27)
    expect(keycodesV5.kc.KC_ENTER).toBe(0x28)
    expect(keycodesV5.kc.KC_SPACE).toBe(0x2c)
  })

  it('contains TO(x) with ON_PRESS bit', () => {
    // v5 TO uses (1 << 4) | x pattern
    expect(keycodesV5.kc['TO(0)']).toBe(0x5000 | (1 << 4) | 0)
    expect(keycodesV5.kc['TO(1)']).toBe(0x5000 | (1 << 4) | 1)
  })

  it('has fake keycodes for features not in v5', () => {
    expect(keycodesV5.kc.RM_ON).toBe(0x9990)
    expect(keycodesV5.kc.QK_REBOOT).toBe(0x999d)
    expect(keycodesV5.kc.QK_CAPS_WORD_TOGGLE).toBe(0x999e)
    expect(keycodesV5.kc.QK_KEY_OVERRIDE_TOGGLE).toBe(0x999c3)
    expect(keycodesV5.kc.QK_KEY_OVERRIDE_ON).toBe(0x999c4)
    expect(keycodesV5.kc.QK_KEY_OVERRIDE_OFF).toBe(0x999c5)
  })
})

// --- V6 mapping tests ---

describe('keycodesV6', () => {
  it('has correct base addresses (different from v5)', () => {
    expect(keycodesV6.kc.QK_MOMENTARY).toBe(0x5220)
    expect(keycodesV6.kc.QK_MOD_TAP).toBe(0x2000)
    expect(keycodesV6.kc.QK_LAYER_MOD).toBe(0x5000)
    expect(keycodesV6.kc.QK_BOOT).toBe(0x7c00)
    expect(keycodesV6.kc.QK_MACRO).toBe(0x7700)
  })

  it('generates MO(0)-MO(31)', () => {
    expect(keycodesV6.kc['MO(0)']).toBe(0x5220)
    expect(keycodesV6.kc['MO(1)']).toBe(0x5221)
    expect(keycodesV6.kc['MO(31)']).toBe(0x523f)
  })

  it('generates TO(x) without ON_PRESS bit (different from v5)', () => {
    // v6 TO uses simple addition
    expect(keycodesV6.kc['TO(0)']).toBe(0x5200)
    expect(keycodesV6.kc['TO(1)']).toBe(0x5201)
  })

  it('has QK_PERSISTENT_DEF_LAYER (v6 only real keycode)', () => {
    expect(keycodesV6.kc.QK_PERSISTENT_DEF_LAYER).toBe(0x52e0)
    expect(keycodesV6.kc['PDF(0)']).toBe(0x52e0)
    expect(keycodesV6.kc['PDF(1)']).toBe(0x52e1)
  })

  it('has RM_* at proper addresses (not fake)', () => {
    expect(keycodesV6.kc.RM_ON).toBe(0x7840)
    expect(keycodesV6.kc.RM_TOGG).toBe(0x7842)
  })

  it('has QK_REPEAT_KEY and QK_ALT_REPEAT_KEY', () => {
    expect(keycodesV6.kc.QK_REPEAT_KEY).toBe(0x7c79)
    expect(keycodesV6.kc.QK_ALT_REPEAT_KEY).toBe(0x7c7a)
  })

  it('has QK_KEY_OVERRIDE_TOGGLE, ON, OFF', () => {
    expect(keycodesV6.kc.QK_KEY_OVERRIDE_TOGGLE).toBe(0x7c5d)
    expect(keycodesV6.kc.QK_KEY_OVERRIDE_ON).toBe(0x7c5e)
    expect(keycodesV6.kc.QK_KEY_OVERRIDE_OFF).toBe(0x7c5f)
  })

  it('has LM0(kc)-LM15(kc) masked keycodes', () => {
    // v6: QK_LAYER_MOD=0x5000, layer<<5, mod bits zeroed for masked base
    expect(keycodesV6.kc['LM0(kc)']).toBe(0x5000 | (0 << 5))
    expect(keycodesV6.kc['LM1(kc)']).toBe(0x5000 | (1 << 5))
    expect(keycodesV6.kc['LM15(kc)']).toBe(0x5000 | (15 << 5))
    // v5: QK_LAYER_MOD=0x5900, layer<<4
    expect(keycodesV5.kc['LM0(kc)']).toBe(0x5900 | (0 << 4))
    expect(keycodesV5.kc['LM1(kc)']).toBe(0x5900 | (1 << 4))
    expect(keycodesV5.kc['LM15(kc)']).toBe(0x5900 | (15 << 4))
  })

  it('LM entries are in the masked set', () => {
    expect(keycodesV6.masked.has(keycodesV6.kc['LM0(kc)'])).toBe(true)
    expect(keycodesV6.masked.has(keycodesV6.kc['LM15(kc)'])).toBe(true)
    expect(keycodesV5.masked.has(keycodesV5.kc['LM0(kc)'])).toBe(true)
  })

  it('basic keycodes are identical between v5 and v6', () => {
    expect(keycodesV6.kc.KC_A).toBe(keycodesV5.kc.KC_A)
    expect(keycodesV6.kc.KC_Z).toBe(keycodesV5.kc.KC_Z)
    expect(keycodesV6.kc.KC_ENTER).toBe(keycodesV5.kc.KC_ENTER)
    expect(keycodesV6.kc.KC_SPACE).toBe(keycodesV5.kc.KC_SPACE)
  })

  it('modifier codes are identical between v5 and v6', () => {
    expect(keycodesV6.kc.MOD_LCTL).toBe(keycodesV5.kc.MOD_LCTL)
    expect(keycodesV6.kc.MOD_LSFT).toBe(keycodesV5.kc.MOD_LSFT)
    expect(keycodesV6.kc.QK_LCTL).toBe(keycodesV5.kc.QK_LCTL)
    expect(keycodesV6.kc.QK_LSFT).toBe(keycodesV5.kc.QK_LSFT)
  })
})

// --- Keycode class tests ---

describe('Keycode class', () => {
  it('creates instance with correct properties', () => {
    const kc = new Keycode({
      qmkId: 'TEST_KC',
      label: 'Test',
      tooltip: 'Test tooltip',
      masked: false,
      printable: 't',
      recorderAlias: ['test'],
      alias: ['TEST_ALIAS'],
    })
    expect(kc.qmkId).toBe('TEST_KC')
    expect(kc.label).toBe('Test')
    expect(kc.tooltip).toBe('Test tooltip')
    expect(kc.masked).toBe(false)
    expect(kc.printable).toBe('t')
    expect(kc.alias).toEqual(['TEST_KC', 'TEST_ALIAS'])
    expect(kc.hidden).toBe(false)
  })

  it('isSupportedBy returns true when no feature required', () => {
    const kc = new Keycode({ qmkId: 'TEST1', label: 'T' })
    expect(kc.isSupportedBy(new Set())).toBe(true)
  })

  it('isSupportedBy checks feature set', () => {
    const kc = new Keycode({
      qmkId: 'TEST2',
      label: 'T',
      requiresFeature: 'caps_word',
    })
    expect(kc.isSupportedBy(new Set())).toBe(false)
    expect(kc.isSupportedBy(new Set(['caps_word']))).toBe(true)
  })
})

// --- Core keycode system tests ---

describe('Core keycode system', () => {
  beforeEach(() => {
    setProtocol(0)
    recreateKeycodes()
  })

  it('KEYCODES array is populated', () => {
    expect(KEYCODES.length).toBeGreaterThan(0)
  })

  it('KEYCODES_MAP maps qmk_id (without kc suffix) to keycode', () => {
    expect(KEYCODES_MAP.get('KC_A')?.qmkId).toBe('KC_A')
    expect(KEYCODES_MAP.get('LSFT')?.qmkId).toBe('LSFT(kc)')
  })

  it('contains all category arrays', () => {
    expect(KEYCODES_SPECIAL.length).toBe(2)
    expect(KEYCODES_BASIC.length).toBeGreaterThan(50)
    expect(KEYCODES_SHIFTED.length).toBe(21)
    expect(KEYCODES_ISO.length).toBe(9)
    expect(KEYCODES_BOOT.length).toBe(3)
    expect(KEYCODES_MODIFIERS.length).toBeGreaterThan(30)
    expect(KEYCODES_QUANTUM.length).toBeGreaterThan(30)
    expect(KEYCODES_BACKLIGHT.length).toBeGreaterThan(20)
    expect(KEYCODES_MEDIA.length).toBeGreaterThan(40)
    expect(KEYCODES_MACRO_BASE.length).toBe(5)
    expect(KEYCODES_HIDDEN.length).toBe(256)
    expect(KEYCODES_MIDI_BASIC.length).toBeGreaterThan(10)
    expect(KEYCODES_MIDI_ADVANCED.length).toBeGreaterThan(10)
  })
})

// --- resolve() tests ---

describe('resolve()', () => {
  it('resolves v5 keycodes by default', () => {
    setProtocol(0)
    expect(resolve('KC_A')).toBe(0x04)
    expect(resolve('QK_MOMENTARY')).toBe(0x5100)
    expect(resolve('QK_MOD_TAP')).toBe(0x6000)
  })

  it('resolves v6 keycodes when protocol is 6', () => {
    setProtocol(6)
    expect(resolve('KC_A')).toBe(0x04)
    expect(resolve('QK_MOMENTARY')).toBe(0x5220)
    expect(resolve('QK_MOD_TAP')).toBe(0x2000)
  })

  it('throws for unknown constants', () => {
    expect(() => resolve('NONEXISTENT_KEY')).toThrow()
  })
})

// --- serialize() tests ---

describe('serialize()', () => {
  beforeEach(() => {
    setProtocol(0)
    recreateKeycodes()
  })

  it('serializes basic keycode', () => {
    expect(serialize(0x04)).toBe('KC_A')
    expect(serialize(0x28)).toBe('KC_ENTER')
  })

  it('serializes KC_NO and KC_TRNS', () => {
    expect(serialize(0x00)).toBe('KC_NO')
    expect(serialize(0x01)).toBe('KC_TRNS')
  })

  it('serializes masked keycodes (e.g. LSFT(KC_A))', () => {
    const lsftA = keycodesV5.kc['LSFT(kc)'] | keycodesV5.kc.KC_A
    expect(serialize(lsftA)).toBe('LSFT(KC_A)')
  })

  it.each([
    ['KC_TILD', 'LSFT(KC_GRAVE)'],
    ['KC_EXLM', 'LSFT(KC_1)'],
    ['KC_AT', 'LSFT(KC_2)'],
    ['KC_HASH', 'LSFT(KC_3)'],
    ['KC_DLR', 'LSFT(KC_4)'],
    ['KC_PERC', 'LSFT(KC_5)'],
    ['KC_CIRC', 'LSFT(KC_6)'],
    ['KC_AMPR', 'LSFT(KC_7)'],
    ['KC_ASTR', 'LSFT(KC_8)'],
    ['KC_LPRN', 'LSFT(KC_9)'],
    ['KC_RPRN', 'LSFT(KC_0)'],
    ['KC_UNDS', 'LSFT(KC_MINUS)'],
    ['KC_PLUS', 'LSFT(KC_EQUAL)'],
    ['KC_LCBR', 'LSFT(KC_LBRACKET)'],
    ['KC_RCBR', 'LSFT(KC_RBRACKET)'],
    ['KC_LT', 'LSFT(KC_COMMA)'],
    ['KC_GT', 'LSFT(KC_DOT)'],
    ['KC_COLN', 'LSFT(KC_SCOLON)'],
    ['KC_PIPE', 'LSFT(KC_BSLASH)'],
    ['KC_QUES', 'LSFT(KC_SLASH)'],
    ['KC_DQUO', 'LSFT(KC_QUOTE)'],
  ])('decomposes %s to %s', (shifted, expected) => {
    expect(serialize(keycodesV5.kc[shifted])).toBe(expected)
  })

  it('decomposes non-named LSFT combos', () => {
    const lsftB = keycodesV5.kc['LSFT(kc)'] | keycodesV5.kc.KC_B
    expect(serialize(lsftB)).toBe('LSFT(KC_B)')
  })

  it('decomposes shifted keycodes into mask form (v6)', () => {
    setProtocol(6)
    recreateKeycodes()
    // Spot-check representative keycodes in v6 protocol
    expect(serialize(keycodesV6.kc.KC_EXLM)).toBe('LSFT(KC_1)')
    expect(serialize(keycodesV6.kc.KC_AT)).toBe('LSFT(KC_2)')
    expect(serialize(keycodesV6.kc.KC_TILD)).toBe('LSFT(KC_GRAVE)')
    expect(serialize(keycodesV6.kc.KC_PIPE)).toBe('LSFT(KC_BSLASH)')
    expect(serialize(keycodesV6.kc.KC_QUES)).toBe('LSFT(KC_SLASH)')
    const lsftB = keycodesV6.kc['LSFT(kc)'] | keycodesV6.kc.KC_B
    expect(serialize(lsftB)).toBe('LSFT(KC_B)')
  })

  it('returns hex for unknown codes', () => {
    expect(serialize(0xffff)).toBe('0xffff')
  })

  it('serializes LM keycodes with custom bit layout (v5)', () => {
    // v5: LM0 + MOD_LCTL = 0x5900 | (0 << 4) | 0x01
    expect(serialize(0x5900 | (0 << 4) | 0x01)).toBe('LM0(MOD_LCTL)')
    // v5: LM1 + MOD_LSFT = 0x5900 | (1 << 4) | 0x02
    expect(serialize(0x5900 | (1 << 4) | 0x02)).toBe('LM1(MOD_LSFT)')
    // v5: LM15 + MOD_LGUI = 0x5900 | (15 << 4) | 0x08
    expect(serialize(0x5900 | (15 << 4) | 0x08)).toBe('LM15(MOD_LGUI)')
  })

  it('serializes LM keycodes with custom bit layout (v6)', () => {
    setProtocol(6)
    recreateKeycodes()
    // v6: LM0 + MOD_LCTL = 0x5000 | (0 << 5) | 0x01
    expect(serialize(0x5000 | (0 << 5) | 0x01)).toBe('LM0(MOD_LCTL)')
    // v6: LM3 + MOD_RALT = 0x5000 | (3 << 5) | 0x14
    expect(serialize(0x5000 | (3 << 5) | 0x14)).toBe('LM3(MOD_RALT)')
    // v6: LM15 + MOD_HYPR = 0x5000 | (15 << 5) | 0x0f
    expect(serialize(0x5000 | (15 << 5) | 0x0f)).toBe('LM15(MOD_HYPR)')
  })
})

// --- deserialize() tests ---

describe('deserialize()', () => {
  beforeEach(() => {
    setProtocol(0)
    recreateKeycodes()
  })

  it('deserializes integer passthrough', () => {
    expect(deserialize(0x04)).toBe(0x04)
  })

  it('deserializes basic keycode names', () => {
    expect(deserialize('KC_A')).toBe(keycodesV5.kc.KC_A)
    expect(deserialize('KC_ENTER')).toBe(keycodesV5.kc.KC_ENTER)
  })

  it('deserializes expressions like LSFT(KC_A)', () => {
    const expected = keycodesV5.kc['LSFT(kc)'] | keycodesV5.kc.KC_A
    expect(deserialize('LSFT(KC_A)')).toBe(expected)
  })

  it('deserializes expressions like LT(0, KC_A)', () => {
    const expected = keycodesV5.kc.QK_LAYER_TAP | (0 << 8) | keycodesV5.kc.KC_A
    expect(deserialize('LT(0, KC_A)')).toBe(expected)
  })

  it('deserializes MO(0)', () => {
    expect(deserialize('MO(0)')).toBe(keycodesV5.kc['MO(0)'])
  })

  it('deserializes LM 2-arg form: LM(0, MOD_LCTL)', () => {
    const expected = keycodesV5.kc.QK_LAYER_MOD | (0 << 4) | 0x01
    expect(deserialize('LM(0, MOD_LCTL)')).toBe(expected)
  })

  it('deserializes LM 1-arg masked form: LM0(MOD_LCTL)', () => {
    const expected = keycodesV5.kc.QK_LAYER_MOD | (0 << 4) | 0x01
    expect(deserialize('LM0(MOD_LCTL)')).toBe(expected)
  })

  it('deserializes LM1(MOD_LSFT)', () => {
    const expected = keycodesV5.kc.QK_LAYER_MOD | (1 << 4) | 0x02
    expect(deserialize('LM1(MOD_LSFT)')).toBe(expected)
  })

  it('returns 0 for invalid expressions', () => {
    expect(deserialize('TOTALLY_INVALID_THING')).toBe(0)
  })

  it('deserializes hex strings', () => {
    expect(deserialize('0x04')).toBe(0x04)
  })
})

// --- normalize() tests ---

describe('normalize()', () => {
  beforeEach(() => {
    setProtocol(0)
    recreateKeycodes()
  })

  it('normalizes shifted keycodes to decomposed form', () => {
    // KC_PERC (0x222) = LSFT(KC_5) — normalize returns decomposed form
    expect(normalize('KC_PERC')).toBe('LSFT(KC_5)')
    expect(normalize('KC_EXLM')).toBe('LSFT(KC_1)')
    // LSFT(KC_B) has no named alias so stays decomposed
    expect(normalize('LSFT(KC_B)')).toBe('LSFT(KC_B)')
  })

  it('preserves already-normal keycodes', () => {
    expect(normalize('KC_A')).toBe('KC_A')
  })
})

// --- isMask() tests ---

describe('isMask()', () => {
  it('detects masked keycodes', () => {
    expect(isMask('LSFT(KC_A)')).toBe(true)
    expect(isMask('LCTL(KC_B)')).toBe(true)
  })

  it('detects LT and LM masked keycodes after keyboard init', () => {
    const keyboard: KeyboardKeycodeContext = {
      vialProtocol: 6,
      layers: 4,
      macroCount: 0,
      tapDanceCount: 0,
      customKeycodes: null,
      midi: '',
      supportedFeatures: new Set(),
    }
    recreateKeyboardKeycodes(keyboard)
    expect(isMask('LT0(KC_A)')).toBe(true)
    expect(isMask('LT3(KC_A)')).toBe(true)
    expect(isMask('LM0(MOD_LCTL)')).toBe(true)
    expect(isMask('LM3(MOD_LSFT)')).toBe(true)
  })

  it('returns false for non-masked keycodes', () => {
    expect(isMask('KC_A')).toBe(false)
    expect(isMask('MO(0)')).toBe(false)
  })

  it('detects shifted keycodes as masked via serialize()', () => {
    setProtocol(0)
    recreateKeycodes()
    expect(isMask(serialize(keycodesV5.kc.KC_EXLM))).toBe(true)
    expect(isMask(serialize(keycodesV5.kc.KC_TILD))).toBe(true)
    setProtocol(6)
    recreateKeycodes()
    expect(isMask(serialize(keycodesV6.kc.KC_EXLM))).toBe(true)
    expect(isMask(serialize(keycodesV6.kc.KC_TILD))).toBe(true)
  })
})

// --- isLMKeycode() tests ---

describe('isLMKeycode()', () => {
  it('detects LM keycodes (v5)', () => {
    setProtocol(0)
    recreateKeycodes()
    expect(isLMKeycode(0x5900 | (0 << 4) | 0x01)).toBe(true) // LM0 + MOD_LCTL
    expect(isLMKeycode(0x5900 | (15 << 4) | 0x08)).toBe(true) // LM15 + MOD_LGUI
    expect(isLMKeycode(0x5900)).toBe(true) // LM0 with no mod
  })

  it('detects LM keycodes (v6)', () => {
    setProtocol(6)
    recreateKeycodes()
    expect(isLMKeycode(0x5000 | (0 << 5) | 0x01)).toBe(true) // LM0 + MOD_LCTL
    expect(isLMKeycode(0x5000 | (15 << 5) | 0x1f)).toBe(true) // LM15 max mod
  })

  it('returns false for non-LM keycodes', () => {
    setProtocol(6)
    recreateKeycodes()
    expect(isLMKeycode(0x04)).toBe(false) // KC_A
    expect(isLMKeycode(0x5220)).toBe(false) // MO(0)
    expect(isLMKeycode(0x4000)).toBe(false) // LT0(kc)
  })
})

// --- find functions ---

describe('find functions', () => {
  beforeEach(() => {
    setProtocol(0)
    recreateKeycodes()
  })

  it('findKeycode finds by qmk_id', () => {
    expect(findKeycode('KC_A')?.qmkId).toBe('KC_A')
    expect(findKeycode('NONEXISTENT')).toBeUndefined()
  })

  it('findKeycode handles "kc" -> KC_NO', () => {
    expect(findKeycode('kc')?.qmkId).toBe('KC_NO')
  })

  it('findOuterKeycode extracts outer from masked', () => {
    const outer = findOuterKeycode('LSFT(KC_A)')
    expect(outer?.qmkId).toBe('LSFT(kc)')
  })

  it('findInnerKeycode extracts inner from masked', () => {
    const inner = findInnerKeycode('LSFT(KC_A)')
    expect(inner?.qmkId).toBe('KC_A')
  })

  it('findInnerKeycode extracts MOD_* from LM masked', () => {
    const inner = findInnerKeycode('LM0(MOD_LCTL)')
    expect(inner?.qmkId).toBe('MOD_LCTL')
    expect(inner?.label).toBe('LCtl')
  })

  it('findByRecorderAlias finds keycodes by alias', () => {
    const kc = findByRecorderAlias('a')
    expect(kc?.qmkId).toBe('KC_A')
  })

  it('findByQmkId finds keycodes by exact qmk_id', () => {
    const kc = findByQmkId('KC_A')
    expect(kc?.qmkId).toBe('KC_A')
  })
})

// --- KEYCODES_LM_MODS ---

describe('KEYCODES_LM_MODS', () => {
  it('has 10 modifier entries', () => {
    expect(KEYCODES_LM_MODS).toHaveLength(10)
  })

  it('includes all standard modifiers', () => {
    const ids = KEYCODES_LM_MODS.map((kc) => kc.qmkId)
    expect(ids).toContain('MOD_LCTL')
    expect(ids).toContain('MOD_LSFT')
    expect(ids).toContain('MOD_LALT')
    expect(ids).toContain('MOD_LGUI')
    expect(ids).toContain('MOD_RCTL')
    expect(ids).toContain('MOD_RSFT')
    expect(ids).toContain('MOD_RALT')
    expect(ids).toContain('MOD_RGUI')
    expect(ids).toContain('MOD_MEH')
    expect(ids).toContain('MOD_HYPR')
  })
})

// --- getAvailableLMMods ---

describe('getAvailableLMMods', () => {
  it('returns all 10 mods for v6 (5-bit mask)', () => {
    setProtocol(6)
    recreateKeycodes()
    const mods = getAvailableLMMods()
    expect(mods).toHaveLength(10)
    const ids = mods.map((kc) => kc.qmkId)
    expect(ids).toContain('MOD_RCTL')
    expect(ids).toContain('MOD_RGUI')
  })

  it('excludes right-side mods for v5 (4-bit mask)', () => {
    setProtocol(5)
    recreateKeycodes()
    const mods = getAvailableLMMods()
    const ids = mods.map((kc) => kc.qmkId)
    // Left-side mods fit in 4 bits
    expect(ids).toContain('MOD_LCTL')
    expect(ids).toContain('MOD_LSFT')
    expect(ids).toContain('MOD_LALT')
    expect(ids).toContain('MOD_LGUI')
    expect(ids).toContain('MOD_MEH')
    expect(ids).toContain('MOD_HYPR')
    // Right-side mods have bit 4 set (0x10), exceeding v5's 0x0f mask
    expect(ids).not.toContain('MOD_RCTL')
    expect(ids).not.toContain('MOD_RSFT')
    expect(ids).not.toContain('MOD_RALT')
    expect(ids).not.toContain('MOD_RGUI')
  })
})

// --- keycodeLabel and keycodeTooltip ---

describe('keycodeLabel / keycodeTooltip', () => {
  beforeEach(() => {
    setProtocol(0)
    recreateKeycodes()
  })

  it('returns label for known keycode', () => {
    expect(keycodeLabel('KC_A')).toBe('A')
  })

  it('returns qmk_id for unknown keycode', () => {
    expect(keycodeLabel('UNKNOWN_KC')).toBe('UNKNOWN_KC')
  })

  it('returns tooltip with qmk_id prefix', () => {
    const tip = keycodeTooltip('QK_BOOT')
    expect(tip).toContain('QK_BOOT')
    expect(tip).toContain('bootloader')
  })

  it('returns undefined tooltip for unknown keycode', () => {
    expect(keycodeTooltip('UNKNOWN_KC')).toBeUndefined()
  })
})

// --- isBasic() ---

describe('isBasic()', () => {
  beforeEach(() => {
    setProtocol(0)
    recreateKeycodes()
  })

  it('returns true for basic keycodes', () => {
    expect(isBasic('KC_A')).toBe(true)
    expect(isBasic('KC_SPACE')).toBe(true)
  })

  it('returns false for non-basic keycodes', () => {
    expect(isBasic('QK_BOOT')).toBe(false)
  })
})

// --- recreateKeyboardKeycodes ---

describe('recreateKeyboardKeycodes()', () => {
  it('generates layer keycodes based on keyboard info', () => {
    const keyboard: KeyboardKeycodeContext = {
      vialProtocol: 6,
      layers: 4,
      macroCount: 8,
      tapDanceCount: 4,
      customKeycodes: null,
      midi: 'basic',
      supportedFeatures: new Set(['caps_word']),
    }
    recreateKeyboardKeycodes(keyboard)

    expect(getProtocol()).toBe(6)

    // Should have MO(0)-MO(3), DF(0)-DF(3), etc.
    expect(KEYCODES_MAP.has('MO(0)')).toBe(true)
    expect(KEYCODES_MAP.has('MO(3)')).toBe(true)

    // Should have macros M0-M7
    expect(KEYCODES_MAP.has('M0')).toBe(true)
    expect(KEYCODES_MAP.has('M7')).toBe(true)
    expect(KEYCODES_MAP.has('M8')).toBe(false)

    // Should have tap dance TD(0)-TD(3)
    expect(KEYCODES_MAP.has('TD(0)')).toBe(true)
    expect(KEYCODES_MAP.has('TD(3)')).toBe(true)

    // FN_MO13 and FN_MO23 should be present (layers >= 4)
    expect(KEYCODES_MAP.has('FN_MO13')).toBe(true)
    expect(KEYCODES_MAP.has('FN_MO23')).toBe(true)

    // LT keycodes: LT0-LT3
    expect(KEYCODES_MAP.has('LT0')).toBe(true)
    expect(KEYCODES_MAP.has('LT3')).toBe(true)

    // caps_word should be visible
    const capsWord = findByQmkId('QK_CAPS_WORD_TOGGLE')
    expect(capsWord?.hidden).toBe(false)
  })

  it('hides unsupported features', () => {
    const keyboard: KeyboardKeycodeContext = {
      vialProtocol: 6,
      layers: 2,
      macroCount: 0,
      tapDanceCount: 0,
      customKeycodes: null,
      midi: '',
      supportedFeatures: new Set(),
    }
    recreateKeyboardKeycodes(keyboard)

    const capsWord = findByQmkId('QK_CAPS_WORD_TOGGLE')
    expect(capsWord?.hidden).toBe(true)

    // FN_MO13/FN_MO23 should NOT be present (layers < 4)
    expect(KEYCODES_MAP.has('FN_MO13')).toBe(false)
  })

  it('handles custom user keycodes', () => {
    const keyboard: KeyboardKeycodeContext = {
      vialProtocol: 6,
      layers: 2,
      macroCount: 0,
      tapDanceCount: 0,
      customKeycodes: [
        { name: 'CUSTOM_1', title: 'Custom One', shortName: 'C1' },
        { name: 'CUSTOM_2', title: 'Custom Two', shortName: 'C2' },
      ],
      midi: '',
      supportedFeatures: new Set(),
    }
    recreateKeyboardKeycodes(keyboard)

    const user0 = findByQmkId('USER00')
    expect(user0?.label).toBe('C1')
  })
})

// --- AnyKeycode expression evaluator ---

describe('AnyKeycode expression evaluator', () => {
  beforeEach(() => {
    setProtocol(0)
    recreateKeycodes()
  })

  it('evaluates modifier wrappers', () => {
    const expected = keycodesV5.kc.QK_LSFT | keycodesV5.kc.KC_A
    expect(deserialize('LSFT(KC_A)')).toBe(expected)
  })

  it('evaluates combined modifiers', () => {
    const expected = keycodesV5.kc.QK_LCTL | keycodesV5.kc.QK_LSFT | keycodesV5.kc.KC_A
    expect(deserialize('C_S(KC_A)')).toBe(expected)
  })

  it('evaluates LT(layer, kc)', () => {
    const expected =
      keycodesV5.kc.QK_LAYER_TAP | ((2 & 0x0f) << 8) | (keycodesV5.kc.KC_A & 0xff)
    expect(deserialize('LT(2, KC_A)')).toBe(expected)
  })

  it('evaluates MO(layer)', () => {
    const expected = keycodesV5.kc.QK_MOMENTARY | 3
    expect(deserialize('MO(3)')).toBe(expected)
  })

  it('evaluates MT(mod, kc)', () => {
    const expected =
      keycodesV5.kc.QK_MOD_TAP |
      ((keycodesV5.kc.MOD_LSFT & 0x1f) << 8) |
      (keycodesV5.kc.KC_A & 0xff)
    expect(deserialize('MT(MOD_LSFT, KC_A)')).toBe(expected)
  })

  it('evaluates LCTL_T(kc) mod-tap wrappers', () => {
    const expected =
      keycodesV5.kc.QK_MOD_TAP |
      ((keycodesV5.kc.MOD_LCTL & 0x1f) << 8) |
      (keycodesV5.kc.KC_A & 0xff)
    expect(deserialize('LCTL_T(KC_A)')).toBe(expected)
  })

  it('evaluates TD(n)', () => {
    const expected = keycodesV5.kc.QK_TAP_DANCE | 5
    expect(deserialize('TD(5)')).toBe(expected)
  })

  it('evaluates LT0(kc) shortcut', () => {
    const expected =
      keycodesV5.kc.QK_LAYER_TAP | ((0 & 0x0f) << 8) | (keycodesV5.kc.KC_B & 0xff)
    expect(deserialize('LT0(KC_B)')).toBe(expected)
  })

  it('evaluates bitwise OR expressions', () => {
    const expected = keycodesV5.kc.MOD_LCTL | keycodesV5.kc.MOD_LSFT
    expect(deserialize('MOD_LCTL | MOD_LSFT')).toBe(expected)
  })

  it('evaluates hex literals', () => {
    expect(deserialize('0x04')).toBe(4)
    expect(deserialize('0XFF')).toBe(0xff) // uppercase 0X
  })

  it('evaluates decimal literals', () => {
    expect(deserialize('42')).toBe(42)
  })

  it('evaluates bitwise AND expressions', () => {
    expect(deserialize('0xFF & 0x0F')).toBe(0x0f)
  })

  it('evaluates bitwise XOR expressions', () => {
    expect(deserialize('0xFF ^ 0x0F')).toBe(0xf0)
  })

  it('evaluates mixed bitwise operators with correct precedence', () => {
    // & binds tighter than |: 0x03 | (0xFF & 0xF0) = 0x03 | 0xF0 = 0xF3
    expect(deserialize('0x03 | 0xFF & 0xF0')).toBe(0xf3)
  })

  it('evaluates parenthesized sub-expressions', () => {
    // (MOD_LCTL | MOD_LSFT) is a common pattern from Python simpleeval
    const expected = keycodesV5.kc.MOD_LCTL | keycodesV5.kc.MOD_LSFT
    expect(deserialize('(MOD_LCTL | MOD_LSFT)')).toBe(expected)
  })

  it('evaluates addition and subtraction', () => {
    expect(deserialize('0x100 + 1')).toBe(0x101)
    expect(deserialize('10 - 3')).toBe(7)
  })

  it('evaluates shift operators', () => {
    expect(deserialize('1 << 8')).toBe(256)
    expect(deserialize('0xFF00 >> 8')).toBe(0xff)
  })

  it('evaluates unary minus', () => {
    expect(deserialize('-1 + 2')).toBe(1)
  })

  it('rejects trailing tokens', () => {
    // "KC_A KC_B" should fail (return 0) because KC_B is unexpected trailing
    expect(deserialize('KC_A KC_B')).toBe(0)
  })

  it('rejects invalid characters', () => {
    // '#' is not a valid token character
    expect(deserialize('KC_A#')).toBe(0)
  })

  it('works with v6 protocol', () => {
    setProtocol(6)
    recreateKeycodes()
    const expected = keycodesV6.kc.QK_LSFT | keycodesV6.kc.KC_A
    expect(deserialize('LSFT(KC_A)')).toBe(expected)
  })
})

// --- Tap Dance helpers ---

describe('isTapDanceKeycode()', () => {
  it('returns true for tap dance keycodes', () => {
    expect(isTapDanceKeycode(0x5700)).toBe(true)
    expect(isTapDanceKeycode(0x5703)).toBe(true)
    expect(isTapDanceKeycode(0x57ff)).toBe(true)
  })

  it('returns false for non-tap dance keycodes', () => {
    expect(isTapDanceKeycode(0x0004)).toBe(false) // KC_A
    expect(isTapDanceKeycode(0x5100)).toBe(false) // MO(0) v5
    expect(isTapDanceKeycode(0x5600)).toBe(false)
    expect(isTapDanceKeycode(0x5800)).toBe(false)
  })
})

describe('getTapDanceIndex()', () => {
  it('extracts the index from a tap dance keycode', () => {
    expect(getTapDanceIndex(0x5700)).toBe(0)
    expect(getTapDanceIndex(0x5703)).toBe(3)
    expect(getTapDanceIndex(0x57ff)).toBe(255)
  })
})

// --- Macro helpers ---

const macroKeyboardV6: KeyboardKeycodeContext = {
  vialProtocol: 6,
  layers: 4,
  macroCount: 256,
  tapDanceCount: 0,
  customKeycodes: null,
  midi: '',
  supportedFeatures: new Set(),
}

describe('isMacroKeycode()', () => {
  beforeEach(() => {
    recreateKeyboardKeycodes(macroKeyboardV6)
  })

  it('returns true for macro keycodes (v6)', () => {
    expect(isMacroKeycode(0x7700)).toBe(true)
    expect(isMacroKeycode(0x7703)).toBe(true)
    expect(isMacroKeycode(0x77ff)).toBe(true)
  })

  it('returns false for non-macro keycodes', () => {
    expect(isMacroKeycode(0x0004)).toBe(false) // KC_A
    expect(isMacroKeycode(0x5700)).toBe(false) // TD(0)
    expect(isMacroKeycode(0x7c00)).toBe(false) // QK_BOOT
  })

  it('returns true for macro keycodes (v5)', () => {
    recreateKeyboardKeycodes({ ...macroKeyboardV6, vialProtocol: 5 })
    expect(isMacroKeycode(0x5f12)).toBe(true) // M0 in v5
    expect(isMacroKeycode(0x5f13)).toBe(true) // M1 in v5
  })
})

describe('getMacroIndex()', () => {
  beforeEach(() => {
    recreateKeyboardKeycodes(macroKeyboardV6)
  })

  it('extracts the index from a macro keycode', () => {
    expect(getMacroIndex(0x7700)).toBe(0)
    expect(getMacroIndex(0x7703)).toBe(3)
    expect(getMacroIndex(0x77ff)).toBe(255)
  })

  it('returns -1 for non-macro keycodes', () => {
    expect(getMacroIndex(0x0004)).toBe(-1)
    expect(getMacroIndex(0x5700)).toBe(-1)
  })
})

// --- isResetKeycode tests ---

describe('isResetKeycode()', () => {
  it('returns true for QK_BOOT in v6 (0x7c00)', () => {
    setProtocol(6)
    recreateKeycodes()
    expect(isResetKeycode(0x7c00)).toBe(true)
  })

  it('returns true for QK_BOOT in v5 (0x5c00)', () => {
    setProtocol(5)
    recreateKeycodes()
    expect(isResetKeycode(0x5c00)).toBe(true)
  })

  it('returns false for non-boot keycodes', () => {
    setProtocol(6)
    recreateKeycodes()
    expect(isResetKeycode(0x0004)).toBe(false) // KC_A
    expect(isResetKeycode(0x5700)).toBe(false) // TD(0)
    expect(isResetKeycode(0x7700)).toBe(false) // M0
    expect(isResetKeycode(0x0000)).toBe(false) // KC_NO
  })

  it('returns false for QK_REBOOT (not the reset keycode)', () => {
    setProtocol(6)
    recreateKeycodes()
    expect(isResetKeycode(0x7c01)).toBe(false) // QK_REBOOT
  })
})

// --- CustomKeycodeDefinition optional fields tests ---

describe('createCustomUserKeycodes()', () => {
  beforeEach(() => {
    setProtocol(0)
    recreateKeycodes()
  })

  it('handles fully specified custom keycodes', () => {
    const customs: CustomKeycodeDefinition[] = [
      { name: 'MY_KEY', title: 'My Custom Key', shortName: 'MK' },
    ]
    createCustomUserKeycodes(customs)
    const kc = findByQmkId('USER00')
    expect(kc).toBeDefined()
    expect(kc!.label).toBe('MK')
    expect(kc!.tooltip).toBe('My Custom Key')
  })

  it('handles custom keycodes with missing optional fields using defaults', () => {
    const customs: CustomKeycodeDefinition[] = [
      {}, // all fields omitted — defaults to USER00 for label, tooltip, alias
      { name: 'ONLY_NAME' }, // only name — label/tooltip default to USER01
    ]
    createCustomUserKeycodes(customs)
    const kc0 = findByQmkId('USER00')
    expect(kc0).toBeDefined()
    expect(kc0!.label).toBe('USER00')
    expect(kc0!.tooltip).toBe('USER00')

    const kc1 = findByQmkId('USER01')
    expect(kc1).toBeDefined()
    expect(kc1!.label).toBe('USER01')
    expect(kc1!.tooltip).toBe('USER01')
  })
})

// --- New keycode categories ---

describe('Swap Hands keycodes', () => {
  it('has 7 static swap hands keycodes', () => {
    expect(KEYCODES_QUANTUM_SWAP_HANDS).toHaveLength(7)
  })

  it('has 1 masked SH_T(kc) keycode', () => {
    expect(KEYCODES_QUANTUM_SWAP_HANDS_TAP).toHaveLength(1)
    expect(KEYCODES_QUANTUM_SWAP_HANDS_TAP[0].masked).toBe(true)
    expect(KEYCODES_QUANTUM_SWAP_HANDS_TAP[0].qmkId).toBe('SH_T(kc)')
  })

  it('v6 addresses are correct', () => {
    expect(keycodesV6.kc.SH_TOGG).toBe(0x56f0)
    expect(keycodesV6.kc.SH_OS).toBe(0x56f6)
    expect(keycodesV6.kc['SH_T(kc)']).toBe(0x5600)
  })

  it('v5 has fake addresses for swap hands', () => {
    expect(keycodesV5.kc.SH_TOGG).toBe(0x999d1)
    expect(keycodesV5.kc['SH_T(kc)']).toBe(0x999d0)
  })

  it('serializes SH_TOGG correctly in v6 (fallback for static in masked range)', () => {
    setProtocol(6)
    recreateKeycodes()
    // SH_TOGG (0x56F0) is in the 0x5600 masked range, but should resolve via exact match
    expect(serialize(0x56f0)).toBe('SH_TOGG')
    expect(serialize(0x56f6)).toBe('SH_OS')
  })

  it('serializes SH_T(kc) masked keycode correctly in v6', () => {
    setProtocol(6)
    recreateKeycodes()
    // SH_T(KC_A) = 0x5600 | 0x04
    expect(serialize(0x5600 | 0x04)).toBe('SH_T(KC_A)')
  })

  it('deserializes SH_T(KC_A) correctly in v6', () => {
    setProtocol(6)
    recreateKeycodes()
    expect(deserialize('SH_T(KC_A)')).toBe(0x5600 | 0x04)
  })
})

describe('Sequencer keycodes', () => {
  it('has 9 sequencer keycodes', () => {
    expect(KEYCODES_MIDI_SEQUENCER).toHaveLength(9)
  })

  it('v6 addresses are correct', () => {
    expect(keycodesV6.kc.SQ_ON).toBe(0x7200)
    expect(keycodesV6.kc.SQ_SCLR).toBe(0x7208)
  })

  it('v5 has fake addresses', () => {
    expect(keycodesV5.kc.SQ_ON).toBe(0x999e0)
  })
})

describe('Joystick keycodes', () => {
  it('has 32 joystick keycodes', () => {
    expect(KEYCODES_MEDIA_JOYSTICK).toHaveLength(32)
  })

  it('v6 addresses are correct', () => {
    expect(keycodesV6.kc.JS_0).toBe(0x7400)
    expect(keycodesV6.kc.JS_31).toBe(0x741f)
  })

  it('v5 has fake addresses', () => {
    expect(keycodesV5.kc.JS_0).toBe(0x999f0)
    expect(keycodesV5.kc.JS_31).toBe(0x99a0f)
  })

  it('serializes joystick keycodes in v6', () => {
    setProtocol(6)
    recreateKeycodes()
    expect(serialize(0x7400)).toBe('JS_0')
    expect(serialize(0x741f)).toBe('JS_31')
  })
})

describe('LED Matrix keycodes', () => {
  it('has 9 LED Matrix keycodes', () => {
    expect(KEYCODES_LIGHTING_LED_MATRIX).toHaveLength(9)
  })

  it('v6 addresses are correct', () => {
    expect(keycodesV6.kc.LM_ON).toBe(0x7810)
    expect(keycodesV6.kc.LM_SPDD).toBe(0x7818)
  })

  it('v5 has fake addresses', () => {
    expect(keycodesV5.kc.LM_ON).toBe(0x99a10)
  })

  it('serializes LED Matrix keycodes in v6', () => {
    setProtocol(6)
    recreateKeycodes()
    expect(serialize(0x7810)).toBe('LM_ON')
    expect(serialize(0x7818)).toBe('LM_SPDD')
  })
})
