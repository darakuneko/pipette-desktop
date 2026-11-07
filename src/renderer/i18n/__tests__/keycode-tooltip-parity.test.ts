// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeAll } from 'vitest'
import i18next, { type i18n as I18n } from 'i18next'
import english from '../locales/english.json'
import {
  KEYCODES,
  KEYCODES_LM_MODS,
  KEYCODES_USER,
  qmkIdToKeycode,
  recreateKeyboardKeycodes,
  type Keycode,
} from '../../../shared/keycodes/keycodes'
import {
  KEYCODE_TOOLTIP_NS,
  keycodeTooltipKey,
  sanitizeQmkIdForKey,
} from '../../../shared/keycodes/keycodes-tooltip-key'
import { flattenTranslations } from '../../../shared/i18n/coverage'
import { validatePack } from '../../../shared/i18n/validate'

const REPRESENTATIVE_KEYBOARD = {
  vialProtocol: 6,
  layers: 16,
  macroCount: 4,
  tapDanceCount: 4,
  customKeycodes: null,
  midi: 'advanced',
  supportedFeatures: new Set<string>(),
}

const englishTooltips = (english as Record<string, unknown>)[KEYCODE_TOOLTIP_NS] as Record<string, unknown>
const englishFlat = flattenTranslations({ [KEYCODE_TOOLTIP_NS]: englishTooltips })

function allKeycodes(): Keycode[] {
  return [...new Set<Keycode>([...KEYCODES, ...KEYCODES_LM_MODS, ...qmkIdToKeycode.values()])]
}

let t: I18n

beforeAll(async () => {
  recreateKeyboardKeycodes(REPRESENTATIVE_KEYBOARD)
  t = i18next.createInstance()
  await t.init({
    resources: { en: { translation: { [KEYCODE_TOOLTIP_NS]: englishTooltips } } },
    lng: 'en',
    keySeparator: '.',
    interpolation: { escapeValue: false },
  })
})

describe('sanitizeQmkIdForKey', () => {
  it('replaces symbol runs with "_" and drops a trailing "_"', () => {
    expect(sanitizeQmkIdForKey('KC_A')).toBe('KC_A')
    expect(sanitizeQmkIdForKey('OSM(MOD_LCTL|MOD_LSFT)')).toBe('OSM_MOD_LCTL_MOD_LSFT')
    expect(sanitizeQmkIdForKey('LSFT_T(kc)')).toBe('LSFT_T_kc')
    expect(keycodeTooltipKey('MOD_LCTL')).toBe('keycodeTooltip.MOD_LCTL')
  })
})

describe('keycode tooltip keys vs english.json', () => {
  it('every keycode with a tooltip has a tooltipKey', () => {
    const missing = allKeycodes()
      .filter((kc) => kc.tooltip && !kc.tooltipKey)
      .map((kc) => kc.qmkId)
    expect(missing).toEqual([])
  })

  it('every tooltipKey resolves in english.json to the same text as kc.tooltip', () => {
    const mismatches: string[] = []
    for (const kc of allKeycodes()) {
      if (!kc.tooltipKey) continue
      if (!(kc.tooltipKey in englishFlat)) {
        mismatches.push(`${kc.qmkId}: missing ${kc.tooltipKey}`)
        continue
      }
      const resolved = t.t(kc.tooltipKey, { ...kc.tooltipParams })
      if (resolved !== kc.tooltip) {
        mismatches.push(`${kc.qmkId}: "${resolved}" !== "${String(kc.tooltip)}"`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('has no keycodeTooltip entries that no keycode uses', () => {
    expect(Object.keys(englishFlat).length).toBeGreaterThan(0)
    const used = new Set(allKeycodes().map((kc) => kc.tooltipKey).filter(Boolean))
    const orphans = Object.keys(englishFlat).filter((key) => !used.has(key))
    expect(orphans).toEqual([])
  })

  it('keeps sanitized keys unique and apart from the generated keys', () => {
    const fixedOwner = new Map<string, string>()
    const generated = new Set<string>()
    const problems: string[] = []
    for (const kc of allKeycodes()) {
      if (!kc.tooltipKey) continue
      if (kc.tooltipKey !== keycodeTooltipKey(kc.qmkId)) {
        generated.add(kc.tooltipKey)
        continue
      }
      const prev = fixedOwner.get(kc.tooltipKey)
      if (prev !== undefined && prev !== kc.qmkId) problems.push(`${kc.tooltipKey}: ${prev} / ${kc.qmkId}`)
      fixedOwner.set(kc.tooltipKey, kc.qmkId)
    }
    // A fixed key may neither equal a generated key nor be the parent
    // object of one (`keycodeTooltip.layer` vs `keycodeTooltip.layer.MO`).
    for (const key of fixedOwner.keys()) {
      for (const gen of generated) {
        if (gen === key || gen.startsWith(`${key}.`)) problems.push(`${key} clashes with ${gen}`)
      }
    }
    expect(generated.size).toBeGreaterThan(0)
    expect(problems).toEqual([])
  })

  it('gives each numbered family one shared key', () => {
    const keyOf = (qmkId: string): string | undefined => qmkIdToKeycode.get(qmkId)?.tooltipKey
    const families: [string, string[]][] = [
      ['joystick', ['JS_0', 'JS_31']],
      ['midiNote', ['MI_C_1', 'MI_B_5']],
      ['midiTranspose', ['MI_TRNS_N6', 'MI_TRNS_0', 'MI_TRNS_6']],
      ['midiVelocity', ['MI_VEL_1', 'MI_VEL_10']],
      ['midiChannel', ['MI_CH1', 'MI_CH16']],
    ]
    for (const [name, qmkIds] of families) {
      for (const qmkId of qmkIds) expect(keyOf(qmkId)).toBe(`${KEYCODE_TOOLTIP_NS}.${name}`)
    }
  })

  it('never uses i18next reserved option names as params', () => {
    const reserved = new Set(['count', 'context', 'defaultValue', 'ordinal', 'lng', 'ns', 'replace'])
    const bad = allKeycodes().flatMap((kc) => Object.keys(kc.tooltipParams ?? {}).filter((p) => reserved.has(p)))
    expect(bad).toEqual([])
  })

  it('a pack carrying every keycodeTooltip key passes validatePack', () => {
    const result = validatePack({ name: 'Test', version: '0.1.0', [KEYCODE_TOOLTIP_NS]: englishTooltips })
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('customKeycodes titles get no tooltipKey', () => {
    recreateKeyboardKeycodes({
      ...REPRESENTATIVE_KEYBOARD,
      customKeycodes: [{ name: 'MY_KEY', title: 'My custom key', shortName: 'Mine' }],
    })
    try {
      expect(KEYCODES_USER[0].tooltip).toBe('My custom key')
      expect(KEYCODES_USER.every((kc) => kc.tooltipKey === undefined)).toBe(true)
    } finally {
      recreateKeyboardKeycodes(REPRESENTATIVE_KEYBOARD)
    }
  })
})
