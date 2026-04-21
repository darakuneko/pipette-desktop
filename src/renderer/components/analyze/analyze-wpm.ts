// SPDX-License-Identifier: GPL-2.0-or-later
// Aggregations for the Analyze > WPM tab. Splits cleanly along two
// views:
//
//  - `buildWpmTimeSeriesSummary`: summary figures for the whole range,
//    using the same client-side buckets the line chart draws so the
//    "peak / lowest bucket" the text row reports is the same bucket
//    the user sees on the chart.
//
//  - `buildHourOfDayWpm`: hour-of-day aggregation (0 – 23 local time)
//    used by the `timeOfDay` BarChart. Hour index follows the browser
//    clock for consistency with the existing ActivityChart grid.
//
// Peak / lowest helpers gate on `minActiveMs` so a bucket or hour with
// a trivial amount of typing doesn't dominate the extremes. Buckets
// under the threshold still render in the chart — the filter only
// affects the summary row.

import type { TypingMinuteStatsRow } from '../../../shared/types/typing-analytics'
import { bucketMinuteStats, type BucketedMinuteStats } from './analyze-bucket'
import { weightedMedian, type WeightedSample } from './analyze-format'
import type { RangeMs } from './analyze-types'

/** Classic QMK/WPM formula — counts each 5 keystrokes as a word and
 * scales by active typing time (excludes idle gaps). */
export function computeWpm(keystrokes: number, activeMs: number): number {
  if (activeMs <= 0 || keystrokes <= 0) return 0
  return (keystrokes / 5) * 60_000 / activeMs
}

/** Whether a (keystrokes, activeMs, wpm) cell/bucket contributes to
 * peak / lowest WPM figures. Zero-activity cells and cells that fall
 * short of `minActiveMs` are excluded so short bursts don't hijack
 * the extremes. */
export function isWpmQualified(
  keystrokes: number,
  activeMs: number,
  wpm: number,
  minActiveMs: number,
): boolean {
  return activeMs >= minActiveMs && keystrokes > 0 && wpm > 0
}

export function formatWpm(v: number): string {
  if (!Number.isFinite(v)) return '—'
  return v.toFixed(1)
}

export interface WpmTimeSeriesSummary {
  totalKeystrokes: number
  activeMs: number
  /** Overall WPM derived from the range totals; smoother than the
   * bucket-level figures because the `keystrokes / activeMs` ratio is
   * pooled across every minute. */
  overallWpm: number
  /** Highest bucket WPM among buckets that meet `minActiveMs`. `null`
   * when no bucket qualifies. */
  peakWpm: number | null
  /** Lowest qualifying bucket WPM. `null` when no bucket qualifies. */
  lowestWpm: number | null
  /** Keystroke-weighted median of bucket WPM (qualifying buckets only).
   * `null` when no bucket qualifies. */
  weightedMedianWpm: number | null
}

export interface WpmTimeSeriesSummaryInput {
  rows: readonly TypingMinuteStatsRow[]
  range: RangeMs
  bucketMs: number
  minActiveMs: number
}

/** Convenience wrapper for callers that haven't bucketed yet. Chart
 * components that already hold a bucket array should go through
 * {@link buildWpmTimeSeriesSummaryFromBuckets} to avoid a second pass. */
export function buildWpmTimeSeriesSummary({
  rows,
  range,
  bucketMs,
  minActiveMs,
}: WpmTimeSeriesSummaryInput): WpmTimeSeriesSummary {
  return buildWpmTimeSeriesSummaryFromBuckets(
    bucketMinuteStats(rows, range, bucketMs),
    minActiveMs,
  )
}

/** Summary helper that accepts pre-bucketed data so the chart path
 * can reuse the buckets it already built for the line series. Keeps
 * the aggregator O(buckets) regardless of how many summaries we draw
 * from the same input. */
