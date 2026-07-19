// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { computeSortedInsertOrder } from '../sorted-insert'

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
