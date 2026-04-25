// SPDX-License-Identifier: GPL-2.0-or-later
// Covers the DeviceScope union + serialisation helpers so the Analyze
// filter round-trip (persist → restore → IPC boundary) has a single
// specification. Works on the shared types — no renderer or main-side
// stubbing needed.

import { describe, it, expect } from 'vitest'
import {
  MAX_DEVICE_SCOPES,
  isAllScope,
  isHashScope,
  isOwnScope,
  isValidAnalyzeFilterSettings,
  normalizeDeviceScopes,
  parseDeviceScope,
  scopeFromSelectValue,
  scopeToSelectValue,
} from '../analyze-filters'

describe('DeviceScope narrowing helpers', () => {
  it('classifies static scopes', () => {
    expect(isOwnScope('own')).toBe(true)
    expect(isAllScope('all')).toBe(true)
    expect(isHashScope({ kind: 'hash', machineHash: 'abc' })).toBe(true)
    expect(isOwnScope('all')).toBe(false)
    expect(isAllScope({ kind: 'hash', machineHash: 'abc' })).toBe(false)
    expect(isHashScope('own')).toBe(false)
  })
})

describe('parseDeviceScope', () => {
  it('accepts the static scopes', () => {
    expect(parseDeviceScope('own')).toBe('own')
    expect(parseDeviceScope('all')).toBe('all')
  })

  it('accepts a well-formed hash scope', () => {
    expect(parseDeviceScope({ kind: 'hash', machineHash: 'abcd1234' })).toEqual({
      kind: 'hash',
      machineHash: 'abcd1234',
    })
  })

  it.each([
    ['unknown string', 'neither'],
    ['null', null],
    ['undefined', undefined],
    ['wrong kind', { kind: 'other', machineHash: 'abc' }],
    ['empty hash', { kind: 'hash', machineHash: '' }],
    ['non-string hash', { kind: 'hash', machineHash: 42 }],
    ['array payload', ['hash', 'abc']],
  ])('rejects %s', (_name, value) => {
    expect(parseDeviceScope(value)).toBeNull()
  })
})

describe('scopeToSelectValue / scopeFromSelectValue', () => {
  it('round-trips static scopes', () => {
    expect(scopeToSelectValue('own')).toBe('own')
    expect(scopeFromSelectValue('own')).toBe('own')
    expect(scopeToSelectValue('all')).toBe('all')
    expect(scopeFromSelectValue('all')).toBe('all')
  })

  it('round-trips hash scopes via the `hash:` prefix', () => {
    const value = scopeToSelectValue({ kind: 'hash', machineHash: 'deadbeef' })
    expect(value).toBe('hash:deadbeef')
    expect(scopeFromSelectValue(value)).toEqual({ kind: 'hash', machineHash: 'deadbeef' })
  })

  it('returns null for unknown select values', () => {
    expect(scopeFromSelectValue('')).toBeNull()
    expect(scopeFromSelectValue('random')).toBeNull()
    expect(scopeFromSelectValue('hash:')).toBeNull()
  })
})

describe('isValidAnalyzeFilterSettings', () => {
  it('accepts undefined / null (first-launch default)', () => {
    expect(isValidAnalyzeFilterSettings(undefined)).toBe(true)
    expect(isValidAnalyzeFilterSettings(null)).toBe(true)
  })

  it('accepts legacy static deviceScope values', () => {
    expect(isValidAnalyzeFilterSettings({ deviceScope: 'own' })).toBe(true)
    expect(isValidAnalyzeFilterSettings({ deviceScope: 'all' })).toBe(true)
  })

  it('accepts hash deviceScope', () => {
    expect(
      isValidAnalyzeFilterSettings({ deviceScope: { kind: 'hash', machineHash: 'abc' } }),
    ).toBe(true)
  })

  it('rejects unknown deviceScope shapes', () => {
    expect(isValidAnalyzeFilterSettings({ deviceScope: 'bogus' })).toBe(false)
    expect(isValidAnalyzeFilterSettings({ deviceScope: { kind: 'hash', machineHash: '' } })).toBe(false)
  })
})

describe('normalizeDeviceScopes', () => {
  it("falls back to ['own'] for null / undefined / empty inputs", () => {
    expect(normalizeDeviceScopes(null)).toEqual(['own'])
    expect(normalizeDeviceScopes(undefined)).toEqual(['own'])
    expect(normalizeDeviceScopes([])).toEqual(['own'])
  })

  it('passes a clean single-scope array through untouched', () => {
    expect(normalizeDeviceScopes(['own'])).toEqual(['own'])
    expect(normalizeDeviceScopes(['all'])).toEqual(['all'])
    expect(normalizeDeviceScopes([{ kind: 'hash', machineHash: 'abc' }])).toEqual([
      { kind: 'hash', machineHash: 'abc' },
    ])
  })

  it("collapses to ['all'] when 'all' rides alongside other scopes", () => {
    // 'all' is meant as an exclusive aggregate — anything else picked
    // alongside it would mean "all + a strict subset of all", which is
    // confusing in both UI and chart terms.
    expect(normalizeDeviceScopes(['own', 'all'])).toEqual(['all'])
    expect(normalizeDeviceScopes(['all', 'own'])).toEqual(['all'])
    expect(
      normalizeDeviceScopes(['all', { kind: 'hash', machineHash: 'abc' }]),
    ).toEqual(['all'])
  })

  it('dedupes by select-value identity', () => {
    expect(normalizeDeviceScopes(['own', 'own'])).toEqual(['own'])
    expect(
      normalizeDeviceScopes([
        { kind: 'hash', machineHash: 'abc' },
        { kind: 'hash', machineHash: 'abc' },
      ]),
    ).toEqual([{ kind: 'hash', machineHash: 'abc' }])
  })

  it('caps the array at MAX_DEVICE_SCOPES dropping the tail', () => {
    expect(MAX_DEVICE_SCOPES).toBe(2)
    expect(
      normalizeDeviceScopes([
        'own',
        { kind: 'hash', machineHash: 'a' },
        { kind: 'hash', machineHash: 'b' },
      ]),
    ).toEqual(['own', { kind: 'hash', machineHash: 'a' }])
  })
})
