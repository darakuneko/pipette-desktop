// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { computeSortedInsertOrder, computeSortedInsertOrderMany } from '../sorted-insert'

describe('computeSortedInsertOrder', () => {
  it('returns null for the free state — the store appends new entries at the bottom on its own', () => {
    const existing = [{ id: 'a', name: 'Alpha' }, { id: 'z', name: 'Zeta' }]
    expect(computeSortedInsertOrder(existing, { id: 'm', name: 'Mu' }, 'free')).toBeNull()
  })

  it('asc: inserts in the middle at the correct sorted position', () => {
    const existing = [{ id: 'a', name: 'Alpha' }, { id: 'z', name: 'Zeta' }]
    expect(computeSortedInsertOrder(existing, { id: 'm', name: 'Mu' }, 'asc')).toEqual(['a', 'm', 'z'])
  })

  it('asc: inserts at the very first position', () => {
    const existing = [{ id: 'm', name: 'Mu' }, { id: 'z', name: 'Zeta' }]
    expect(computeSortedInsertOrder(existing, { id: 'a', name: 'Alpha' }, 'asc')).toEqual(['a', 'm', 'z'])
  })

  it('asc: inserts at the very last position', () => {
    const existing = [{ id: 'a', name: 'Alpha' }, { id: 'm', name: 'Mu' }]
    expect(computeSortedInsertOrder(existing, { id: 'z', name: 'Zeta' }, 'asc')).toEqual(['a', 'm', 'z'])
  })

  it('desc: inserts in the middle at the correct sorted position', () => {
    const existing = [{ id: 'z', name: 'Zeta' }, { id: 'a', name: 'Alpha' }]
    expect(computeSortedInsertOrder(existing, { id: 'm', name: 'Mu' }, 'desc')).toEqual(['z', 'm', 'a'])
  })

  it('desc: inserts at the very first position', () => {
    const existing = [{ id: 'm', name: 'Mu' }, { id: 'a', name: 'Alpha' }]
    expect(computeSortedInsertOrder(existing, { id: 'z', name: 'Zeta' }, 'desc')).toEqual(['z', 'm', 'a'])
  })

  it('desc: inserts at the very last position', () => {
    const existing = [{ id: 'z', name: 'Zeta' }, { id: 'm', name: 'Mu' }]
    expect(computeSortedInsertOrder(existing, { id: 'a', name: 'Alpha' }, 'desc')).toEqual(['z', 'm', 'a'])
  })

  it('handles an empty existing list (first entry ever)', () => {
    expect(computeSortedInsertOrder([], { id: 'a', name: 'Alpha' }, 'asc')).toEqual(['a'])
  })

  it('is case-insensitive/locale-aware (sensitivity: base), matching compareNames', () => {
    const existing = [{ id: 'lower', name: 'alpha' }]
    expect(computeSortedInsertOrder(existing, { id: 'upper', name: 'BETA' }, 'asc')).toEqual(['lower', 'upper'])
  })
})

describe('computeSortedInsertOrderMany', () => {
  it('interleaves multiple new entries among existing rows in one pass (P1 batch race regression)', () => {
    // existing A,D ascending; import B then C (in that processing
    // order) — must land fully sorted A,B,C,D, not A,C,D,B (the
    // per-item bug: C computed from a stale [A,D] snapshot that never
    // saw B's insert).
    const existing = [{ id: 'a', name: 'Alpha' }, { id: 'd', name: 'Delta' }]
    const newEntries = [{ id: 'b', name: 'Bravo' }, { id: 'c', name: 'Charlie' }]
    expect(computeSortedInsertOrderMany(existing, newEntries, 'asc')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('interleaves in descending order too', () => {
    const existing = [{ id: 'd', name: 'Delta' }, { id: 'a', name: 'Alpha' }]
    const newEntries = [{ id: 'c', name: 'Charlie' }, { id: 'b', name: 'Bravo' }]
    expect(computeSortedInsertOrderMany(existing, newEntries, 'desc')).toEqual(['d', 'c', 'b', 'a'])
  })

  it('is order-independent: processing [C, B] yields the same final order as [B, C]', () => {
    const existing = [{ id: 'a', name: 'Alpha' }, { id: 'd', name: 'Delta' }]
    const inOrder = computeSortedInsertOrderMany(existing, [{ id: 'b', name: 'Bravo' }, { id: 'c', name: 'Charlie' }], 'asc')
    const reversed = computeSortedInsertOrderMany(existing, [{ id: 'c', name: 'Charlie' }, { id: 'b', name: 'Bravo' }], 'asc')
    expect(inOrder).toEqual(['a', 'b', 'c', 'd'])
    expect(reversed).toEqual(['a', 'b', 'c', 'd'])
  })

  it('handles an empty existing list (first entries ever)', () => {
    const newEntries = [{ id: 'b', name: 'Bravo' }, { id: 'a', name: 'Alpha' }]
    expect(computeSortedInsertOrderMany([], newEntries, 'asc')).toEqual(['a', 'b'])
  })

  it('returns null for the free state', () => {
    const existing = [{ id: 'a', name: 'Alpha' }]
    expect(computeSortedInsertOrderMany(existing, [{ id: 'b', name: 'Bravo' }], 'free')).toBeNull()
  })

  it('returns null when there is nothing to insert', () => {
    const existing = [{ id: 'a', name: 'Alpha' }]
    expect(computeSortedInsertOrderMany(existing, [], 'asc')).toBeNull()
  })
})
