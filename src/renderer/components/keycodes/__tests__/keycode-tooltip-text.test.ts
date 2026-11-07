// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeAll } from 'vitest'
import i18next, { type TFunction } from 'i18next'
import { recreateKeyboardKeycodes, keycodeTooltip, KEYCODES_LAYERS_LT, KEYCODES_USER } from '../../../../shared/keycodes/keycodes'
import { translateKeycodeTooltip } from '../keycode-tooltip-text'

const english = {
  keycodeTooltip: {
    KC_A: 'English A',
    layer: { LT: 'kc on tap, switch to layer {{layer}} while held' },
  },
}
const pack = {
  keycodeTooltip: {
    KC_A: 'Translated A',
    KC_NONUS_HASH: 'Translated hash',
    layer: { LT: 'tap kc / hold layer {{layer}}' },
  },
}

let t: TFunction

beforeAll(async () => {
  recreateKeyboardKeycodes({
    vialProtocol: 6,
    layers: 4,
    macroCount: 0,
    tapDanceCount: 0,
    customKeycodes: null,
    midi: '',
    supportedFeatures: new Set(),
  })
  const instance = i18next.createInstance()
  await instance.init({
    resources: {
      'builtin:en': { translation: english },
      'pack:test': { translation: pack },
    },
    lng: 'pack:test',
    fallbackLng: 'builtin:en',
    keySeparator: '.',
    interpolation: { escapeValue: false },
  })
  t = instance.t
})

describe('translateKeycodeTooltip', () => {
  it('uses the pack translation when the key exists', () => {
    expect(translateKeycodeTooltip(t, { tooltip: 'English A', tooltipKey: 'keycodeTooltip.KC_A' })).toBe('Translated A')
  })

  it('interpolates numbered tooltips', () => {
    expect(translateKeycodeTooltip(t, KEYCODES_LAYERS_LT[2])).toBe('tap kc / hold layer 2')
  })

  it('returns the text verbatim when the keycode has no key', () => {
    expect(translateKeycodeTooltip(t, { tooltip: 'Maker title', tooltipKey: undefined })).toBe('Maker title')
    expect(translateKeycodeTooltip(t, { tooltip: undefined, tooltipKey: undefined })).toBeUndefined()
  })

  it('interpolates params into the English fallback when no bundle has the key', () => {
    expect(translateKeycodeTooltip(t, KEYCODES_USER[3])).toBe('User keycode 3')
  })
})

describe('keycodeTooltip with a translating resolver', () => {
  it('prefixes the translated text with the qmkId', () => {
    expect(keycodeTooltip('KC_NONUS_HASH', (kc) => translateKeycodeTooltip(t, kc))).toBe('KC_NONUS_HASH: Translated hash')
  })
})
