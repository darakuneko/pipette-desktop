// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { isUtcDay, utcDayBoundaryMs, utcDayFromMs } from '../utc-day'

describe('utcDayFromMs', () => {
  it('converts epoch zero to the Unix day', () => {
    expect(utcDayFromMs(0)).toBe('1970-01-01')
  })

  it('stays on the day at 23:59:59.999 UTC and flips at the next ms', () => {
    const lastMsOfDay = Date.UTC(2026, 3, 19, 23, 59, 59, 999)
    expect(utcDayFromMs(lastMsOfDay)).toBe('2026-04-19')
    expect(utcDayFromMs(lastMsOfDay + 1)).toBe('2026-04-20')
  })

  it('starts the new day at 00:00:00.000 UTC', () => {
    expect(utcDayFromMs(Date.UTC(2026, 3, 20, 0, 0, 0, 0))).toBe('2026-04-20')
  })

  it('pads single-digit months and days', () => {
    expect(utcDayFromMs(Date.UTC(2026, 0, 3, 12))).toBe('2026-01-03')
  })
})

describe('isUtcDay', () => {
  it('accepts the canonical ISO form', () => {
    expect(isUtcDay('2026-04-19')).toBe(true)
  })

  it('rejects the wrong shape', () => {
    expect(isUtcDay('2026-4-19')).toBe(false)
    expect(isUtcDay('20260419')).toBe(false)
    expect(isUtcDay('abcd-ef-gh')).toBe(false)
    expect(isUtcDay('')).toBe(false)
  })

  it('rejects calendar-invalid days even when the shape matches', () => {
    expect(isUtcDay('2026-02-29')).toBe(false) // 2026 is not a leap year
    expect(isUtcDay('2026-13-01')).toBe(false)
    expect(isUtcDay('2026-00-15')).toBe(false)
    expect(isUtcDay('2026-04-31')).toBe(false)
  })

  it('accepts leap days on leap years', () => {
    expect(isUtcDay('2024-02-29')).toBe(true)
  })
})

describe('utcDayBoundaryMs', () => {
  it('returns a 24h half-open range for a valid day', () => {
    const { startMs, endMs } = utcDayBoundaryMs('2026-04-19')
    expect(startMs).toBe(Date.UTC(2026, 3, 19, 0, 0, 0, 0))
    expect(endMs).toBe(Date.UTC(2026, 3, 20, 0, 0, 0, 0))
    expect(endMs - startMs).toBe(86_400_000)
  })

  it('treats endMs as exclusive — the next day starts at endMs', () => {
    const { endMs } = utcDayBoundaryMs('2026-04-19')
    expect(utcDayFromMs(endMs)).toBe('2026-04-20')
    expect(utcDayFromMs(endMs - 1)).toBe('2026-04-19')
  })

  it('throws RangeError for malformed input', () => {
    expect(() => utcDayBoundaryMs('abcd-ef-gh')).toThrow(RangeError)
    expect(() => utcDayBoundaryMs('2026-4-19')).toThrow(RangeError)
    expect(() => utcDayBoundaryMs('')).toThrow(RangeError)
  })

  it('throws RangeError for calendar-invalid dates', () => {
    expect(() => utcDayBoundaryMs('2026-02-29')).toThrow(RangeError)
    expect(() => utcDayBoundaryMs('2026-13-01')).toThrow(RangeError)
    expect(() => utcDayBoundaryMs('2026-04-31')).toThrow(RangeError)
  })
})
