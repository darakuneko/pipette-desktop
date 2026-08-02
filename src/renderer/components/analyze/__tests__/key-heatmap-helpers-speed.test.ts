// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, it, expect } from 'vitest'
import {
  MIN_SPEED_SAMPLE_COUNT,
  buildKeycodeSpeedMap,
  buildSpeedFillByPos,
  buildSpeedRanking,
  normalizeAvgIntensity,
} from '../key-heatmap-helpers'
import type { KeySpeedStat } from '../key-heatmap-helpers'
import type { LayerKeycodes } from '../key-heatmap-helpers'
import { buildSnapshotQmkByCode, decodeSnapshotQmkId } from '../analyze-snapshot-codes'
import {
  deserialize,
  getProtocol,
  recreateKeyboardKeycodes,
  recreateKeycodes,
  serialize,
  setProtocol,
} from '../../../../shared/keycodes/keycodes'
import { PALETTE_MIN_T, paletteColorFromIntensity } from '../../../utils/chart-palette'
import type { TypingBigramTopEntry, TypingKeymapSnapshot } from '../../../../shared/types/typing-analytics'

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

/** Registers the CURRENT session's keyboard as a small one — 4 layers,
 * 16 macros — the same shape a snapshot recorded by a bigger keyboard
 * (8 layers, 32 macros) leaves this session unable to fully resolve by
 * itself (see Task-speed-ranking-snapshot-labels.md). */
function useSmallSessionKeyboard(): void {
  recreateKeyboardKeycodes({
    vialProtocol: 6,
    layers: 4,
    macroCount: 16,
    tapDanceCount: 0,
    customKeycodes: null,
    midi: '',
    supportedFeatures: new Set(),
  })
}

// Re-pins the module-global keyboard registration to this same small
// shape after every test in this file, rather than to a bigger one.
// `qmkIdToKeycode` (shared/keycodes/keycodes.ts) is a plain Map that
// Keycode's constructor only ever ADDS to and nothing ever clears --
// so restoring to a *larger* context here would permanently register
// e.g. `M20` for the rest of this file's run, and a later
// `useSmallSessionKeyboard()` call could no longer make `M20` look
// unresolvable no matter what it passes as `macroCount` (a stale
// Keycode object would still satisfy the `qmkIdToKeycode.get('M20')`
// lookup `deserialize` makes). Restoring to this exact small shape
// instead keeps the file's ambient state deterministic across test
// reorders without ever widening what `qmkIdToKeycode` has registered.
afterEach(() => {
  useSmallSessionKeyboard()
})

function entry(ngramId: string, count: number, hist: number[] = [0, 0, 0, 0, 0, 0, 0, 0]): TypingBigramTopEntry {
  return { ngramId, count, hist, avgIki: null, sd: null }
}

function layerKeycodes(pairs: Record<string, string>): LayerKeycodes {
  return { keycodes: new Map(Object.entries(pairs)), labelOverrides: new Map() }
}

