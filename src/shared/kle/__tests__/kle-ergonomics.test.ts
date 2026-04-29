// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { parseKle } from '../kle-parser'
import type { KleKey } from '../types'
import {
  FINGER_LIST,
  HAND_OF_FINGER,
  buildErgonomicsByPos,
  buildErgonomicsContext,
  clusterRowsByY,
  detectSplitGap,
  detectThumbSet,
  estimateErgonomics,
  estimateErgonomicsWithContext,
  estimateHandFromX,
  estimateRowCategoryFromClusters,
} from '../kle-ergonomics'
import { posKey } from '../pos-key'

function keyAt(keys: KleKey[], row: number, col: number): KleKey {
  const k = keys.find((x) => x.row === row && x.col === col)
  if (!k) throw new Error(`Key at ${row},${col} not found`)
  return k
}

/** Pared-down ANSI 60% layout: 14 + 14 + 13 + 12 + 8 = 61 keys. */
function buildAnsi60(): KleKey[] {
  return parseKle([
    // Row 0: 13 unit-keys + Bksp(2u) = 14 keys, 15u wide
    [
      '0,0', '0,1', '0,2', '0,3', '0,4', '0,5', '0,6',
      '0,7', '0,8', '0,9', '0,10', '0,11', '0,12',
      { w: 2 }, '0,13',
    ],
    // Row 1: Tab(1.5u) + 12 unit + \(1.5u)
    [
      { w: 1.5 }, '1,0',
      '1,1', '1,2', '1,3', '1,4', '1,5', '1,6', '1,7',
      '1,8', '1,9', '1,10', '1,11', '1,12',
      { w: 1.5 }, '1,13',
    ],
    // Row 2: Caps(1.75u) + 11 unit + Enter(2.25u)
    [
      { w: 1.75 }, '2,0',
      '2,1', '2,2', '2,3', '2,4', '2,5', '2,6',
      '2,7', '2,8', '2,9', '2,10', '2,11',
      { w: 2.25 }, '2,12',
    ],
    // Row 3: LShift(2.25u) + 10 unit + RShift(2.75u)
    [
      { w: 2.25 }, '3,0',
      '3,1', '3,2', '3,3', '3,4', '3,5',
      '3,6', '3,7', '3,8', '3,9', '3,10',
      { w: 2.75 }, '3,11',
    ],
    // Row 4: 3 mod(1.25u) + Space(6.25u) + 4 mod(1.25u)
    [
      { w: 1.25 }, '4,0',
      { w: 1.25 }, '4,1',
      { w: 1.25 }, '4,2',
      { w: 6.25 }, '4,3',
      { w: 1.25 }, '4,4',
      { w: 1.25 }, '4,5',
      { w: 1.25 }, '4,6',
      { w: 1.25 }, '4,7',
    ],
  ]).keys
}

/** Tiny split-style layout: 2 main rows + 1 thumb row, 3u center gap. */
function buildSplit(): KleKey[] {
  return parseKle([
    [
      '0,0', '0,1', '0,2', '0,3', '0,4', '0,5',
      { x: 3 }, '0,6', '0,7', '0,8', '0,9', '0,10', '0,11',
    ],
    [
      '1,0', '1,1', '1,2', '1,3', '1,4', '1,5',
      { x: 3 }, '1,6', '1,7', '1,8', '1,9', '1,10', '1,11',
    ],
    [{ x: 3 }, '2,0', '2,1', { x: 5 }, '2,2', '2,3'],
  ]).keys
}

describe('KLE Ergonomics — type tables', () => {
  it('FINGER_LIST contains exactly 10 finger types', () => {
    expect(FINGER_LIST).toHaveLength(10)
    expect(new Set(FINGER_LIST).size).toBe(10)
  })

  it('HAND_OF_FINGER maps every finger to left or right', () => {
    for (const f of FINGER_LIST) {
      expect(HAND_OF_FINGER[f]).toMatch(/^(left|right)$/)
    }
  })
})

describe('clusterRowsByY', () => {
  it('returns [] for empty input', () => {
    expect(clusterRowsByY([])).toEqual([])
  })

  it('groups a single key into a single cluster', () => {
    const keys = parseKle([['0,0']]).keys
    expect(clusterRowsByY(keys)).toHaveLength(1)
  })

  it('clusters ANSI 60% into 5 rows sorted top-to-bottom', () => {
    const clusters = clusterRowsByY(buildAnsi60())
    expect(clusters).toHaveLength(5)
    for (let i = 1; i < clusters.length; i++) {
      expect(clusters[i][0].y).toBeGreaterThan(clusters[i - 1][0].y)
    }
  })

  it('sorts each cluster left-to-right', () => {
    const clusters = clusterRowsByY(buildAnsi60())
    for (const cluster of clusters) {
      for (let i = 1; i < cluster.length; i++) {
        expect(cluster[i].x).toBeGreaterThanOrEqual(cluster[i - 1].x)
      }
    }
  })
})

