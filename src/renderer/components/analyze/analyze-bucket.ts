// SPDX-License-Identifier: GPL-2.0-or-later
// Client-side bucketing for the Analyze WPM / Interval charts. The
// main process returns minute-raw rows; the renderer picks a bucket
// width based on the selected datetime range so the chart keeps a
// readable number of points regardless of zoom level.
//
// The bucket size is snapped to a small table of "clean" granularities
// (1min / 5min / 10min / ... / 1 month) so the axis ticks land on
// round local times (`:00`, `:10`, ...) rather than arbitrary offsets.

import type { TypingMinuteStatsRow } from '../../../shared/types/typing-analytics'
import type { RangeMs } from './analyze-types'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000
export const WEEK_MS = DAY_MS * 7
// Month approximated at 30 days — exact calendar months are snapped in
// `snapBucketStartLocal` so this value only drives the chooser /
// period-width sentinels. Importers passing it to `snapBucketStartLocal`
// get calendar 1st-of-month snapping regardless of the 30-day duration.
export const MONTH_MS = DAY_MS * 30

/** Ordered list of bucket widths (ms) we accept. The chooser picks
 * the entry closest to `range_span / target_points`. The values cover
 * 1 minute up to roughly a month; anything longer clamps to the top. */
export const GRANULARITIES: readonly number[] = [
  MINUTE_MS,                // 1 min
  MINUTE_MS * 5,            // 5 min
  MINUTE_MS * 10,           // 10 min
  MINUTE_MS * 15,           // 15 min
  MINUTE_MS * 30,           // 30 min
  HOUR_MS,                  // 1 h
  HOUR_MS * 3,              // 3 h
  HOUR_MS * 6,              // 6 h
  HOUR_MS * 12,             // 12 h
  DAY_MS,                   // 1 day
  DAY_MS * 3,               // 3 day
  WEEK_MS,                  // 1 week
  MONTH_MS,                 // 1 month
]

export interface BucketedMinuteStats {
  bucketStartMs: number
  keystrokes: number
  activeMs: number
  intervalMinMs: number | null
  intervalP25Ms: number | null
  intervalP50Ms: number | null
  intervalP75Ms: number | null
  intervalMaxMs: number | null
}

/** Pick the granularity closest to `span / targetPoints` — 40 points
 * sits in the 30–60 sweet-spot from the spec (readable without looking
 * noisy). Ties resolve toward the coarser bucket because that keeps
 * low-sample noise under control. */
export function pickBucketMs(range: RangeMs, targetPoints = 40): number {
  const span = Math.max(MINUTE_MS, range.toMs - range.fromMs)
  const raw = Math.ceil(span / Math.max(1, targetPoints))
  let best = GRANULARITIES[0]
  let bestDiff = Math.abs(raw - best)
  for (const g of GRANULARITIES) {
    const diff = Math.abs(raw - g)
    if (diff < bestDiff || (diff === bestDiff && g > best)) {
      best = g
      bestDiff = diff
    }
  }
  return best
}

/** Snap `ms` to the local-time start of its `bucketMs` bucket. Keeps
 * minute-scale buckets aligned to `:00/:10/…`, day buckets to local
 * midnight, 3-day/week buckets to a consistent anchor, and month
 * buckets to the 1st-of-month. Using local boundaries matches the
 * user's wall-clock expectation (matches the `strftime('…','localtime')`
 * aggregation elsewhere in the service). */
export function snapBucketStartLocal(ms: number, bucketMs: number): number {
  const d = new Date(ms)
  if (bucketMs < DAY_MS) {
    const minutesOfDay = d.getHours() * 60 + d.getMinutes()
    const bucketMin = Math.max(1, Math.round(bucketMs / MINUTE_MS))
    const snappedMin = Math.floor(minutesOfDay / bucketMin) * bucketMin
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, snappedMin, 0, 0).getTime()
  }
  if (bucketMs === DAY_MS) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  if (bucketMs === DAY_MS * 3) {
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const dayIndex = Math.floor(dayStart / DAY_MS)
    return (dayIndex - (dayIndex % 3)) * DAY_MS
  }
  if (bucketMs === WEEK_MS) {
    // Monday anchor — getDay() = 0 (Sun) … 6 (Sat)
    const offsetDays = (d.getDay() + 6) % 7
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offsetDays).getTime()
  }
  if (bucketMs === MONTH_MS) {
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  }
  // Uncommon bucket width: fall back to epoch-relative snap.
  return Math.floor(ms / bucketMs) * bucketMs
}

/** Group minute-raw rows into `bucketMs`-wide buckets anchored at
 * local-time boundaries. Interval quartiles fold with an unweighted
 * mean (matching the day aggregate's semantics); min/max track the
 * envelope; keystrokes/activeMs sum. Buckets with no contributing
 * rows are omitted. */
export function bucketMinuteStats(
  rows: readonly TypingMinuteStatsRow[],
  range: RangeMs,
  bucketMs: number,
): BucketedMinuteStats[] {
  if (bucketMs <= 0) return []
  const buckets = new Map<number, {
    keystrokes: number
    activeMs: number
    min: number | null
    max: number | null
    p25Sum: number; p25Count: number
    p50Sum: number; p50Count: number
    p75Sum: number; p75Count: number
  }>()
  for (const r of rows) {
    if (r.minuteMs < range.fromMs || r.minuteMs >= range.toMs) continue
    const bucketStart = snapBucketStartLocal(r.minuteMs, bucketMs)
    let entry = buckets.get(bucketStart)
    if (!entry) {
      entry = {
        keystrokes: 0, activeMs: 0,
        min: null, max: null,
        p25Sum: 0, p25Count: 0,
        p50Sum: 0, p50Count: 0,
        p75Sum: 0, p75Count: 0,
      }
      buckets.set(bucketStart, entry)
    }
    entry.keystrokes += r.keystrokes
    entry.activeMs += r.activeMs
    if (r.intervalMinMs !== null) {
      entry.min = entry.min === null ? r.intervalMinMs : Math.min(entry.min, r.intervalMinMs)
    }
    if (r.intervalMaxMs !== null) {
      entry.max = entry.max === null ? r.intervalMaxMs : Math.max(entry.max, r.intervalMaxMs)
    }
    if (r.intervalP25Ms !== null) { entry.p25Sum += r.intervalP25Ms; entry.p25Count += 1 }
    if (r.intervalP50Ms !== null) { entry.p50Sum += r.intervalP50Ms; entry.p50Count += 1 }
    if (r.intervalP75Ms !== null) { entry.p75Sum += r.intervalP75Ms; entry.p75Count += 1 }
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([bucketStartMs, e]) => ({
      bucketStartMs,
      keystrokes: e.keystrokes,
      activeMs: e.activeMs,
      intervalMinMs: e.min,
      intervalMaxMs: e.max,
      intervalP25Ms: e.p25Count > 0 ? e.p25Sum / e.p25Count : null,
      intervalP50Ms: e.p50Count > 0 ? e.p50Sum / e.p50Count : null,
      intervalP75Ms: e.p75Count > 0 ? e.p75Sum / e.p75Count : null,
    }))
}
