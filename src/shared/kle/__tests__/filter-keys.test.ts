// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { filterVisibleKeys } from '../filter-keys'
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