describe('detectSplitGap', () => {
  it('returns null for a continuous ANSI 60% layout', () => {
    expect(detectSplitGap(buildAnsi60())).toBeNull()
  })

  it('detects a clear center gap on a split layout', () => {
    const gap = detectSplitGap(buildSplit())
    expect(gap).not.toBeNull()
    expect(gap?.gap).toBeCloseTo(4, 3)
    expect(gap?.midX).toBeCloseTo(7.5, 3)
  })
})

describe('detectThumbSet', () => {
  it('returns an empty set when fewer than 2 rows exist', () => {
    const keys = parseKle([['0,0', '0,1']]).keys
    expect(detectThumbSet(clusterRowsByY(keys)).size).toBe(0)
  })

  it('includes every bottom-row key for ANSI 60%', () => {
    const clusters = clusterRowsByY(buildAnsi60())
    const thumb = detectThumbSet(clusters)
    expect(thumb.size).toBe(8)
    expect(thumb.has('4,0')).toBe(true)
    expect(thumb.has('4,3')).toBe(true)
    expect(thumb.has('4,7')).toBe(true)
  })
})

describe('estimateHandFromX', () => {
  it('returns left when x is below midX', () => {
    expect(estimateHandFromX(1, 5)).toBe('left')
  })

  it('returns right when x is above midX', () => {
    expect(estimateHandFromX(9, 5)).toBe('right')
  })

  it('keeps boundary keys on the left hand (B on left-index)', () => {
    expect(estimateHandFromX(5, 5)).toBe('left')
  })
})

describe('estimateRowCategoryFromClusters', () => {
  it('returns undefined with only one row cluster', () => {
    const keys = parseKle([['0,0']]).keys
    const clusters = clusterRowsByY(keys)
    expect(estimateRowCategoryFromClusters(keys[0], clusters)).toBeUndefined()
  })

  it('labels ANSI 60% rows as number / top / home / bottom / thumb', () => {
    const keys = buildAnsi60()
    const clusters = clusterRowsByY(keys)
    expect(estimateRowCategoryFromClusters(keyAt(keys, 0, 1), clusters)).toBe('number')
    expect(estimateRowCategoryFromClusters(keyAt(keys, 1, 1), clusters)).toBe('top')
    expect(estimateRowCategoryFromClusters(keyAt(keys, 2, 1), clusters)).toBe('home')
    expect(estimateRowCategoryFromClusters(keyAt(keys, 3, 1), clusters)).toBe('bottom')
    expect(estimateRowCategoryFromClusters(keyAt(keys, 4, 0), clusters)).toBe('thumb')
  })

  it('returns undefined for a key missing from every cluster', () => {
    const clusters = clusterRowsByY(buildAnsi60())
    expect(
      estimateRowCategoryFromClusters({ row: 99, col: 99 }, clusters),
    ).toBeUndefined()
  })
})

