// SPDX-License-Identifier: GPL-2.0-or-later
// UTC calendar-day helpers shared by the per-day JSONL master files and
// their downstream callers. A `UtcDay` is always the ISO 8601 form
// `YYYY-MM-DD`, reflecting an actual Gregorian day: February 30th or a
// 13th month both get rejected. Timestamps are in epoch milliseconds
// and boundaries are computed purely in UTC so every device agrees on
// the same day regardless of local timezone.

export type UtcDay = string

export const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const MS_PER_DAY = 86_400_000

/** Return the UTC calendar day for an epoch-ms timestamp. */
export function utcDayFromMs(ms: number): UtcDay {
  const d = new Date(ms)
  const y = d.getUTCFullYear().toString().padStart(4, '0')
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const day = d.getUTCDate().toString().padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Parse a UTC-day string to its epoch-ms start, or `null` when the
 * input is shape-invalid or names a non-existent Gregorian day. Shared
 * by `isUtcDay` and `utcDayBoundaryMs` so the round-trip validation
 * happens exactly once. */
function parseUtcDayToStartMs(s: string): number | null {
  if (!UTC_DAY_PATTERN.test(s)) return null
  const y = Number(s.slice(0, 4))
  const m = Number(s.slice(5, 7))
  const d = Number(s.slice(8, 10))
  const startMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0)
  return utcDayFromMs(startMs) === s ? startMs : null
}

/** True when `s` matches the `YYYY-MM-DD` shape AND names a real
 * Gregorian day. `2026-02-29` and `2026-13-01` both return false. */
export function isUtcDay(s: string): boolean {
  return parseUtcDayToStartMs(s) !== null
}

/** Half-open `[startMs, endMs)` range covering a single UTC day.
 * Throws `RangeError` when the input is not a valid ISO UTC-day. */
export function utcDayBoundaryMs(utcDay: UtcDay): { startMs: number; endMs: number } {
  const startMs = parseUtcDayToStartMs(utcDay)
  if (startMs === null) throw new RangeError(`Invalid UTC day: ${utcDay}`)
  return { startMs, endMs: startMs + MS_PER_DAY }
}