export function buildWpmTimeSeriesSummaryFromBuckets(
  buckets: readonly BucketedMinuteStats[],
  minActiveMs: number,
): WpmTimeSeriesSummary {
  let totalKeystrokes = 0
  let activeMs = 0
  const wpmSamples: WeightedSample[] = []
  let peakWpm: number | null = null
  let lowestWpm: number | null = null

  for (const b of buckets) {
    totalKeystrokes += b.keystrokes
    activeMs += Math.max(0, b.activeMs)
    if (b.activeMs < minActiveMs || b.keystrokes <= 0) continue
    const wpm = computeWpm(b.keystrokes, b.activeMs)
    if (!Number.isFinite(wpm) || wpm <= 0) continue
    wpmSamples.push({ value: wpm, weight: b.keystrokes })
    peakWpm = peakWpm === null ? wpm : Math.max(peakWpm, wpm)
    lowestWpm = lowestWpm === null ? wpm : Math.min(lowestWpm, wpm)
  }

  return {
    totalKeystrokes,
    activeMs,
    overallWpm: computeWpm(totalKeystrokes, activeMs),
    peakWpm,
    lowestWpm,
    weightedMedianWpm: weightedMedian(wpmSamples),
  }
}

/** One hour-of-day bucket for the `timeOfDay` BarChart. Always 24 of
 * these, even when a given hour saw zero activity (the chart relies on
 * every hour being present so the x-axis keeps `00..23` positions). */
export interface HourOfDayWpmBin {
  /** 0..23 local hour. */
  hour: number
  keystrokes: number
  activeMs: number
  wpm: number
  /** `true` when the bin meets `minActiveMs` and counts toward peak /
   * lowest selection. */
  qualified: boolean
}

export interface HourOfDayWpmSummary {
  totalKeystrokes: number
  activeMs: number
  overallWpm: number
  /** `null` when no hour meets `minActiveMs`. */
  peakHour: HourOfDayWpmBin | null
  lowestHour: HourOfDayWpmBin | null
  /** Count of hours with any activity (activeMs > 0), threshold-free
   * on purpose so this figure stays stable when the user changes
   * `minActiveMs`. */
  activeHours: number
}

export interface HourOfDayWpmResult {
  bins: HourOfDayWpmBin[]
  summary: HourOfDayWpmSummary
}

export interface HourOfDayWpmInput {
  rows: readonly TypingMinuteStatsRow[]
  range: RangeMs
  minActiveMs: number
}

export function buildHourOfDayWpm({
  rows,
  range,
  minActiveMs,
}: HourOfDayWpmInput): HourOfDayWpmResult {
  const keystrokesPerHour = new Array<number>(24).fill(0)
  const activeMsPerHour = new Array<number>(24).fill(0)
  let totalKeystrokes = 0
  let activeMsTotal = 0

  for (const r of rows) {
    if (r.minuteMs < range.fromMs || r.minuteMs >= range.toMs) continue
    if (r.keystrokes <= 0) continue
    const hour = new Date(r.minuteMs).getHours()
    if (hour < 0 || hour > 23) continue
    const km = Math.max(0, r.activeMs)
    keystrokesPerHour[hour] += r.keystrokes
    activeMsPerHour[hour] += km
    totalKeystrokes += r.keystrokes
    activeMsTotal += km
  }

  const bins: HourOfDayWpmBin[] = []
  for (let hour = 0; hour < 24; hour += 1) {
    const ks = keystrokesPerHour[hour]
    const ms = activeMsPerHour[hour]
    const wpm = computeWpm(ks, ms)
    const qualified = isWpmQualified(ks, ms, wpm, minActiveMs)
    bins.push({ hour, keystrokes: ks, activeMs: ms, wpm, qualified })
  }

  let peakHour: HourOfDayWpmBin | null = null
  let lowestHour: HourOfDayWpmBin | null = null
  let activeHours = 0
  for (const bin of bins) {
    if (bin.activeMs > 0) activeHours += 1
    if (!bin.qualified) continue
    if (peakHour === null || bin.wpm > peakHour.wpm) peakHour = bin
    if (lowestHour === null || bin.wpm < lowestHour.wpm) lowestHour = bin
  }

  return {
    bins,
    summary: {
      totalKeystrokes,
      activeMs: activeMsTotal,
      overallWpm: computeWpm(totalKeystrokes, activeMsTotal),
      peakHour,
      lowestHour,
      activeHours,
    },
  }
}