describe('estimateErgonomics — ANSI 60% integration', () => {
  const keys = buildAnsi60()

  // Boundary keys (B center === home-row midX) stay on the left hand via the
  // cx<=midX rule in estimateHandFromX, which keeps B on left-index.
  const cases: Array<[
    string,
    number,
    number,
    { finger: string; hand: string; row: string },
  ]> = [
    // Top row (QWERTY)
    ['Q',  1, 1,  { finger: 'left-pinky',   hand: 'left',  row: 'top' }],
    ['W',  1, 2,  { finger: 'left-ring',    hand: 'left',  row: 'top' }],
    ['E',  1, 3,  { finger: 'left-middle',  hand: 'left',  row: 'top' }],
    ['R',  1, 4,  { finger: 'left-index',   hand: 'left',  row: 'top' }],
    ['T',  1, 5,  { finger: 'left-index',   hand: 'left',  row: 'top' }],
    ['Y',  1, 6,  { finger: 'right-index',  hand: 'right', row: 'top' }],
    ['U',  1, 7,  { finger: 'right-index',  hand: 'right', row: 'top' }],
    ['I',  1, 8,  { finger: 'right-middle', hand: 'right', row: 'top' }],
    ['O',  1, 9,  { finger: 'right-ring',   hand: 'right', row: 'top' }],
    ['P',  1, 10, { finger: 'right-pinky',  hand: 'right', row: 'top' }],
    // Home row (ASDF…)
    ['A',  2, 1,  { finger: 'left-pinky',   hand: 'left',  row: 'home' }],
    ['S',  2, 2,  { finger: 'left-ring',    hand: 'left',  row: 'home' }],
    ['D',  2, 3,  { finger: 'left-middle',  hand: 'left',  row: 'home' }],
    ['F',  2, 4,  { finger: 'left-index',   hand: 'left',  row: 'home' }],
    ['G',  2, 5,  { finger: 'left-index',   hand: 'left',  row: 'home' }],
    ['H',  2, 6,  { finger: 'right-index',  hand: 'right', row: 'home' }],
    ['J',  2, 7,  { finger: 'right-index',  hand: 'right', row: 'home' }],
    ['K',  2, 8,  { finger: 'right-middle', hand: 'right', row: 'home' }],
    // Bottom row (ZXCV…)
    ['Z',  3, 1,  { finger: 'left-pinky',   hand: 'left',  row: 'bottom' }],
    ['B',  3, 5,  { finger: 'left-index',   hand: 'left',  row: 'bottom' }],
    ['N',  3, 6,  { finger: 'right-index',  hand: 'right', row: 'bottom' }],
    // Thumb row
    ['LCtrl', 4, 0, { finger: 'left-thumb',  hand: 'left',  row: 'thumb' }],
    ['LAlt',  4, 2, { finger: 'left-thumb',  hand: 'left',  row: 'thumb' }],
    ['Space', 4, 3, { finger: 'right-thumb', hand: 'right', row: 'thumb' }],
    ['RAlt',  4, 4, { finger: 'right-thumb', hand: 'right', row: 'thumb' }],
  ]

  it.each(cases)('classifies %s', (_label, row, col, expected) => {
    const meta = estimateErgonomics(keyAt(keys, row, col), keys)
    expect(meta).toMatchObject(expected)
  })
})

describe('estimateErgonomicsWithContext', () => {
  it('produces the same result as the one-shot entry point', () => {
    const keys = buildAnsi60()
    const ctx = buildErgonomicsContext(keys)
    expect(ctx).not.toBeNull()
    const key = keyAt(keys, 1, 1)
    expect(estimateErgonomicsWithContext(key, ctx!)).toEqual(
      estimateErgonomics(key, keys),
    )
  })
})

describe('estimateErgonomics — edge cases', () => {
  it('returns {} when allKeys is empty', () => {
    expect(estimateErgonomics({} as KleKey, [])).toEqual({})
  })

  it('returns hand but no row for a single-key layout', () => {
    const keys = parseKle([['0,0']]).keys
    const meta = estimateErgonomics(keys[0], keys)
    expect(meta.hand).toBeDefined()
    expect(meta.row).toBeUndefined()
  })
})

describe('Split layout integration', () => {
  const keys = buildSplit()

  it('detects split midX and stores it on the context', () => {
    const ctx = buildErgonomicsContext(keys)
    expect(ctx?.splitMidX).toBeCloseTo(7.5, 3)
    expect(ctx?.handMidX).toBeCloseTo(7.5, 3)
  })

  it('assigns hand by split side', () => {
    expect(estimateErgonomics(keyAt(keys, 0, 0), keys).hand).toBe('left')
    expect(estimateErgonomics(keyAt(keys, 0, 6), keys).hand).toBe('right')
  })

  it('marks bottom-row keys as thumb on both sides', () => {
    const leftThumb = estimateErgonomics(keyAt(keys, 2, 0), keys)
    const rightThumb = estimateErgonomics(keyAt(keys, 2, 3), keys)
    expect(leftThumb.finger).toBe('left-thumb')
    expect(leftThumb.row).toBe('thumb')
    expect(rightThumb.finger).toBe('right-thumb')
    expect(rightThumb.row).toBe('thumb')
  })
})

describe('buildErgonomicsByPos', () => {
  it('returns one ErgonomicsMeta per key, keyed by posKey', () => {
    const keys = buildAnsi60()
    const map = buildErgonomicsByPos(keys)
    expect(map.size).toBe(keys.length)
    for (const k of keys) {
      const meta = map.get(posKey(k.row, k.col))
      expect(meta).toBeDefined()
      // The pre-computed estimate must match the on-the-fly call.
      expect(meta).toEqual(estimateErgonomics(k, keys))
    }
  })

  it('returns an empty map when geometry context cannot be built', () => {
    expect(buildErgonomicsByPos([]).size).toBe(0)
  })
})
