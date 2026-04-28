// SPDX-License-Identifier: GPL-2.0-or-later
// Covers the DeviceScope union + serialisation helpers so the Analyze
// filter round-trip (persist → restore → IPC boundary) has a single
// specification. Works on the shared types — no renderer or main-side
// stubbing needed.

import { describe, it, expect } from 'vitest'
import {
  MAX_DEVICE_SCOPES,
  deviceScopesEqual,
  isAllScope,
  isHashScope,
  isOwnScope,
  isValidAnalyzeFilterSettings,
  normalizeDeviceScopes,
  parseDeviceScope,
  primaryDeviceScope,
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

  it('accepts a single static-scope array', () => {
    expect(isValidAnalyzeFilterSettings({ deviceScopes: ['own'] })).toBe(true)
    expect(isValidAnalyzeFilterSettings({ deviceScopes: ['all'] })).toBe(true)
  })

  it('accepts a single hash-scope array', () => {
    expect(
      isValidAnalyzeFilterSettings({
        deviceScopes: [{ kind: 'hash', machineHash: 'abc' }],
      }),
    ).toBe(true)
  })

  it('rejects two-device combinations past MAX_DEVICE_SCOPES = 1', () => {
    expect(
      isValidAnalyzeFilterSettings({
        deviceScopes: ['own', { kind: 'hash', machineHash: 'abc' }],
      }),
    ).toBe(false)
    expect(
      isValidAnalyzeFilterSettings({
        deviceScopes: [
          { kind: 'hash', machineHash: 'abc' },
          { kind: 'hash', machineHash: 'def' },
        ],
      }),
    ).toBe(false)
  })

  it('rejects unknown scope shapes inside the array', () => {
    expect(isValidAnalyzeFilterSettings({ deviceScopes: ['bogus'] })).toBe(false)
    expect(
      isValidAnalyzeFilterSettings({
        deviceScopes: [{ kind: 'hash', machineHash: '' }],
      }),
    ).toBe(false)
  })

  it('rejects empty arrays and arrays past MAX_DEVICE_SCOPES', () => {
    expect(isValidAnalyzeFilterSettings({ deviceScopes: [] })).toBe(false)
    expect(
      isValidAnalyzeFilterSettings({
        deviceScopes: [
          'own',
          { kind: 'hash', machineHash: 'a' },
          { kind: 'hash', machineHash: 'b' },
        ],
      }),
    ).toBe(false)
  })

  it("rejects 'all' combined with any other scope", () => {
    expect(
      isValidAnalyzeFilterSettings({ deviceScopes: ['all', 'own'] }),
    ).toBe(false)
    expect(
      isValidAnalyzeFilterSettings({
        deviceScopes: ['all', { kind: 'hash', machineHash: 'abc' }],
      }),
    ).toBe(false)
  })

  it('rejects duplicate scopes in the array', () => {
    expect(
      isValidAnalyzeFilterSettings({ deviceScopes: ['own', 'own'] }),
    ).toBe(false)
    expect(
      isValidAnalyzeFilterSettings({
        deviceScopes: [
          { kind: 'hash', machineHash: 'abc' },
          { kind: 'hash', machineHash: 'abc' },
        ],
      }),
    ).toBe(false)
  })

  it('rejects non-array deviceScopes (legacy single-scope shape)', () => {
    expect(isValidAnalyzeFilterSettings({ deviceScopes: 'own' })).toBe(false)
    expect(
      isValidAnalyzeFilterSettings({
        deviceScopes: { kind: 'hash', machineHash: 'abc' },
      }),
    ).toBe(false)
  })

  it('accepts a valid bigrams slot', () => {
    expect(
      isValidAnalyzeFilterSettings({
        bigrams: { topLimit: 10, slowLimit: 10 },
      }),
    ).toBe(true)
    expect(
      isValidAnalyzeFilterSettings({
        bigrams: { topLimit: 50 },
      }),
    ).toBe(true)
    expect(
      isValidAnalyzeFilterSettings({
        bigrams: { slowLimit: 25 },
      }),
    ).toBe(true)
    expect(isValidAnalyzeFilterSettings({ bigrams: {} })).toBe(true)
  })

  it('rejects bigram topLimit / slowLimit that are not positive integers', () => {
    expect(
      isValidAnalyzeFilterSettings({
        bigrams: { topLimit: 0 },
      }),
    ).toBe(false)
    expect(
      isValidAnalyzeFilterSettings({
        bigrams: { slowLimit: -5 },
      }),
    ).toBe(false)
    expect(
      isValidAnalyzeFilterSettings({
        bigrams: { topLimit: 'ten' },
      }),
    ).toBe(false)
  })

  it('accepts pairIntervalThresholdMs as a non-negative integer (0 disables)', () => {
    expect(
      isValidAnalyzeFilterSettings({ bigrams: { pairIntervalThresholdMs: 0 } }),
    ).toBe(true)
    expect(
      isValidAnalyzeFilterSettings({ bigrams: { pairIntervalThresholdMs: 200 } }),
    ).toBe(true)
  })

  it('rejects pairIntervalThresholdMs that is not a non-negative integer', () => {
    expect(
      isValidAnalyzeFilterSettings({ bigrams: { pairIntervalThresholdMs: -1 } }),
    ).toBe(false)
    expect(
      isValidAnalyzeFilterSettings({ bigrams: { pairIntervalThresholdMs: 1.5 } }),
    ).toBe(false)
    expect(
      isValidAnalyzeFilterSettings({ bigrams: { pairIntervalThresholdMs: '200' } }),
    ).toBe(false)
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
    expect(MAX_DEVICE_SCOPES).toBe(1)
    expect(
      normalizeDeviceScopes([
        'own',
        { kind: 'hash', machineHash: 'a' },
        { kind: 'hash', machineHash: 'b' },
      ]),
    ).toEqual(['own'])
  })
})

