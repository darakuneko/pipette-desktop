// SPDX-License-Identifier: GPL-2.0-or-later
// Time zone label for the Data modal's typing day rows. The rows are local
// calendar days of this PC (the main process groups them with SQLite's
// 'localtime', which follows the same OS time zone as this renderer), so
// the label names that zone: the IANA name and the GMT offset, e.g.
// `Asia/Tokyo GMT+9`, `Asia/Kolkata GMT+5:30`, or just `UTC`.

import { localDayRangeMs } from '../../../shared/local-day-range'

const UTC_ZONE_NAMES: ReadonlySet<string> = new Set(['UTC', 'Etc/UTC', 'Etc/Universal', 'Etc/Zulu', 'Universal', 'Zulu'])

/** Start (epoch ms) of the local calendar day `date` (`YYYY-MM-DD`), or
 * null for anything else; the same day range the main process deletes. */
export function localDayStartMs(date: string): number | null {
  return localDayRangeMs(date)?.startMs ?? null
}

function gmtOffset(atMs: number): string {
  const minutes = -new Date(atMs).getTimezoneOffset()
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return m === 0 ? `GMT${sign}${h}` : `GMT${sign}${h}:${String(m).padStart(2, '0')}`
}

/** The local time zone at `atMs`, with the offset in effect at that moment
 * (so the start of a day before a DST change shows the offset before it). */
export function localTimeZoneLabel(atMs: number): string {
  let name: string | undefined
  try {
    name = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    name = undefined
  }
  if (name && UTC_ZONE_NAMES.has(name)) return 'UTC'
  const offset = gmtOffset(atMs)
  return name ? `${name} ${offset}` : offset
}
