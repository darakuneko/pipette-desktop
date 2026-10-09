// SPDX-License-Identifier: GPL-2.0-or-later

/** The `[startMs, endMs)` range of the local calendar day `date`
 * (`YYYY-MM-DD`), from its local midnight to the next one, so a day
 * of a DST change is 23 or 25 hours long. Matches SQLite's
 * strftime('%Y-%m-%d', ..., 'localtime') buckets, which follow the same
 * OS time zone. Null for anything that is not a date. */
export function localDayRangeMs(date: string): { startMs: number; endMs: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  const d = Number(m[3])
  const startMs = new Date(y, mo, d).getTime()
  const endMs = new Date(y, mo, d + 1).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  return { startMs, endMs }
}