describe('primaryDeviceScope', () => {
  it('returns the first entry of a non-empty tuple', () => {
    expect(primaryDeviceScope(['own'])).toBe('own')
    expect(primaryDeviceScope(['all', 'own'])).toBe('all')
    expect(primaryDeviceScope([{ kind: 'hash', machineHash: 'abc' }])).toEqual({
      kind: 'hash',
      machineHash: 'abc',
    })
  })

  it("falls back to 'own' on empty input", () => {
    expect(primaryDeviceScope([])).toBe('own')
  })
})

describe('deviceScopesEqual', () => {
  it('treats reference-equal arrays as equal without scanning', () => {
    const a: ReturnType<typeof normalizeDeviceScopes> = ['own']
    expect(deviceScopesEqual(a, a)).toBe(true)
  })

  it('compares contents by select-value identity', () => {
    expect(deviceScopesEqual(['own'], ['own'])).toBe(true)
    expect(deviceScopesEqual(['own'], ['all'])).toBe(false)
    expect(
      deviceScopesEqual(
        [{ kind: 'hash', machineHash: 'abc' }],
        [{ kind: 'hash', machineHash: 'abc' }],
      ),
    ).toBe(true)
    expect(
      deviceScopesEqual(
        [{ kind: 'hash', machineHash: 'abc' }],
        [{ kind: 'hash', machineHash: 'def' }],
      ),
    ).toBe(false)
  })

  it('rejects arrays of different lengths even when prefixes match', () => {
    expect(
      deviceScopesEqual(['own'], ['own', { kind: 'hash', machineHash: 'a' }]),
    ).toBe(false)
  })

  it('treats order as significant (primary slot drives series colour)', () => {
    expect(
      deviceScopesEqual(
        ['own', { kind: 'hash', machineHash: 'a' }],
        [{ kind: 'hash', machineHash: 'a' }, 'own'],
      ),
    ).toBe(false)
  })
})

describe('isValidAnalyzeFilterSettings (activity view / display / calendar)', () => {
  // The calendar validator is exercised through the umbrella
  // `isValidAnalyzeFilterSettings` because it is private to the module.
  // Each case wraps a calendar payload in `{ activity: { calendar } }`
  // so we cover both the calendar guard and the activity guard's
  // delegation to it.
  it('accepts a fully populated activity payload', () => {
    expect(isValidAnalyzeFilterSettings({
      activity: {
        metric: 'wpm',
        view: 'calendar',
        calendar: {
          normalization: 'shareOfTotal',
          monthsToShow: 6,
          endMonthIso: '2026-04',
        },
      },
    })).toBe(true)
  })

  it('accepts a partial calendar payload (missing fields are optional)', () => {
    expect(isValidAnalyzeFilterSettings({ activity: { calendar: {} } })).toBe(true)
    expect(isValidAnalyzeFilterSettings({ activity: { calendar: { monthsToShow: 3 } } })).toBe(true)
    expect(isValidAnalyzeFilterSettings({ activity: { calendar: { endMonthIso: '2025-01' } } })).toBe(true)
  })

  it('rejects unknown normalization values', () => {
    expect(isValidAnalyzeFilterSettings({
      activity: { calendar: { normalization: 'nonsense' } },
    })).toBe(false)
  })

  it('rejects unknown view values', () => {
    expect(isValidAnalyzeFilterSettings({ activity: { view: 'nonsense' } })).toBe(false)
  })

  it('accepts the canonical view values', () => {
    expect(isValidAnalyzeFilterSettings({ activity: { view: 'grid' } })).toBe(true)
    expect(isValidAnalyzeFilterSettings({ activity: { view: 'calendar' } })).toBe(true)
  })

  it('rejects monthsToShow values outside the canonical ladder', () => {
    expect(isValidAnalyzeFilterSettings({ activity: { calendar: { monthsToShow: 4 } } })).toBe(false)
    expect(isValidAnalyzeFilterSettings({ activity: { calendar: { monthsToShow: 0 } } })).toBe(false)
    expect(isValidAnalyzeFilterSettings({ activity: { calendar: { monthsToShow: '6' } } })).toBe(false)
  })

  it('rejects malformed endMonthIso strings', () => {
    expect(isValidAnalyzeFilterSettings({ activity: { calendar: { endMonthIso: '2026-1' } } })).toBe(false)
    expect(isValidAnalyzeFilterSettings({ activity: { calendar: { endMonthIso: '2026/04' } } })).toBe(false)
    expect(isValidAnalyzeFilterSettings({ activity: { calendar: { endMonthIso: '2026-13' } } })).toBe(false)
    expect(isValidAnalyzeFilterSettings({ activity: { calendar: { endMonthIso: 202604 } } })).toBe(false)
  })

  it('rejects an unknown activity metric (calendar is no longer a metric)', () => {
    expect(isValidAnalyzeFilterSettings({ activity: { metric: 'calendar' } })).toBe(false)
    expect(isValidAnalyzeFilterSettings({ activity: { metric: 'nonsense' } })).toBe(false)
  })
})
