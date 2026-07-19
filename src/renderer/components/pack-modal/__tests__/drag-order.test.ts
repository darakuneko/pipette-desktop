// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { applyDragOrder } from '../drag-order'

interface Item { id: string; label: string }

function items(...ids: string[]): Item[] {
  return ids.map((id) => ({ id, label: id.toUpperCase() }))
}

describe('applyDragOrder', () => {
  it('returns items unchanged when order is null', () => {
    const list = items('a', 'b', 'c')
    expect(applyDragOrder(list, null, (i) => i.id)).toBe(list)
  })

  it('reorders items according to the given id order', () => {
    const list = items('a', 'b', 'c')
    const result = applyDragOrder(list, ['c', 'a', 'b'], (i) => i.id)
    expect(result.map((i) => i.id)).toEqual(['c', 'a', 'b'])
  })

  it('appends items missing from the order at the end, preserving their relative order', () => {
    const list = items('a', 'b', 'c', 'd')
    const result = applyDragOrder(list, ['c'], (i) => i.id)
    expect(result.map((i) => i.id)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('ignores ids in the order list that no longer exist', () => {
    const list = items('a', 'b')
    const result = applyDragOrder(list, ['ghost', 'b', 'a'], (i) => i.id)
    expect(result.map((i) => i.id)).toEqual(['b', 'a'])
  })

  it('ignores duplicate ids in the order list', () => {
    const list = items('a', 'b', 'c')
    const result = applyDragOrder(list, ['a', 'a', 'b'], (i) => i.id)
    expect(result.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
})
