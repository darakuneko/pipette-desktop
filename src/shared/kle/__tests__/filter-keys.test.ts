// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { filterVisibleKeys, repositionLayoutKeys } from '../filter-keys'
import type { KleKey } from '../types'

function makeKey(overrides: Partial<KleKey> = {}): KleKey {
  return {
    x: 0, y: 0,
    width: 1, height: 1,
    x2: 0, y2: 0,
    width2: 1, height2: 1,
    rotation: 0, rotationX: 0, rotationY: 0,
    color: '#cccccc',
    labels: Array(12).fill(null),
    textColor: Array(12).fill(null),
    textSize: Array(12).fill(null),
    row: 0, col: 0,
    encoderIdx: -1, encoderDir: -1,
    layoutIndex: -1, layoutOption: -1,
    decal: false, nub: false, stepped: false, ghost: false,
    ...overrides,
  }
}

describe('filterVisibleKeys', () => {
  it('returns all keys when no layout options and no decals', () => {
    const keys = [makeKey({ row: 0, col: 0 }), makeKey({ row: 0, col: 1 })]
    const result = filterVisibleKeys(keys, new Map())
    expect(result).toHaveLength(2)
  })

  it('excludes decal keys', () => {
    const keys = [
      makeKey({ row: 0, col: 0 }),
      makeKey({ row: 0, col: 1, decal: true }),
      makeKey({ row: 0, col: 2 }),
    ]
    const result = filterVisibleKeys(keys, new Map())
    expect(result).toHaveLength(2)
    expect(result.every((k) => !k.decal)).toBe(true)
  })

  it('includes keys with no layout index regardless of options', () => {
    const keys = [
      makeKey({ row: 0, col: 0, layoutIndex: -1 }),
    ]
    const result = filterVisibleKeys(keys, new Map([[0, 1]]))
    expect(result).toHaveLength(1)
  })

  it('filters by layout option when options are set', () => {
    const keys = [
      makeKey({ row: 0, col: 0 }),
      makeKey({ row: 0, col: 1, layoutIndex: 0, layoutOption: 0 }),
      makeKey({ row: 0, col: 2, layoutIndex: 0, layoutOption: 1 }),
    ]
    const result = filterVisibleKeys(keys, new Map([[0, 1]]))
    expect(result).toHaveLength(2)
    expect(result.find((k) => k.col === 1)).toBeUndefined()
    expect(result.find((k) => k.col === 2)).toBeDefined()
  })

  it('defaults to option 0 when layout index not in options map', () => {
    const keys = [
      makeKey({ row: 0, col: 0, layoutIndex: 1, layoutOption: 0 }),
      makeKey({ row: 0, col: 1, layoutIndex: 1, layoutOption: 1 }),
    ]
    // Options map has index 0 but not index 1
    const result = filterVisibleKeys(keys, new Map([[0, 1]]))
    expect(result).toHaveLength(1)
    expect(result[0].layoutOption).toBe(0)
  })

  it('includes all keys when layoutOptions is empty (matches KeyboardWidget)', () => {
    const keys = [
      makeKey({ row: 0, col: 0, layoutIndex: 0, layoutOption: 0 }),
      makeKey({ row: 0, col: 1, layoutIndex: 0, layoutOption: 1 }),
    ]
    const result = filterVisibleKeys(keys, new Map())
    expect(result).toHaveLength(2)
  })

  it('returns empty array for empty input', () => {
    const result = filterVisibleKeys([], new Map())
    expect(result).toHaveLength(0)
  })
})