function snapshotWithKeymap(keymap: string[][][], vialProtocol?: number): TypingKeymapSnapshot {
  return {
    uid: '0x00',
    machineHash: 'h',
    productName: 'Test',
    savedAt: 0,
    layers: keymap.length,
    matrix: { rows: keymap[0]?.length ?? 0, cols: keymap[0]?.[0]?.length ?? 0 },
    keymap,
    layout: null,
    vialProtocol,
  }
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

describe('normalizeAvgIntensity (Speed mode: KeySpeedStat.avgIki)', () => {
  const avgIki = (stat: KeySpeedStat): number => stat.avgIki

  it('returns an empty map for an empty speed map', () => {
    expect(normalizeAvgIntensity(new Map(), avgIki).size).toBe(0)
  })

  it('min-max normalizes avgIki to [PALETTE_MIN_T, 1], fastest -> floor, slowest -> 1', () => {
    const speedMap = new Map([
      [4, { avgIki: 50, count: 10 }],
      [5, { avgIki: 150, count: 10 }],
      [6, { avgIki: 250, count: 10 }],
    ])
    const intensity = normalizeAvgIntensity(speedMap, avgIki)
    expect(intensity.get(4)).toBeCloseTo(PALETTE_MIN_T, 10)
    expect(intensity.get(5)).toBeCloseTo(PALETTE_MIN_T + (1 - PALETTE_MIN_T) * 0.5, 10)
    expect(intensity.get(6)).toBe(1)
  })

  it('keeps the fastest qualifying key above the palette visibility floor', () => {
    const speedMap = new Map([
      [4, { avgIki: 50, count: 10 }],
      [5, { avgIki: 250, count: 10 }],
    ])
    const intensity = normalizeAvgIntensity(speedMap, avgIki)
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
    const intensity = normalizeAvgIntensity(speedMap, avgIki)
    const mid = PALETTE_MIN_T + (1 - PALETTE_MIN_T) * 0.5
    expect(intensity.get(4)).toBeCloseTo(mid, 10)
    expect(intensity.get(5)).toBeCloseTo(mid, 10)
  })
})

describe('buildSpeedFillByPos', () => {
  const intensityByCode = new Map([
    // Raw palette-space values passed directly (normalizeAvgIntensity
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

  it('paints an M20 cell instead of treating it as an unresolvable (KC_NO-like) 0 code', () => {
    // A snapshot recorded by a keyboard with 32 macros reports "M20" at
    // this position, but the current session only registered 16 --
    // `deserialize('M20')` silently returns 0 in that case (see
    // decodeSnapshotQmkId's doc comment), which used to make this cell
    // match whatever intensity happened to be keyed at 0 instead of
    // painting nothing (or the correct M20 intensity).
    useSmallSessionKeyboard()
    expect(deserialize('M20')).toBe(0)
    const m20Code = decodeSnapshotQmkId('M20')!
    expect(m20Code).not.toBe(0)

    const kc = layerKeycodes({ '0,0': 'M20' })
    const intensityKeyedAtZero = new Map([[0, 1]])
    // A stray intensity entry at 0 must NOT bleed onto the M20 cell.
    expect(buildSpeedFillByPos(kc, ['0,0'], intensityKeyedAtZero, 'all', 'light').has('0,0')).toBe(false)

    const intensityByM20Code = new Map([[m20Code, 1]])
    expect(buildSpeedFillByPos(kc, ['0,0'], intensityByM20Code, 'all', 'light').get('0,0')).toMatch(/^hsl\(/)
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

  it('ranks protocol-dependent codes using the snapshot protocol\'s own label and restores the global RAWCODES_MAP', () => {
    // 0x7c00 is QK_BOOT under v6 but the masked keycode RAG_T(kc) with a
    // KC_NO inner under v5 (src/shared/keycodes/keycodes-v5.ts:75) — the
    // same v6-session-viewing-v5-snapshot collision code as the
    // favorite-store 0x7c00 case (src/main/__tests__/favorite-store.test.ts:551).
    // Establish the v6 map explicitly first so this doesn't depend on
    // leftover state from earlier tests in this file.
    setProtocol(6)
    recreateKeycodes()

    const speedMap = new Map([[0x7c00, { avgIki: 100, count: 10 }]])
    const ranking = buildSpeedRanking(speedMap, 'all', 10, 5)
    expect(ranking).toHaveLength(1)
    expect(ranking[0].avgIki).toBe(100)
    // Masked RAG_T(kc) + KC_NO inner, stripped of prefixes by codeToLabel.
    expect(ranking[0].keyLabel).toBe('RAG_T(NO)')

    // Restore leg is the mutation-killer: without recreateKeycodes() on
    // the way out, getProtocol() alone would already read 6 here even
    // though RAWCODES_MAP was left rebuilt for v5 — assert the rebuilt
    // map directly by re-serializing 0x7c00 back under v6.
    expect(getProtocol()).toBe(6)
    expect(serialize(0x7c00)).toBe('QK_BOOT')
  })

  it('resolves labels/groups from the snapshot\'s own qmk strings for keyboard-shape mismatches (M20, MO(6))', () => {
    // Session only knows about 4 layers / 16 macros; the snapshot was
    // recorded by an 8-layer / 32-macro keyboard, so `M20` and `MO(6)`
    // are both codes this session's own `RAWCODES_MAP` can't round-trip
    // through `serialize` -- M20 lands on bare hex, MO(6) lands in the
    // 'other' group bucket instead of 'layerOp'. Building the map from
    // the snapshot's own recorded qmk strings sidesteps the round-trip
    // entirely (see Task-speed-ranking-snapshot-labels.md).
    useSmallSessionKeyboard()
    const snapshot = snapshotWithKeymap([[['M20', 'MO(6)']]])
    const qmkByCode = buildSnapshotQmkByCode(snapshot, snapshot.vialProtocol)
    const m20Code = [...qmkByCode.entries()].find(([, id]) => id === 'M20')?.[0]
    const mo6Code = [...qmkByCode.entries()].find(([, id]) => id === 'MO(6)')?.[0]
    expect(m20Code).toBeDefined()
    expect(mo6Code).toBeDefined()

    const speedMap = new Map([
      [m20Code!, { avgIki: 100, count: 10 }],
      [mo6Code!, { avgIki: 200, count: 10 }],
    ])

    const allRanking = buildSpeedRanking(speedMap, 'all', 10, snapshot.vialProtocol, qmkByCode)
    expect(allRanking.find((e) => e.avgIki === 100)?.keyLabel).toBe('M20')
    expect(allRanking.find((e) => e.avgIki === 200)?.keyLabel).toBe('MO(6)')

    // MO(6) must land in the 'layerOp' group filter, not 'other'.
    const layerOpOnly = buildSpeedRanking(speedMap, 'layerOp', 10, snapshot.vialProtocol, qmkByCode)
    expect(layerOpOnly).toHaveLength(1)
    expect(layerOpOnly[0].keyLabel).toBe('MO(6)')
  })

  it('resolves RAG_T(KC_NO) to "RAG_T" (not the #359 fallback\'s "RAG_T(NO)") when the snapshot map has it', () => {
    // Same 0x7c00-family collision code as the #359 test above, but
    // this time the snapshot's own keymap literally recorded
    // "RAG_T(KC_NO)" at v5, so the snapshot-string path resolves it
    // directly instead of falling back to codeToLabel's serialize
    // round-trip (which produces the differently-formatted "RAG_T(NO)").
    const snapshot = snapshotWithKeymap([[['RAG_T(KC_NO)']]], 5)
    const qmkByCode = buildSnapshotQmkByCode(snapshot, snapshot.vialProtocol)
    const code = [...qmkByCode.entries()].find(([, id]) => id === 'RAG_T(KC_NO)')?.[0]
    expect(code).toBeDefined()

    const speedMap = new Map([[code!, { avgIki: 100, count: 10 }]])
    const ranking = buildSpeedRanking(speedMap, 'all', 10, snapshot.vialProtocol, qmkByCode)
    expect(ranking).toHaveLength(1)
    expect(ranking[0].keyLabel).toBe('RAG_T')
  })
})
