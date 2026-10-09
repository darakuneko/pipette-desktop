// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, afterEach } from 'vitest'
import { localDayStartMs, localTimeZoneLabel } from '../typing-time-zone-label'

describe('localTimeZoneLabel', () => {
  const originalTz = process.env.TZ
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
  })

  function labelForDay(tz: string, date: string): string {
    process.env.TZ = tz
    const start = localDayStartMs(date)
    if (start === null) throw new Error(`bad date ${date}`)
    return localTimeZoneLabel(start)
  }

  it('names the IANA zone and the GMT offset', () => {
    expect(labelForDay('Asia/Tokyo', '2026-10-09')).toBe('Asia/Tokyo GMT+9')
  })

  it('uses the offset at the start of the day, across summer time', () => {
    expect(labelForDay('America/New_York', '2026-01-15')).toBe('America/New_York GMT-5')
    expect(labelForDay('America/New_York', '2026-07-15')).toBe('America/New_York GMT-4')
    // Summer time starts at 02:00 on 2026-03-08; the day starts at GMT-5.
    expect(labelForDay('America/New_York', '2026-03-08')).toBe('America/New_York GMT-5')
    expect(labelForDay('America/New_York', '2026-03-09')).toBe('America/New_York GMT-4')
  })

  it('shows minutes of a non-whole-hour offset', () => {
    // The name is the one Intl reports, which can be an older alias.
    expect(labelForDay('Asia/Kathmandu', '2026-10-09')).toMatch(/^Asia\/Kat\w+ GMT\+5:45$/)
  })

  it('shows plain UTC for UTC', () => {
    expect(labelForDay('UTC', '2026-10-09')).toBe('UTC')
    expect(labelForDay('Etc/UTC', '2026-10-09')).toBe('UTC')
  })

  it('shows GMT+0 for a zone at offset zero that is not UTC', () => {
    expect(labelForDay('Europe/London', '2026-01-15')).toBe('Europe/London GMT+0')
  })
})

describe('localDayStartMs', () => {
  it('returns local midnight, null for anything that is not a date', () => {
    process.env.TZ = 'Asia/Tokyo'
    expect(localDayStartMs('2026-10-09')).toBe(Date.UTC(2026, 9, 8, 15))
    expect(localDayStartMs('2026-10')).toBeNull()
  })
})
