// SPDX-License-Identifier: GPL-2.0-or-later
// The time zones the local-time fixtures are recorded in, one generator
// process each (run-time-zones.ts): a zone without daylight saving time,
// one east of UTC, one changing its clocks at 02:00, one whose clocks jump
// over local midnight, and one whose local midnight happens twice.

export const FIXTURE_TIME_ZONES = [
  'UTC',
  'Asia/Tokyo',
  'America/New_York',
  'America/Santiago',
  'America/Havana',
] as const

/** Set by run-time-zones.ts to the zone a generator process records. */
export const FIXTURE_TIME_ZONE_VAR = 'PIPETTE_FIXTURE_TIME_ZONE'

/** The fixture file name part of `zone`: `America/New_York` →
 *  `america-new_york`. */
export function zoneSlug(zone: string): string {
  return zone.toLowerCase().replaceAll('/', '-')
}

/** The zone this generator process records in; fails unless the process
 *  runs in it. */
export function recordingTimeZone(): string {
  const zone = process.env[FIXTURE_TIME_ZONE_VAR]
  if (!zone) throw new Error(`${FIXTURE_TIME_ZONE_VAR} is not set; run pnpm run generate:analytics-db-fixtures`)
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (process.env.TZ !== zone || resolved !== zone) {
    throw new Error(`recording ${zone} but TZ is ${String(process.env.TZ)} and the resolved zone ${resolved}`)
  }
  return zone
}
