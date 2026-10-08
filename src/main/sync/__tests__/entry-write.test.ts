// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { derivedUpdatedAt, EPOCH_ISO, normalizeEntry } from '../entry-clocks'
import { applyEntryMutation, builtinEntry, createEntry, normalizeEntries, overwriteEntry } from '../entry-write'
import type { KeyLabelMeta } from '../../../shared/types/key-label-store'

const T0 = new Date('2026-01-01T00:00:00.000Z')
const T1 = new Date('2026-02-01T00:00:00.000Z')
const T2 = new Date('2026-03-01T00:00:00.000Z')

function label(overrides: Partial<KeyLabelMeta> = {}): KeyLabelMeta {
  return { id: 'a', name: 'A', filename: 'a_1.json', savedAt: T0.toISOString(), updatedAt: T0.toISOString(), ...overrides }
}

describe('normalizeEntries', () => {
  it('reads v1 entries as v2 and drops entries that are not objects with a string id', () => {
    const out = normalizeEntries('keyLabels', [label(), null, 3, { name: 'no id' }])
    expect(out).toHaveLength(1)
    expect(out[0].clocks).toEqual({ created: T0.toISOString(), body: T0.toISOString(), name: T0.toISOString(), hub: T0.toISOString() })
  })

  it('returns [] for a non-array', () => {
    expect(normalizeEntries('keyLabels', undefined)).toEqual([])
  })
})

describe('createEntry / builtinEntry', () => {
  it('createEntry starts every group of the store at now and drops deletedAt', () => {
    const e = createEntry('keyLabels', { ...label(), deletedAt: T0.toISOString() }, T1)
    expect(e.clocks).toEqual({ created: T1.toISOString(), body: T1.toISOString(), name: T1.toISOString(), hub: T1.toISOString() })
    expect(e.updatedAt).toBe(T1.toISOString())
    expect(e.deletedAt).toBeUndefined()
  })

  it('builtinEntry gives every clock and updatedAt the epoch, identical on every call', () => {
    const a = builtinEntry('i18nPacks', { id: 'x', filename: 'packs/x.json', savedAt: EPOCH_ISO })
    const b = builtinEntry('i18nPacks', { id: 'x', filename: 'packs/x.json', savedAt: EPOCH_ISO })
    expect(a).toEqual(b)
    expect(a.updatedAt).toBe(EPOCH_ISO)
    expect(Object.values(a.clocks).every((c) => c === EPOCH_ISO)).toBe(true)
  })
})

describe('overwriteEntry', () => {
  const existing = normalizeEntry('keyLabels', label())

  it('creates when there is no existing entry', () => {
    const e = overwriteEntry('keyLabels', undefined, label(), T1, { body: true, explicit: true })
    expect(e.clocks.created).toBe(T1.toISOString())
  })

  it('an explicit body save over a live entry moves created and body, not an unchanged name', () => {
    const e = overwriteEntry('keyLabels', existing, label({ filename: 'a_2.json' }), T1, { body: true, explicit: true })
    expect(e.clocks.created).toBe(T1.toISOString())
    expect(e.clocks.body).toBe(T1.toISOString())
    expect(e.clocks.name).toBe(T0.toISOString())
    expect(e.clocks.hub).toBe(T0.toISOString())
    expect(e.updatedAt).toBe(derivedUpdatedAt(e.clocks, undefined))
  })

  it('moves a meta group whose values changed', () => {
    const e = overwriteEntry('keyLabels', existing, label({ name: 'B', hubPostId: 'p' }), T1, { body: true, explicit: true })
    expect(e.clocks.name).toBe(T1.toISOString())
    expect(e.clocks.hub).toBe(T1.toISOString())
  })

  it('an unattended save moves neither created nor an unchanged name', () => {
    const e = overwriteEntry('keyLabels', existing, label({ filename: 'a_2.json' }), T1, { body: true, explicit: false })
    expect(e.clocks.created).toBe(T0.toISOString())
    expect(e.clocks.name).toBe(T0.toISOString())
    expect(e.clocks.body).toBe(T1.toISOString())
  })

  it('an explicit save over a tombstone revives it past deletedAt and moves every group', () => {
    const dead = normalizeEntry('keyLabels', label({ deletedAt: T2.toISOString(), updatedAt: T2.toISOString() }))
    const e = overwriteEntry('keyLabels', dead, label(), T1, { body: true, explicit: true })
    expect(e.deletedAt).toBeUndefined()
    // A deletedAt from a clock running ahead still loses to the revival.
    expect(e.clocks.created).toBe(new Date(T2.getTime() + 1).toISOString())
    for (const g of ['body', 'name', 'hub'] as const) {
      expect(new Date(e.clocks[g] ?? EPOCH_ISO).getTime()).toBeGreaterThanOrEqual(T1.getTime())
    }
  })

  it('refuses an unattended save over a tombstone', () => {
    const dead = normalizeEntry('keyLabels', label({ deletedAt: T1.toISOString() }))
    expect(() => overwriteEntry('keyLabels', dead, label(), T2, { body: true, explicit: false })).toThrow()
  })
})

describe('applyEntryMutation', () => {
  it('moves only the given group, or tombstones for delete', () => {
    const entries = [normalizeEntry('keyLabels', label())]
    const renamed = applyEntryMutation(entries, 'a', 'name', T1, (e) => { e.name = 'B' })
    expect(renamed).toMatchObject({ name: 'B', clocks: { name: T1.toISOString(), hub: T0.toISOString() }, updatedAt: T1.toISOString() })
    expect(entries[0]).toBe(renamed)
    expect(applyEntryMutation(entries, 'a', 'delete', T2)?.deletedAt).toBe(T2.toISOString())
    expect(applyEntryMutation(entries, 'missing', 'hub', T2)).toBeUndefined()
  })
})
