// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  MIN_SPEED_SAMPLE_COUNT,
  buildKeycodeSpeedMap,
  buildSpeedFillByPos,
  buildSpeedRanking,
  normalizeKeySpeedIntensity,
} from '../key-heatmap-helpers'
import type { LayerKeycodes } from '../key-heatmap-helpers'
import { deserialize, getProtocol, setProtocol } from '../../../../shared/keycodes/keycodes'
import { PALETTE_MIN_T, paletteColorFromIntensity } from '../../../utils/chart-palette'
import type { TypingBigramTopEntry } from '../../../../shared/types/typing-analytics'

/** Resolve `qmkId` to its numeric code under a specific protocol,
 * restoring the global protocol afterwards. */
function deserializeUnderProtocol(qmkId: string, protocol: number): number {
  const prev = getProtocol()
  setProtocol(protocol)
  try {
    return deserialize(qmkId)
  } finally {
    setProtocol(prev)
  }
}

function entry(ngramId: string, count: number, hist: number[] = [0, 0, 0, 0, 0, 0, 0, 0]): TypingBigramTopEntry {
  return { ngramId, count, hist, avgIki: null }
}

function layerKeycodes(pairs: Record<string, string>): LayerKeycodes {
  return { keycodes: new Map(Object.entries(pairs)), labelOverrides: new Map() }
}

describe('buildKeycodeSpeedMap', () => {
  it('returns an empty map for empty input', () => {
    expect(buildKeycodeSpeedMap([]).size).toBe(0)
  })

  it('folds every pair\'s histogram onto its "to" (second) keycode', () => {
    // KC_A(4) -> KC_B(5), replayed with enough count to clear the
    // min-sample threshold, plus a second contributing pair landing on
    // the same "to" keycode.
    const map = buildKeycodeSpeedMap([
      entry('4_5', 5, [0, 5, 0, 0, 0, 0, 0, 0]), // bucket center 80ms
      entry('6_5', 3, [0, 0, 3, 0, 0, 0, 0, 0]), // bucket center 125ms
    ])
    const stat = map.get(5)
    expect(stat).toBeDefined()
    expect(stat?.count).toBe(8)
    // Weighted avg: (5*80 + 3*125) / 8 = 96.875
    expect(stat?.avgIki).toBeCloseTo(96.875, 5)
  })

  it('drops keycodes below MIN_SPEED_SAMPLE_COUNT', () => {
    const map = buildKeycodeSpeedMap([
      entry('4_5', MIN_SPEED_SAMPLE_COUNT - 1, [0, 1, 0, 0, 0, 0, 0, 0]),
    ])
    expect(map.has(5)).toBe(false)
  })

  it('keeps keycodes exactly at MIN_SPEED_SAMPLE_COUNT', () => {
    const map = buildKeycodeSpeedMap([
      entry('4_5', MIN_SPEED_SAMPLE_COUNT, [0, MIN_SPEED_SAMPLE_COUNT, 0, 0, 0, 0, 0, 0]),
    ])
    expect(map.has(5)).toBe(true)
  })

  it('drops malformed ngram ids without crashing', () => {
    const map = buildKeycodeSpeedMap([
      entry('not-a-pair', 10),
      entry('4_5', 5, [0, 5, 0, 0, 0, 0, 0, 0]),
    ])
    expect(map.has(5)).toBe(true)
    expect(map.size).toBe(1)
  })
})

