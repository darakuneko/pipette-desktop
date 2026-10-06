// SPDX-License-Identifier: GPL-2.0-or-later
// TO(layer) encoding per vial protocol; see V5_TO_LAYER_LIMIT in
// keycodes-utils.ts for why v5 caps TO at 16 layers.

import { afterEach, describe, expect, it } from 'vitest'
import {
  KEYCODES_LAYERS_DF,
  KEYCODES_LAYERS_MO,
  KEYCODES_LAYERS_OSL,
  KEYCODES_LAYERS_TG,
  KEYCODES_LAYERS_TO,
  KEYCODES_LAYERS_TT,
  deserialize,
  recreateKeyboardKeycodes,
  serialize,
} from '../keycodes'
import { decodeAnyKeycode } from '../keycodes-any-keycode'
import { keycodesV5 as v5 } from '../keycodes-v5'
import { withSerializeProtocol } from '../with-protocol'

function ctx(vialProtocol: number, layers: number) {
  return {
    vialProtocol,
    layers,
    macroCount: 16,
    tapDanceCount: 0,
    customKeycodes: null,
    midi: 'none',
    supportedFeatures: new Set<string>(),
  }
}

afterEach(() => {
  recreateKeyboardKeycodes(ctx(6, 4))
})

describe('TO(layer) encoding', () => {
  it('v5 table keeps the firmware macro: TO(16..31) equal TO(0..15)', () => {
    for (let x = 0; x < 16; x++) {
      expect(v5.kc[`TO(${x + 16})`]).toBe(v5.kc[`TO(${x})`])
    }
    expect(v5.kc['TO(0)']).toBe(0x5010)
  })

  it('v5 with 32 layers offers only TO(0..15) and serializes them correctly', () => {
    recreateKeyboardKeycodes(ctx(5, 32))
    expect(KEYCODES_LAYERS_TO.length).toBe(16)
    expect(serialize(0x5010)).toBe('TO(0)')
    expect(serialize(0x501f)).toBe('TO(15)')
  })

  it('v5 with fewer than 16 layers offers one TO per layer', () => {
    recreateKeyboardKeycodes(ctx(5, 4))
    expect(KEYCODES_LAYERS_TO.length).toBe(4)
  })

  it('v5 still resolves a stored TO(16) to 0x5010 and normalizes it to TO(0)', () => {
    // A v6 build registers the TO(16) name, so deserialize takes the
    // registered-keycode path instead of the Any keycode fallback.
    recreateKeyboardKeycodes(ctx(6, 32))
    recreateKeyboardKeycodes(ctx(5, 32))
    expect(() => deserialize('TO(16)')).not.toThrow()
    expect(deserialize('TO(16)')).toBe(0x5010)
    expect(serialize(deserialize('TO(16)'))).toBe('TO(0)')
  })

  it('v5 with 32 layers keeps 32 MO/DF/TG/TT/OSL entries', () => {
    recreateKeyboardKeycodes(ctx(5, 32))
    for (const list of [
      KEYCODES_LAYERS_MO,
      KEYCODES_LAYERS_DF,
      KEYCODES_LAYERS_TG,
      KEYCODES_LAYERS_TT,
      KEYCODES_LAYERS_OSL,
    ]) {
      expect(list.length).toBe(32)
    }
  })

  it('v6 with 32 layers round-trips TO(0..31) as distinct values', () => {
    recreateKeyboardKeycodes(ctx(6, 32))
    expect(KEYCODES_LAYERS_TO.length).toBe(32)
    const values = new Set<number>()
    for (let x = 0; x < 32; x++) {
      const code = deserialize(`TO(${x})`)
      values.add(code)
      expect(serialize(code)).toBe(`TO(${x})`)
    }
    expect(values.size).toBe(32)
  })

  it('v5 serialization scope under a v6 32-layer keyboard maps 0x5010 to TO(0)', () => {
    recreateKeyboardKeycodes(ctx(6, 32))
    expect(withSerializeProtocol(5, () => serialize(0x5010))).toBe('TO(0)')
    expect(withSerializeProtocol(5, () => serialize(0x501f))).toBe('TO(15)')
    expect(serialize(deserialize('TO(16)'))).toBe('TO(16)')
  })

  it('Any keycode TO(n) follows the firmware macro of each protocol', () => {
    recreateKeyboardKeycodes(ctx(6, 4))
    expect(decodeAnyKeycode('TO(3)')).toBe(0x5203)
    expect(decodeAnyKeycode('TO(31)')).toBe(0x521f)
    recreateKeyboardKeycodes(ctx(5, 4))
    expect(decodeAnyKeycode('TO(3)')).toBe(0x5013)
  })
})
