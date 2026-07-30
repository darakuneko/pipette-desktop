// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  MIN_DURATION_SAMPLE_COUNT,
  buildCellDurationStats,
  buildDurationFillByPos,
  buildDurationRanking,
  normalizeAvgIntensity,
} from '../key-heatmap-helpers'
import type { KeyDurationStat, LayerKeycodes } from '../key-heatmap-helpers'
import { PALETTE_MIN_T, paletteColorFromIntensity } from '../../../utils/chart-palette'
import type { TypingDurationCell } from '../../../../shared/types/typing-analytics'

function layerKeycodes(pairs: Record<string, string>): LayerKeycodes {
  return { keycodes: new Map(Object.entries(pairs)), labelOverrides: new Map() }
}

function cell(overrides: Partial<TypingDurationCell> = {}): TypingDurationCell {
  return {
    row: 0,
    col: 0,
    layer: 0,
    durationSamples: 0,
    hist: [0, 0, 0, 0, 0, 0, 0, 0],
    sum: 0,
    sumSq: 0,
    ...overrides,
  }
}

describe('buildCellDurationStats', () => {
  it('returns an empty map for empty input', () => {
    expect(buildCellDurationStats([]).size).toBe(0)
  })

  it('computes avgMs from sum/durationSamples per (layer, position)', () => {
    const stats = buildCellDurationStats([
      cell({ row: 0, col: 3, layer: 0, durationSamples: 5, sum: 500 }),
    ])
    const stat = stats.get('0:0,3')
    expect(stat).toEqual({ avgMs: 100, count: 5 })
  })

  it('drops cells below MIN_DURATION_SAMPLE_COUNT', () => {
    const stats = buildCellDurationStats([
      cell({ durationSamples: MIN_DURATION_SAMPLE_COUNT - 1, sum: 100 }),
    ])
    expect(stats.size).toBe(0)
  })

  it('keeps cells exactly at MIN_DURATION_SAMPLE_COUNT', () => {
    const stats = buildCellDurationStats([
      cell({ durationSamples: MIN_DURATION_SAMPLE_COUNT, sum: MIN_DURATION_SAMPLE_COUNT * 100 }),
    ])
    expect(stats.has('0:0,0')).toBe(true)
  })

  it('keys the same physical position on different layers independently', () => {
    const stats = buildCellDurationStats([
      cell({ row: 0, col: 0, layer: 0, durationSamples: 5, sum: 400 }),
      cell({ row: 0, col: 0, layer: 1, durationSamples: 5, sum: 600 }),
    ])
    expect(stats.get('0:0,0')?.avgMs).toBe(80)
    expect(stats.get('1:0,0')?.avgMs).toBe(120)
  })
})

describe('normalizeAvgIntensity (Duration mode: KeyDurationStat.avgMs)', () => {
  const avgMs = (stat: KeyDurationStat): number => stat.avgMs

  it('returns an empty map for an empty input', () => {
    expect(normalizeAvgIntensity(new Map(), avgMs).size).toBe(0)
  })

  it('min-max normalizes avgMs to [PALETTE_MIN_T, 1], fastest -> floor, slowest -> 1', () => {
    const durationMap = new Map([
      ['0:0,0', { avgMs: 50, count: 10 }],
      ['0:0,1', { avgMs: 150, count: 10 }],
      ['0:0,2', { avgMs: 250, count: 10 }],
    ])
    const intensity = normalizeAvgIntensity(durationMap, avgMs)
    expect(intensity.get('0:0,0')).toBeCloseTo(PALETTE_MIN_T, 10)
    expect(intensity.get('0:0,1')).toBeCloseTo(PALETTE_MIN_T + (1 - PALETTE_MIN_T) * 0.5, 10)
    expect(intensity.get('0:0,2')).toBe(1)
  })

  it('falls back to the remapped range midpoint when every cell ties', () => {
    const durationMap = new Map([
      ['0:0,0', { avgMs: 100, count: 10 }],
      ['0:0,1', { avgMs: 100, count: 20 }],
    ])
    const intensity = normalizeAvgIntensity(durationMap, avgMs)
    const mid = PALETTE_MIN_T + (1 - PALETTE_MIN_T) * 0.5
    expect(intensity.get('0:0,0')).toBeCloseTo(mid, 10)
    expect(intensity.get('0:0,1')).toBeCloseTo(mid, 10)
  })
})