describe('normalizeKeySpeedIntensity', () => {
  it('returns an empty map for an empty speed map', () => {
    expect(normalizeKeySpeedIntensity(new Map()).size).toBe(0)
  })

  it('min-max normalizes avgIki to [PALETTE_MIN_T, 1], fastest -> floor, slowest -> 1', () => {
    const speedMap = new Map([
      [4, { avgIki: 50, count: 10 }],
      [5, { avgIki: 150, count: 10 }],
      [6, { avgIki: 250, count: 10 }],
    ])
    const intensity = normalizeKeySpeedIntensity(speedMap)
    expect(intensity.get(4)).toBeCloseTo(PALETTE_MIN_T, 10)
    expect(intensity.get(5)).toBeCloseTo(PALETTE_MIN_T + (1 - PALETTE_MIN_T) * 0.5, 10)
    expect(intensity.get(6)).toBe(1)
  })

  it('keeps the fastest qualifying key above the palette visibility floor', () => {
    const speedMap = new Map([
      [4, { avgIki: 50, count: 10 }],
      [5, { avgIki: 250, count: 10 }],
    ])
    const intensity = normalizeKeySpeedIntensity(speedMap)
    const fastest = intensity.get(4)
    expect(fastest).toBeDefined()
    // The fastest key must remain distinguishable from a no-data key:
    // its remapped intensity has to survive the palette's floor check.
    expect(paletteColorFromIntensity(fastest as number, 'light')).toMatch(/^hsl\(/)
    expect(paletteColorFromIntensity(fastest as number, 'dark')).toMatch(/^hsl\(/)
  })

  it('falls back to the remapped range midpoint when every key ties', () => {
    const speedMap = new Map([
      [4, { avgIki: 100, count: 10 }],
      [5, { avgIki: 100, count: 20 }],
    ])
    const intensity = normalizeKeySpeedIntensity(speedMap)
    const mid = PALETTE_MIN_T + (1 - PALETTE_MIN_T) * 0.5
    expect(intensity.get(4)).toBeCloseTo(mid, 10)
    expect(intensity.get(5)).toBeCloseTo(mid, 10)
  })
})

describe('buildSpeedFillByPos', () => {
  const intensityByCode = new Map([
    // Raw palette-space values passed directly (normalizeKeySpeedIntensity
    // never emits 0 — it floors at PALETTE_MIN_T). Kept at 0 here to
    // document that the palette itself still skips sub-floor input.
    [4, 0], // KC_A — below the palette visibility floor
    [5, 1], // KC_B, slowest
  ])

  it('paints positions whose keycode has qualifying speed data', () => {
    const kc = layerKeycodes({ '0,0': 'KC_B' })
    const fills = buildSpeedFillByPos(kc, ['0,0'], intensityByCode, 'all', 'light')
    expect(fills.get('0,0')).toMatch(/^hsl\(/)
  })

  it('omits positions whose keycode has no qualifying speed data', () => {
    const kc = layerKeycodes({ '0,0': 'KC_Z' })
    const fills = buildSpeedFillByPos(kc, ['0,0'], intensityByCode, 'all', 'light')
    expect(fills.has('0,0')).toBe(false)
  })

  it('omits positions filtered out by keyGroupFilter', () => {
    const kc = layerKeycodes({ '0,0': 'KC_B', '0,1': 'MO(1)' })
    // MO(1) is a layerOp keycode and has no speed data anyway, but the
    // group filter should also exclude a char key when filtering to
    // 'layerOp'.
    const fills = buildSpeedFillByPos(kc, ['0,0', '0,1'], intensityByCode, 'layerOp', 'light')
    expect(fills.has('0,0')).toBe(false)
  })

  it('skips empty keycode slots without throwing', () => {
    const kc = layerKeycodes({})
    const fills = buildSpeedFillByPos(kc, ['0,0'], intensityByCode, 'all', 'light')
    expect(fills.size).toBe(0)
  })

  it('resolves snapshot keycodes under the snapshot vialProtocol', () => {
    // QK_BOOT is protocol-dependent (0x5c00 in v5, 0x7c00 in v6), so
    // it exercises the protocol plumbing.
    const v5BootCode = deserializeUnderProtocol('QK_BOOT', 5)
    const v6BootCode = deserializeUnderProtocol('QK_BOOT', 6)
    expect(v5BootCode).not.toBe(v6BootCode)

    const kc = layerKeycodes({ '0,0': 'QK_BOOT' })
    // Intensity keyed by the v5 numeric code — the shape a v5 snapshot's
    // recorded bigram data produces.
    const intensity = new Map([[v5BootCode, 1]])
    // Without the snapshot protocol, QK_BOOT resolves under the current
    // default (v6) to a different code and stays unpainted.
    expect(buildSpeedFillByPos(kc, ['0,0'], intensity, 'all', 'light').has('0,0')).toBe(false)
    // With vialProtocol=5 it matches the recorded v5 code and paints.
    expect(buildSpeedFillByPos(kc, ['0,0'], intensity, 'all', 'light', 5).get('0,0')).toMatch(/^hsl\(/)
  })

  it('restores the global protocol after resolving', () => {
    const prev = getProtocol()
    buildSpeedFillByPos(layerKeycodes({ '0,0': 'KC_A' }), ['0,0'], new Map(), 'all', 'light', 5)
    expect(getProtocol()).toBe(prev)
  })
})

describe('buildSpeedRanking', () => {
  it('sorts slowest-reach-first and caps at the limit', () => {
    const speedMap = new Map([
      [4, { avgIki: 50, count: 10 }], // KC_A
      [5, { avgIki: 250, count: 8 }], // KC_B
      [6, { avgIki: 150, count: 6 }], // KC_C
    ])
    const ranking = buildSpeedRanking(speedMap, 'all', 2)
    expect(ranking).toHaveLength(2)
    expect(ranking[0].avgIki).toBe(250)
    expect(ranking[1].avgIki).toBe(150)
  })

  it('filters by keyGroupFilter using the keycode\'s own group', () => {
    const speedMap = new Map([
      [deserialize('KC_A'), { avgIki: 50, count: 10 }], // char
      [deserialize('KC_LCTL'), { avgIki: 250, count: 8 }], // modifier
    ])
    const charOnly = buildSpeedRanking(speedMap, 'char', 10)
    expect(charOnly).toHaveLength(1)
    expect(charOnly[0].keyLabel).toBe('A')
  })

  it('returns an empty list for an empty speed map', () => {
    expect(buildSpeedRanking(new Map(), 'all', 10)).toEqual([])
  })

  it('ranks protocol-dependent codes and restores the global protocol', () => {
    // Label rendering for protocol-dependent codes additionally depends
    // on session-level keycode tables (RAWCODES_MAP), so this asserts
    // the protocol plumbing (entry survives, global protocol restored)
    // rather than a specific label string.
    const prev = getProtocol()
    const v5BootCode = deserializeUnderProtocol('QK_BOOT', 5)
    const speedMap = new Map([[v5BootCode, { avgIki: 100, count: 10 }]])
    const ranking = buildSpeedRanking(speedMap, 'all', 10, 5)
    expect(ranking).toHaveLength(1)
    expect(ranking[0].avgIki).toBe(100)
    expect(getProtocol()).toBe(prev)
  })
})