describe('repositionLayoutKeys', () => {
  it('returns keys unchanged when no layout options are set', () => {
    const keys = [
      makeKey({ x: 0, y: 0, row: 0, col: 0 }),
      makeKey({ x: 1, y: 0, row: 0, col: 1 }),
    ]
    const result = repositionLayoutKeys(keys, new Map())
    expect(result).toBe(keys)
  })

  it('does not shift option 0 keys', () => {
    const keys = [
      makeKey({ x: 0, y: 0, row: 0, col: 0, layoutIndex: 0, layoutOption: 0 }),
      makeKey({ x: 1, y: 0, row: 0, col: 1, layoutIndex: 0, layoutOption: 0 }),
    ]
    const result = repositionLayoutKeys(keys, new Map([[0, 0]]))
    expect(result[0].x).toBe(0)
    expect(result[0].y).toBe(0)
    expect(result[1].x).toBe(1)
    expect(result[1].y).toBe(0)
  })

  it('shifts selected option keys to match option 0 position', () => {
    const keys = [
      // Option 0 at y=1
      makeKey({ x: 0, y: 1, row: 0, col: 0, layoutIndex: 0, layoutOption: 0 }),
      makeKey({ x: 1, y: 1, row: 0, col: 1, layoutIndex: 0, layoutOption: 0 }),
      // Option 1 at y=5 (should be shifted to y=1)
      makeKey({ x: 0, y: 5, row: 1, col: 0, layoutIndex: 0, layoutOption: 1 }),
      makeKey({ x: 1, y: 5, row: 1, col: 1, layoutIndex: 0, layoutOption: 1 }),
    ]
    const result = repositionLayoutKeys(keys, new Map([[0, 1]]))
    // Option 1 keys shifted: y = 5 + (1 - 5) = 1
    expect(result[2].y).toBe(1)
    expect(result[3].y).toBe(1)
    // Option 0 keys unchanged (not selected, but still in input for min computation)
    expect(result[0].y).toBe(1)
  })

  it('handles multiple layout groups with independent shifts', () => {
    const keys = [
      // Group 0, option 0 at (0, 0)
      makeKey({ x: 0, y: 0, row: 0, col: 0, layoutIndex: 0, layoutOption: 0 }),
      // Group 0, option 1 at (0, 3) — should shift to y=0
      makeKey({ x: 0, y: 3, row: 1, col: 0, layoutIndex: 0, layoutOption: 1 }),
      // Group 1, option 0 at (5, 0)
      makeKey({ x: 5, y: 0, row: 0, col: 5, layoutIndex: 1, layoutOption: 0 }),
      // Group 1, option 1 at (5, 4) — should shift to y=0
      makeKey({ x: 5, y: 4, row: 1, col: 5, layoutIndex: 1, layoutOption: 1 }),
    ]
    const result = repositionLayoutKeys(keys, new Map([[0, 1], [1, 1]]))
    // Group 0 option 1: y = 3 + (0 - 3) = 0
    expect(result[1].y).toBe(0)
    // Group 1 option 1: y = 4 + (0 - 4) = 0
    expect(result[3].y).toBe(0)
  })

  it('shifts rotationX and rotationY equally', () => {
    const keys = [
      // Option 0 at (0, 1)
      makeKey({ x: 0, y: 1, rotationX: 0.5, rotationY: 1.5, layoutIndex: 0, layoutOption: 0 }),
      // Option 1 at (2, 5), rotated
      makeKey({ x: 2, y: 5, rotation: 15, rotationX: 3, rotationY: 6, row: 1, col: 0, layoutIndex: 0, layoutOption: 1 }),
    ]
    const result = repositionLayoutKeys(keys, new Map([[0, 1]]))
    // Shift = opt0_min - opt1_min = (0, 1) - (2, 5) = (-2, -4)
    expect(result[1].x).toBe(0)   // 2 + (-2)
    expect(result[1].y).toBe(1)   // 5 + (-4)
    expect(result[1].rotationX).toBe(1) // 3 + (-2)
    expect(result[1].rotationY).toBe(2) // 6 + (-4)
    expect(result[1].rotation).toBe(15) // unchanged
  })

  it('passes non-layout keys through unchanged', () => {
    const common = makeKey({ x: 0, y: 0, row: 0, col: 0, layoutIndex: -1 })
    const opt0 = makeKey({ x: 0, y: 1, row: 0, col: 1, layoutIndex: 0, layoutOption: 0 })
    const opt1 = makeKey({ x: 0, y: 5, row: 1, col: 0, layoutIndex: 0, layoutOption: 1 })
    const keys = [common, opt0, opt1]
    const result = repositionLayoutKeys(keys, new Map([[0, 1]]))
    // Common key should be the same object (no copy)
    expect(result[0]).toBe(common)
    // Option 1 key should be shifted
    expect(result[2].y).toBe(1)
  })

  it('returns same array reference when all selected options are 0', () => {
    const keys = [
      makeKey({ x: 0, y: 0, layoutIndex: 0, layoutOption: 0 }),
      makeKey({ x: 1, y: 0, layoutIndex: 1, layoutOption: 0 }),
      makeKey({ x: 0, y: 0, layoutIndex: -1 }),
    ]
    const result = repositionLayoutKeys(keys, new Map([[0, 0], [1, 0]]))
    expect(result).toBe(keys)
  })

  it('returns empty array for empty input', () => {
    const result = repositionLayoutKeys([], new Map([[0, 1]]))
    expect(result).toHaveLength(0)
  })
})

describe('reposition → filter pipeline', () => {
  it('repositions then filters to produce correct visible keys', () => {
    const opts = new Map([[0, 1]])
    const keys = [
      makeKey({ x: 0, y: 0, row: 0, col: 0, layoutIndex: -1 }), // common
      makeKey({ x: 0, y: 1, row: 1, col: 0, layoutIndex: 0, layoutOption: 0 }), // opt 0
      makeKey({ x: 1, y: 1, row: 1, col: 1, layoutIndex: 0, layoutOption: 0 }), // opt 0
      makeKey({ x: 0, y: 5, row: 2, col: 0, layoutIndex: 0, layoutOption: 1 }), // opt 1
      makeKey({ x: 1, y: 5, row: 2, col: 1, layoutIndex: 0, layoutOption: 1 }), // opt 1
    ]
    // Correct order: reposition ALL keys first, then filter
    const result = filterVisibleKeys(repositionLayoutKeys(keys, opts), opts)
    // Should have: 1 common + 2 option-1 keys (option 0 filtered out)
    expect(result).toHaveLength(3)
    // Option 1 keys should be repositioned to y=1 (matching option 0's position)
    expect(result[1].y).toBe(1)
    expect(result[2].y).toBe(1)
  })

  it('wrong order (filter → reposition) fails to reposition', () => {
    const opts = new Map([[0, 1]])
    const keys = [
      makeKey({ x: 0, y: 1, row: 1, col: 0, layoutIndex: 0, layoutOption: 0 }),
      makeKey({ x: 0, y: 5, row: 2, col: 0, layoutIndex: 0, layoutOption: 1 }),
    ]
    // Wrong order: filter first removes option 0 keys, so opt0Min is undefined
    const wrong = repositionLayoutKeys(filterVisibleKeys(keys, opts), opts)
    // Option 1 key is NOT repositioned because opt0Min is missing
    expect(wrong[0].y).toBe(5) // still at original position
  })
})
