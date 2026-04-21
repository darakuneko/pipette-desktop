// SPDX-License-Identifier: GPL-2.0-or-later
// Client-side keystroke-interval histogram for the Analyze > Interval
// Distribution mode. We only persist per-minute quartiles (min / p25 /
// p50 / p75 / max); reconstructing the exact per-interval distribution
// is not possible, so we treat each minute as four independent samples
// at `min`, `p25`, `p50`, `p75` with equal weight `keystrokes / 4`.
//
// `max` is intentionally excluded from the histogram because it picks
// up idle-time outliers that would skew the tail bucket; it is surfaced
// separately as the "longest pause" summary metric.
//
// Limitations (acknowledged by design):
// - Minute is the smallest unit of observation, so short ranges (tens
//   of minutes) show a discrete feel — over thousands of minutes the
//   shape stabilises by the law of large numbers.
// - `keystrokes` counts key presses in a minute; strictly the interval
//   count is `keystrokes - 1` per session, but the off-by-one washes
//   out at the scale this chart is meant for.

import type { TypingMinuteStatsRow } from '../../../shared/types/typing-analytics'
import { findBucketIndex, weightedMedian, type WeightedSample } from './analyze-format'
import type { RangeMs } from './analyze-types'

/** Rhythm band — coarser bucketing of `IntervalHistogramBin` for the
 * summary figures and chart colouring. Bin edges were chosen so every
 * band's boundary lines up with an `IntervalHistogramBin` edge below. */
export type RhythmBandId = 'fast' | 'normal' | 'slow' | 'pause'

interface RhythmBandDef {
  id: RhythmBandId
  /** Intervals strictly below this value fall into this band. The last
   * band uses `+Infinity` as the upper sentinel so callers never have
   * to special-case it. */
  maxMs: number
}

/** Single source of truth for the 200 / 500 / 2 000 ms band splits. */
export const RHYTHM_BANDS: readonly RhythmBandDef[] = [
  { id: 'fast',   maxMs: 200 },
  { id: 'normal', maxMs: 500 },
  { id: 'slow',   maxMs: 2_000 },
  { id: 'pause',  maxMs: Number.POSITIVE_INFINITY },
]

/** Which rhythm band an interval belongs to. Used both for bin colours
 * and for share aggregation. */
export function rhythmBandForMs(ms: number): RhythmBandId {
  for (const b of RHYTHM_BANDS) {
    if (ms < b.maxMs) return b.id
  }
  return 'pause'
}

/** Interval histogram bucket. `toMs` is exclusive except for the top
 * bucket which catches everything above `fromMs`. `share` is already
 * divided by the total weight so consumers don't repeat the division
 * in hot render paths. */
export interface IntervalHistogramBin {
  id: string
  fromMs: number
  /** `null` for the top bucket ("anything above fromMs"). */
  toMs: number | null
  weight: number
  share: number
  band: RhythmBandId
}

/** Keys recognised by the i18n layer — must stay in sync with the
 * `analyze.interval.bin.<key>` labels in every locale file. */
export const HISTOGRAM_BIN_IDS = [
  'lt50', '50to100', '100to200', '200to500',
  '500to1000', '1000to2000', '2000to5000', '5000to10000', 'gt10000',
] as const

type BinId = (typeof HISTOGRAM_BIN_IDS)[number]

interface BinDef {
  id: BinId
  fromMs: number
  toMs: number | null
}

const BINS: readonly BinDef[] = [
  { id: 'lt50',        fromMs: 0,     toMs: 50 },
  { id: '50to100',     fromMs: 50,    toMs: 100 },
  { id: '100to200',    fromMs: 100,   toMs: 200 },
  { id: '200to500',    fromMs: 200,   toMs: 500 },
  { id: '500to1000',   fromMs: 500,   toMs: 1000 },
  { id: '1000to2000',  fromMs: 1000,  toMs: 2000 },
  { id: '2000to5000',  fromMs: 2000,  toMs: 5000 },
  { id: '5000to10000', fromMs: 5000,  toMs: 10000 },
  { id: 'gt10000',     fromMs: 10000, toMs: null },
]

/** Bin index for a given interval (ms). The bottom bin catches 0 /
 * negative values; the top bin catches everything `>= 10000 ms`. */
export function findBinIndex(ms: number): number {
  return findBucketIndex(BINS, ms)
}

/** Summary of typical-rhythm metrics computed alongside the histogram.
 * All interval figures are in ms; share figures are fractions in [0, 1]. */
export interface IntervalRhythmSummary {
  /** Sum of `keystrokes` across every contributing minute. */
  totalKeystrokes: number
  /** Keystroke-weighted median of per-minute `intervalP50Ms`. `null`
   * when no minute contributed. The `weighted` prefix avoids ambiguity
   * with an unweighted median of the minute-level p50 samples. */
  weightedMedianP50Ms: number | null
  /** Share of histogram weight sitting at `< 200 ms`. */
  fastShare: number
  /** `[200, 500) ms`. */
  normalShare: number
  /** `[500, 2000) ms`. */
  slowShare: number
  /** `>= 2000 ms`. */
  pauseShare: number
  /** Maximum of `intervalMaxMs` across contributing minutes. `null`
   * when no minute recorded an interval. */
  longestPauseMs: number | null
}

