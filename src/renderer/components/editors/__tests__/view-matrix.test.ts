// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  sortKeysByViewMatrix, applyViewMatrixOverride, applyViewMatrixAxisToSelection,
  countViewMatrixDuplicates, effectiveViewPos, type ViewMatrixKeyRef,
} from '../view-matrix'

interface TestKey extends ViewMatrixKeyRef {
  id: string
}

function key(id: string, row: number, col: number): TestKey {
  return { id, row, col }
}

describe('effectiveViewPos', () => {
  it('returns the override position when one exists for the key', () => {
    expect(effectiveViewPos({ '1,2': { row: 5, col: 7 } }, 1, 2)).toEqual({ row: 5, col: 7 })
  })

  it('falls back to the physical position when there is no override', () => {
    expect(effectiveViewPos(undefined, 3, 4)).toEqual({ row: 3, col: 4 })
    expect(effectiveViewPos({ '9,9': { row: 0, col: 0 } }, 3, 4)).toEqual({ row: 3, col: 4 })
  })
})

describe('sortKeysByViewMatrix', () => {
  it('orders by physical row-major position when there is no viewMatrix', () => {
    const keys = [key('b', 0, 1), key('a', 0, 0), key('d', 1, 1), key('c', 1, 0)]
    const result = sortKeysByViewMatrix(keys, undefined)
    expect(result.map((k) => k.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('orders by physical row-major position when viewMatrix is an empty map', () => {
    const keys = [key('b', 0, 1), key('a', 0, 0)]
    const result = sortKeysByViewMatrix(keys, {})
    expect(result.map((k) => k.id)).toEqual(['a', 'b'])
  })

  it('moves a key earlier in the order via a single override', () => {
    // Physical order is a(0,0), b(0,1), c(0,2). Override c to logical (0,0),
    // tying its effective position with a's — the physical (row, col)
    // tiebreak then keeps a first (physical col 0) ahead of c (physical
    // col 2), with c pulled ahead of untouched b either way.
    const keys = [key('a', 0, 0), key('b', 0, 1), key('c', 0, 2)]
    const viewMatrix = { '0,2': { row: 0, col: 0 } }
    const result = sortKeysByViewMatrix(keys, viewMatrix)
    expect(result.map((k) => k.id)).toEqual(['a', 'c', 'b'])
  })

  it('moves a key later in the order via a single override', () => {
    const keys = [key('a', 0, 0), key('b', 0, 1), key('c', 0, 2)]
    const viewMatrix = { '0,0': { row: 0, col: 9 } }
    const result = sortKeysByViewMatrix(keys, viewMatrix)
    expect(result.map((k) => k.id)).toEqual(['b', 'c', 'a'])
  })

  it('keeps a stable, deterministic order when two keys share the same view position', () => {
    const keys = [key('a', 1, 0), key('b', 0, 0)]
    // Both keys are overridden to the same logical cell — tie breaks on
    // physical (row, col), so b (physical row 0) sorts before a (row 1).
    const viewMatrix = { '1,0': { row: 5, col: 5 }, '0,0': { row: 5, col: 5 } }
    const result = sortKeysByViewMatrix(keys, viewMatrix)
    expect(result.map((k) => k.id)).toEqual(['b', 'a'])
  })

  it('falls back to original array index when both effective and physical positions tie', () => {
    const keys = [key('first', 0, 0), key('second', 0, 0)]
    const result = sortKeysByViewMatrix(keys, undefined)
    expect(result.map((k) => k.id)).toEqual(['first', 'second'])
  })

  it('does not apply an override to a key whose physical position does not match its key', () => {
    const keys = [key('a', 2, 3)]
    // An override exists for a different physical position — must not affect 'a'.
    const viewMatrix = { '0,0': { row: 9, col: 9 } }
    const result = sortKeysByViewMatrix(keys, viewMatrix)
    expect(result).toEqual(keys)
  })

  it('returns a new array without mutating the input', () => {
    const keys = [key('b', 0, 1), key('a', 0, 0)]
    const result = sortKeysByViewMatrix(keys, undefined)
    expect(result).not.toBe(keys)
    expect(keys.map((k) => k.id)).toEqual(['b', 'a'])
  })

  it('sorts non-integer physical rows purely numerically, unaffected by any validation rules', () => {
    // The pure helper never validates row/col shape (that's the store's
    // job) — it must still order fractional physical positions correctly.
    const keys = [key('b', 1.5, 0), key('a', 0.5, 0)]
    const result = sortKeysByViewMatrix(keys, undefined)
    expect(result.map((k) => k.id)).toEqual(['a', 'b'])
  })
})

describe('applyViewMatrixOverride', () => {
  it('adds a new override entry when the map is empty', () => {
    const result = applyViewMatrixOverride(undefined, 0, 0, 2, 3)
    expect(result).toEqual({ '0,0': { row: 2, col: 3 } })
  })

  it('overwrites an existing override entry for the same physical key', () => {
    const current = { '0,0': { row: 1, col: 1 } }
    const result = applyViewMatrixOverride(current, 0, 0, 5, 5)
    expect(result).toEqual({ '0,0': { row: 5, col: 5 } })
  })

  it('leaves other entries untouched when adding one for a different key', () => {
    const current = { '1,1': { row: 9, col: 9 } }
    const result = applyViewMatrixOverride(current, 0, 0, 2, 3)
    expect(result).toEqual({ '1,1': { row: 9, col: 9 }, '0,0': { row: 2, col: 3 } })
  })

  it('deletes the override when the saved position equals the physical position', () => {
    const current = { '0,0': { row: 5, col: 5 }, '1,1': { row: 9, col: 9 } }
    const result = applyViewMatrixOverride(current, 0, 0, 0, 0)
    expect(result).toEqual({ '1,1': { row: 9, col: 9 } })
  })

  it('returns undefined instead of an empty object when the last override is removed', () => {
    const current = { '0,0': { row: 5, col: 5 } }
    const result = applyViewMatrixOverride(current, 0, 0, 0, 0)
    expect(result).toBeUndefined()
  })

  it('is a no-op equal-to-physical save against an already-empty map', () => {
    const result = applyViewMatrixOverride(undefined, 2, 3, 2, 3)
    expect(result).toBeUndefined()
  })

  it('does not mutate the input map', () => {
    const current = { '0,0': { row: 5, col: 5 } }
    applyViewMatrixOverride(current, 1, 1, 2, 2)
    expect(current).toEqual({ '0,0': { row: 5, col: 5 } })
  })
})

describe('applyViewMatrixAxisToSelection', () => {
  it('applies the same row to every key in the selection, keeping each own col', () => {
    const selection = [key('a', 0, 0), key('b', 1, 1), key('c', 2, 2)]
    const result = applyViewMatrixAxisToSelection(undefined, selection, 'row', 9)
    expect(result).toEqual({
      '0,0': { row: 9, col: 0 },
      '1,1': { row: 9, col: 1 },
      '2,2': { row: 9, col: 2 },
    })
  })

  it('applies the same col to every key in the selection, keeping each own row', () => {
    const selection = [key('a', 0, 0), key('b', 1, 1)]
    const result = applyViewMatrixAxisToSelection(undefined, selection, 'col', 7)
    expect(result).toEqual({
      '0,0': { row: 0, col: 7 },
      '1,1': { row: 1, col: 7 },
    })
  })

  it('starts from each key\'s existing override, not its physical position', () => {
    const current = { '0,0': { row: 5, col: 5 } }
    const selection = [key('a', 0, 0)]
    const result = applyViewMatrixAxisToSelection(current, selection, 'col', 8)
    expect(result).toEqual({ '0,0': { row: 5, col: 8 } })
  })

  it('drops an entry back to sparse when the bulk value resolves to the physical position', () => {
    const current = { '0,0': { row: 5, col: 5 } }
    const selection = [key('a', 0, 0)]
    const result = applyViewMatrixAxisToSelection(current, selection, 'row', 0)
    const result2 = applyViewMatrixAxisToSelection(result, selection, 'col', 0)
    expect(result2).toBeUndefined()
  })

  it('leaves entries for keys outside the selection untouched', () => {
    const current = { '9,9': { row: 1, col: 1 } }
    const selection = [key('a', 0, 0)]
    const result = applyViewMatrixAxisToSelection(current, selection, 'row', 3)
    expect(result).toEqual({ '9,9': { row: 1, col: 1 }, '0,0': { row: 3, col: 0 } })
  })

  it('returns the input unchanged for an empty selection', () => {
    const current = { '0,0': { row: 5, col: 5 } }
    const result = applyViewMatrixAxisToSelection(current, [], 'row', 1)
    expect(result).toEqual(current)
  })
})

describe('countViewMatrixDuplicates', () => {
  it('returns 0 when every key resolves to a distinct effective position', () => {
    const keys = [key('a', 0, 0), key('b', 0, 1)]
    expect(countViewMatrixDuplicates(keys, undefined)).toBe(0)
  })

  it('counts both keys when two collide via an override', () => {
    const keys = [key('a', 0, 0), key('b', 0, 1)]
    const viewMatrix = { '0,1': { row: 0, col: 0 } }
    expect(countViewMatrixDuplicates(keys, viewMatrix)).toBe(2)
  })

  it('sums across multiple independent collision groups', () => {
    const keys = [key('a', 0, 0), key('b', 0, 1), key('c', 1, 0), key('d', 1, 1)]
    const viewMatrix = { '0,1': { row: 0, col: 0 }, '1,1': { row: 1, col: 0 } }
    expect(countViewMatrixDuplicates(keys, viewMatrix)).toBe(4)
  })

  it('counts all members of a larger collision group, not just the first pair', () => {
    const keys = [key('a', 0, 0), key('b', 0, 1), key('c', 0, 2)]
    const viewMatrix = { '0,1': { row: 0, col: 0 }, '0,2': { row: 0, col: 0 } }
    expect(countViewMatrixDuplicates(keys, viewMatrix)).toBe(3)
  })

  it('resolves back to 0 once the colliding override is removed', () => {
    const keys = [key('a', 0, 0), key('b', 0, 1)]
    expect(countViewMatrixDuplicates(keys, undefined)).toBe(0)
  })
})
