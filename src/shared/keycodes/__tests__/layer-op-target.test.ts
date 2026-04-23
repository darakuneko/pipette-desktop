// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { getLayerOpTarget } from '../keycodes'

describe('getLayerOpTarget', () => {
  it('returns press-kind for MO / TG / TO / DF / PDF / OSL / TT', () => {
    expect(getLayerOpTarget('MO(1)')).toEqual({ layer: 1, kind: 'press' })
    expect(getLayerOpTarget('TG(2)')).toEqual({ layer: 2, kind: 'press' })
    expect(getLayerOpTarget('TO(3)')).toEqual({ layer: 3, kind: 'press' })
    expect(getLayerOpTarget('DF(0)')).toEqual({ layer: 0, kind: 'press' })
    expect(getLayerOpTarget('PDF(4)')).toEqual({ layer: 4, kind: 'press' })
    expect(getLayerOpTarget('OSL(5)')).toEqual({ layer: 5, kind: 'press' })
    expect(getLayerOpTarget('TT(6)')).toEqual({ layer: 6, kind: 'press' })
  })

  it('returns hold-kind for LT / LM so only the layer-activating arm counts', () => {
    expect(getLayerOpTarget('LT1(KC_A)')).toEqual({ layer: 1, kind: 'hold' })
    expect(getLayerOpTarget('LT0')).toEqual({ layer: 0, kind: 'hold' })
    expect(getLayerOpTarget('LM3(MOD_LCTL)')).toEqual({ layer: 3, kind: 'hold' })
  })

  it('handles multi-digit layer indices', () => {
    expect(getLayerOpTarget('MO(15)')).toEqual({ layer: 15, kind: 'press' })
    expect(getLayerOpTarget('LT12(KC_SPC)')).toEqual({ layer: 12, kind: 'hold' })
  })

  it('returns null for non-layer-op qmk ids', () => {
    expect(getLayerOpTarget('KC_A')).toBeNull()
    expect(getLayerOpTarget('LCTL(KC_A)')).toBeNull()
    expect(getLayerOpTarget('KC_NO')).toBeNull()
    expect(getLayerOpTarget('')).toBeNull()
  })

  it('returns null for malformed layer-op strings', () => {
    // Single-op family requires parentheses
    expect(getLayerOpTarget('MO')).toBeNull()
    expect(getLayerOpTarget('MO(-1)')).toBeNull()
    expect(getLayerOpTarget('MO(abc)')).toBeNull()
  })
})