export interface IntervalHistogramResult {
  bins: IntervalHistogramBin[]
  /** Sum of every bin weight. Kept for callers that want raw counts. */
  totalWeight: number
  summary: IntervalRhythmSummary
}

/** Build a keystroke-interval histogram (plus summary metrics) from
 * per-minute quartile rows, restricted to `range`. */
export function buildIntervalHistogram(
  rows: readonly TypingMinuteStatsRow[],
  range: RangeMs,
): IntervalHistogramResult {
  const weights = new Array<number>(BINS.length).fill(0)
  let totalKeystrokes = 0
  let longestPauseMs: number | null = null
  const p50Samples: WeightedSample[] = []

  for (const r of rows) {
    if (r.minuteMs < range.fromMs || r.minuteMs >= range.toMs) continue
    if (r.keystrokes <= 1) continue
    const quartiles = [r.intervalMinMs, r.intervalP25Ms, r.intervalP50Ms, r.intervalP75Ms]
    // Require at least one quartile for the minute to contribute; a row
    // with a stray null still contributes the non-null quartiles at the
    // reduced weight that `keystrokes / 4` implies.
    if (quartiles.every((v) => v === null)) continue

    totalKeystrokes += r.keystrokes
    const perSample = r.keystrokes / 4
    for (const q of quartiles) {
      if (q === null) continue
      weights[findBinIndex(q)] += perSample
    }
    if (r.intervalP50Ms !== null) {
      p50Samples.push({ value: r.intervalP50Ms, weight: r.keystrokes })
    }
    if (r.intervalMaxMs !== null) {
      longestPauseMs = longestPauseMs === null
        ? r.intervalMaxMs
        : Math.max(longestPauseMs, r.intervalMaxMs)
    }
  }

  const totalWeight = weights.reduce((a, b) => a + b, 0)
  const bandWeights: Record<RhythmBandId, number> = { fast: 0, normal: 0, slow: 0, pause: 0 }
  const bins: IntervalHistogramBin[] = BINS.map((def, i) => {
    const band = rhythmBandForMs(def.fromMs)
    const weight = weights[i]
    bandWeights[band] += weight
    return {
      id: def.id,
      fromMs: def.fromMs,
      toMs: def.toMs,
      weight,
      share: totalWeight > 0 ? weight / totalWeight : 0,
      band,
    }
  })
  const toShare = (v: number): number => (totalWeight > 0 ? v / totalWeight : 0)

  return {
    bins,
    totalWeight,
    summary: {
      totalKeystrokes,
      weightedMedianP50Ms: weightedMedian(p50Samples),
      fastShare: toShare(bandWeights.fast),
      normalShare: toShare(bandWeights.normal),
      slowShare: toShare(bandWeights.slow),
      pauseShare: toShare(bandWeights.pause),
      longestPauseMs,
    },
  }
}

/** Summary numbers for the Interval tab's time-series mode. Shares /
 * band splits are distribution-specific and deliberately omitted — the
 * line chart already visualises the quartile envelope over time, so
 * the text row focuses on totals and value extremes the chart cannot
 * show at a glance. */
export interface IntervalTimeSeriesSummary {
  totalKeystrokes: number
  /** Total recorded active typing time in milliseconds. */
  activeMs: number
  /** Keystroke-weighted median of per-minute `intervalP50Ms`. */
  weightedMedianP50Ms: number | null
  /** Shortest recorded interval across every contributing minute.
   * `null` when no minute recorded an interval. */
  shortestIntervalMs: number | null
  /** Longest recorded interval across every contributing minute. */
  longestPauseMs: number | null
}

/** Summary for the time-series mode. Single-pass scan; skips the same
 * rows `buildIntervalHistogram` skips so both summaries stay
 * comparable when the user toggles the view. */
export function buildIntervalTimeSeriesSummary(
  rows: readonly TypingMinuteStatsRow[],
  range: RangeMs,
): IntervalTimeSeriesSummary {
  let totalKeystrokes = 0
  let activeMs = 0
  let shortestIntervalMs: number | null = null
  let longestPauseMs: number | null = null
  const p50Samples: WeightedSample[] = []

  for (const r of rows) {
    if (r.minuteMs < range.fromMs || r.minuteMs >= range.toMs) continue
    if (r.keystrokes <= 0) continue

    totalKeystrokes += r.keystrokes
    activeMs += Math.max(0, r.activeMs)

    if (r.intervalMinMs !== null) {
      shortestIntervalMs = shortestIntervalMs === null
        ? r.intervalMinMs
        : Math.min(shortestIntervalMs, r.intervalMinMs)
    }
    if (r.intervalMaxMs !== null) {
      longestPauseMs = longestPauseMs === null
        ? r.intervalMaxMs
        : Math.max(longestPauseMs, r.intervalMaxMs)
    }
    if (r.intervalP50Ms !== null) {
      p50Samples.push({ value: r.intervalP50Ms, weight: r.keystrokes })
    }
  }

  return {
    totalKeystrokes,
    activeMs,
    weightedMedianP50Ms: weightedMedian(p50Samples),
    shortestIntervalMs,
    longestPauseMs,
  }
}