describe('buildDurationFillByPos', () => {
  const intensityByCellKey = new Map([
    ['0:0,0', 0], // below the palette visibility floor
    ['0:0,1', 1], // slowest
  ])

  it('paints positions with qualifying duration data on the given layer', () => {
    const kc = layerKeycodes({ '0,1': 'KC_B' })
    const fills = buildDurationFillByPos(0, kc, ['0,1'], intensityByCellKey, 'all', 'light')
    expect(fills.get('0,1')).toMatch(/^hsl\(/)
  })

  it('omits positions with no qualifying duration data', () => {
    const kc = layerKeycodes({ '0,2': 'KC_C' })
    const fills = buildDurationFillByPos(0, kc, ['0,2'], intensityByCellKey, 'all', 'light')
    expect(fills.has('0,2')).toBe(false)
  })

  it('does not leak data from a different layer at the same position', () => {
    const kc = layerKeycodes({ '0,1': 'KC_B' })
    // intensityByCellKey only has layer-0 data for pos "0,1" — asking
    // for layer 1 at the same position must not accidentally match.
    const fills = buildDurationFillByPos(1, kc, ['0,1'], intensityByCellKey, 'all', 'light')
    expect(fills.has('0,1')).toBe(false)
  })

  it('omits positions filtered out by keyGroupFilter', () => {
    const kc = layerKeycodes({ '0,1': 'KC_B' })
    const fills = buildDurationFillByPos(0, kc, ['0,1'], intensityByCellKey, 'layerOp', 'light')
    expect(fills.has('0,1')).toBe(false)
  })

  it('skips empty keycode slots without throwing', () => {
    const kc = layerKeycodes({})
    const fills = buildDurationFillByPos(0, kc, ['0,1'], intensityByCellKey, 'all', 'light')
    expect(fills.size).toBe(0)
  })
})

describe('buildDurationRanking', () => {
  it('sorts slowest-first and caps at the limit, scoped to selected layers', () => {
    const cells = [
      cell({ row: 0, col: 0, layer: 0, durationSamples: 10, sum: 500 }), // 50ms
      cell({ row: 0, col: 1, layer: 0, durationSamples: 10, sum: 2_500 }), // 250ms
      cell({ row: 0, col: 2, layer: 1, durationSamples: 10, sum: 1_500 }), // 150ms, layer 1 (not selected)
    ]
    const layerKeycodesMap = new Map([
      [0, layerKeycodes({ '0,0': 'KC_A', '0,1': 'KC_B' })],
    ])
    const ranking = buildDurationRanking(cells, layerKeycodesMap, 'all', 10)
    expect(ranking).toHaveLength(2)
    expect(ranking[0].avgMs).toBe(250)
    expect(ranking[1].avgMs).toBe(50)
  })

  it('drops cells below MIN_DURATION_SAMPLE_COUNT', () => {
    const cells = [cell({ durationSamples: MIN_DURATION_SAMPLE_COUNT - 1, sum: 100 })]
    const layerKeycodesMap = new Map([[0, layerKeycodes({ '0,0': 'KC_A' })]])
    expect(buildDurationRanking(cells, layerKeycodesMap, 'all', 10)).toEqual([])
  })

  it('filters by keyGroupFilter using the position\'s own keycode group', () => {
    const cells = [
      cell({ row: 0, col: 0, layer: 0, durationSamples: 10, sum: 500 }),
      cell({ row: 0, col: 1, layer: 0, durationSamples: 10, sum: 2_500 }),
    ]
    const layerKeycodesMap = new Map([
      [0, layerKeycodes({ '0,0': 'KC_A', '0,1': 'KC_LCTL' })],
    ])
    const charOnly = buildDurationRanking(cells, layerKeycodesMap, 'char', 10)
    expect(charOnly).toHaveLength(1)
    expect(charOnly[0].keyLabel).toBe('A')
  })

  it('returns an empty list when no layer in the ranking map matches the cell layer', () => {
    const cells = [cell({ row: 0, col: 0, layer: 3, durationSamples: 10, sum: 500 })]
    const layerKeycodesMap = new Map([[0, layerKeycodes({ '0,0': 'KC_A' })]])
    expect(buildDurationRanking(cells, layerKeycodesMap, 'all', 10)).toEqual([])
  })

  it('keeps the fastest qualifying key above the palette visibility floor when normalized', () => {
    const durationMap = new Map([
      ['0:0,0', { avgMs: 50, count: 10 }],
      ['0:0,1', { avgMs: 250, count: 10 }],
    ])
    const intensity = normalizeAvgIntensity(durationMap, (stat: KeyDurationStat) => stat.avgMs)
    const fastest = intensity.get('0:0,0')
    expect(fastest).toBeDefined()
    expect(paletteColorFromIntensity(fastest as number, 'light')).toMatch(/^hsl\(/)
    expect(paletteColorFromIntensity(fastest as number, 'dark')).toMatch(/^hsl\(/)
  })
})
