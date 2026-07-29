// SPDX-License-Identifier: GPL-2.0-or-later
// Client-side aggregation for the Analyze rollover section. Folds the
// per-minute {minuteTs, oc, on} rows the
// TYPING_ANALYTICS_LIST_ROLLOVER_MINUTES channel returns into an
// overall rate and a bucketed trend series. Bucket boundaries reuse
// `snapBucketStartLocal` from analyze-bucket.ts so the trend line lines
// up with the Interval chart above it, but the per-bucket value here is
// a summed ratio (Σoc/Σon), not an average/extremum of already-scalar
// stats — hence a dedicated bucketing function instead of reusing
// `bucketMinuteStats`.

import type { TypingMinuteStatsRow, TypingRolloverMinuteRow } from '../../../shared/types/typing-analytics'
import { median } from './analyze-format'
import { snapBucketStartLocal } from './analyze-bucket'
import type { RangeMs } from './analyze-types'

const HOUR_MS = 3_600_000

/** The observed-rollover-rate contract every surface in Analyze (the
 * overall stat, the trend chart's per-bucket value, the per-pair
 * ranking column, the CSV export) computes from — one canonical
 * definition instead of a restatement at each call site. `on` falsy
 * (`null`, `undefined`, or `0`) means no determined-overlap sample
 * exists for whatever this call is summing over, and collapses to
 * `null` (rendered "—"), NOT `0%`: a zero denominator carries no
 * information, so reporting 0% would claim "never overlaps" when the
 * true answer is "never measured". A real `oc === 0` with `on > 0` is
 * a genuine, valid 0% and passes through unchanged — the null/non-null
 * split is entirely on whether `on` is positive, never on `oc`. */
export function rolloverRatio(oc: number, on: number | null | undefined): number | null {
  return on ? oc / on : null
}

/** Σoc/Σon across every minute row, as a [0,1] fraction — the overall
 * observed rollover rate for the whole selection. Never poisoned by a
 * mix of contributing and non-contributing minutes — a minute that
 * didn't observe overlap is simply absent from `rows` (see the
 * channel's own doc comment), so summing what IS present is always
 * correct. */
export function overallRolloverRatio(rows: readonly TypingRolloverMinuteRow[]): number | null {
  let oc = 0
  let on = 0
  for (const r of rows) {
    oc += r.oc
    on += r.on
  }
  return rolloverRatio(oc, on)
}

export interface RolloverBucket {
  bucketStartMs: number
  /** [0,1] fraction, or null when this bucket has no observed-overlap
   * minute (a gap in the trend line, not a 0% data point). */
  ratio: number | null
}

/** Every bucket-start timestamp in `[range.fromMs, range.toMs)` at
 * `bucketMs` granularity, using the same `snapBucketStartLocal`
 * boundaries the rest of this module anchors to. Probes at a step no
 * coarser than one hour regardless of how large `bucketMs` is, so
 * calendar-irregular buckets (week / month, whose real span isn't a
 * fixed multiple of `bucketMs`) never get skipped — a naive
 * `cursor += bucketMs` advance can fail to cross into the next month
 * when the current one has 31 days (30-day `bucketMs` + 1 day still
 * snaps back to the same month). Bounded to a UI-scale iteration count
 * even for a year-long range (at most ~8,760 probes). */
function enumerateBucketStarts(range: RangeMs, bucketMs: number): number[] {
  if (bucketMs <= 0) return []
  const probeStep = Math.min(bucketMs, HOUR_MS)
  const starts: number[] = []
  let lastBucket: number | null = null
  for (let ms = range.fromMs; ms < range.toMs; ms += probeStep) {
    const bucketStart = snapBucketStartLocal(ms, bucketMs)
    if (bucketStart !== lastBucket) {
      starts.push(bucketStart)
      lastBucket = bucketStart
    }
  }
  return starts
}

/** Group per-minute rollover rows into `bucketMs`-wide buckets anchored
 * at the same local-time boundaries `bucketMinuteStats` uses. Every
 * bucket position in the display range is represented in the result —
 * even ones with zero contributing minutes (`ratio: null`) — so the
 * trend chart sees an explicit null point between two observed buckets
 * instead of silently connecting a line across the gap: a `Line` with
 * `connectNulls={false}` only breaks at points that ARE present in its
 * data array, so a bucket simply missing from a sparse array draws a
 * straight line to whatever the next present point is, regardless of
 * how much time it actually skips. `rows` never contains a minute with
 * `on: 0` (see {@link TypingRolloverMinuteRow}'s doc comment: an
 * unobserved minute is absent from the input entirely), so a bucket
 * with no matching row is unambiguously "no data", not "observed 0%". */
export function bucketRolloverMinutes(
  rows: readonly TypingRolloverMinuteRow[],
  range: RangeMs,
  bucketMs: number,
): RolloverBucket[] {
  if (bucketMs <= 0) return []
  const sums = new Map<number, { oc: number; on: number }>()
  for (const r of rows) {
    if (r.minuteTs < range.fromMs || r.minuteTs >= range.toMs) continue
    const bucketStart = snapBucketStartLocal(r.minuteTs, bucketMs)
    let entry = sums.get(bucketStart)
    if (!entry) {
      entry = { oc: 0, on: 0 }
      sums.set(bucketStart, entry)
    }
    entry.oc += r.oc
    entry.on += r.on
  }
  return enumerateBucketStarts(range, bucketMs).map((bucketStartMs) => {
    const entry = sums.get(bucketStartMs)
    return { bucketStartMs, ratio: entry ? rolloverRatio(entry.oc, entry.on) : null }
  })
}

/** The "effective sampling period" figures shown alongside the
 * rollover rate: the median of each minute's own p50 poll gap, and the
 * worst (max) of each minute's own p95 poll gap. Deliberately
 * different reductions for the two — median smooths outlier minutes
 * for the "typical" figure, while a single bad minute is exactly what
 * the "worst case" p95 figure is meant to surface (a user checking "how
 * much am I under-detecting" cares about the worst period they hit,
 * not its average). Rows with no poll-gap sample that minute
 * (`pollP50Ms`/`pollP95Ms` null or absent) are skipped rather than
 * treated as 0. */
export interface EffectiveSamplingPeriod {
  medianP50Ms: number | null
  worstP95Ms: number | null
}

export function effectiveSamplingPeriod(rows: readonly TypingMinuteStatsRow[]): EffectiveSamplingPeriod {
  const p50s: number[] = []
  let worstP95: number | null = null
  for (const r of rows) {
    if (typeof r.pollP50Ms === 'number' && Number.isFinite(r.pollP50Ms)) p50s.push(r.pollP50Ms)
    if (typeof r.pollP95Ms === 'number' && Number.isFinite(r.pollP95Ms)) {
      worstP95 = worstP95 === null ? r.pollP95Ms : Math.max(worstP95, r.pollP95Ms)
    }
  }
  return { medianP50Ms: median(p50s), worstP95Ms: worstP95 }
}

/** Tooltip cell text for the rollover trend chart's y-value: `'12.3%'`
 * for a finite number, `'—'` for anything else. Extracted as its own
 * function (rather than inlined in the chart's `formatter` prop) so
 * the null case is pinned by a test: naively doing `Number(value)` on
 * a gap point's `null` coerces to `0` (`Number(null) === 0`), which
 * `Number.isFinite` accepts, silently rendering a fabricated "0.0%"
 * for a bucket that was never observed instead of "—". */
export function formatRolloverTooltipValue(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${value.toFixed(1)}%`
}
