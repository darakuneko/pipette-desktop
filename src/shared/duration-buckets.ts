// SPDX-License-Identifier: GPL-2.0-or-later
// Keypress-duration histogram grid, shared between the main-process
// bucketizer (bigram-bucket.ts) and every renderer surface that needs
// to label or re-derive stats from the same buckets (Analyze's
// duration distribution chart, the Heatmap duration mode, and their
// CSV exports) — one array pair so none of those can drift from the
// grid the data was actually bucketized against.

/** Exclusive upper bounds of each keypress-duration histogram bucket, in
 * ms. Deliberately a much tighter grid than the bigram IKI grid
 * (bigram-bucket.ts's BIGRAM_BUCKET_UPPER_BOUNDS_MS): the CHI 2018
 * typing-behaviour literature this project's benchmarks are modeled on
 * (see `typing-benchmarks.ts`) puts typical keypress durations in the
 * 80-150 ms range — an order of magnitude narrower than inter-key
 * intervals, which range from sub-60ms rolls to multi-second pauses.
 * Reusing the IKI grid here would collapse almost every real duration
 * sample into the first one or two buckets. */
export const DURATION_BUCKET_UPPER_BOUNDS_MS: readonly number[] = [
  50,
  80,
  110,
  140,
  180,
  250,
  400,
  Number.POSITIVE_INFINITY,
] as const

/** Estimated bucket centers (ms) for the duration grid above — same
 * midpoint-of-closed-bucket / synthetic-center-for-the-open-bucket
 * convention as BIGRAM_BUCKET_CENTERS_MS. NOT consumed by the live
 * duration UI: the histogram axis labels come from the translated
 * `analyze.duration.bin.*` i18n keys (index-aligned via
 * DURATION_BUCKET_BIN_IDS in analyze-duration.ts) and the Heatmap
 * duration-mode ranking works from the raw per-cell
 * `sum`/`durationSamples` (a true mean, not a bucket-midpoint estimate)
 * — see buildDurationRanking. This array's one consumer is the
 * `center_ms` column of the duration-distribution CSV export
 * (buildDurationDistributionCsv in analyze-csv-builders.ts), which has
 * no per-row raw mean to fall back on (a CSV row is a bucket, not a
 * cell) and so reports the bucket-midpoint estimate instead. */
export const DURATION_BUCKET_CENTERS_MS: readonly number[] = [
  25,   // bucket 0: < 50
  65,   // bucket 1: 50-80
  95,   // bucket 2: 80-110
  125,  // bucket 3: 110-140
  160,  // bucket 4: 140-180
  215,  // bucket 5: 180-250
  325,  // bucket 6: 250-400
  600,  // bucket 7: >= 400 (long-hold estimate)
] as const

/** Lower (inclusive) bound of bucket `i` — the previous bucket's upper
 * bound, or 0 for the first bucket. Companion to
 * `DURATION_BUCKET_UPPER_BOUNDS_MS` for callers that need a bucket's
 * full `[lo, hi)` span rather than just its upper edge (e.g. the
 * TAPPING_TERM advisor's percentile ranges in
 * `analyze-tapping-term.ts`). */
export function durationBucketLowerBoundMs(bucketIndex: number): number {
  return bucketIndex === 0 ? 0 : DURATION_BUCKET_UPPER_BOUNDS_MS[bucketIndex - 1]
}

/** Synthetic upper bound for the open-ended top bucket (>= 400ms),
 * derived symmetrically around `DURATION_BUCKET_CENTERS_MS`'s synthetic
 * center for that bucket (center = midpoint of `[lo, hi)`, so
 * `hi = 2*center - lo`). The bucket's true upper bound is unbounded —
 * this value is only meaningful for display purposes (a percentile
 * range's `hi` edge, a chart's synthetic span), never for classifying
 * a duration against the bucket. */
export const DURATION_BUCKET_SYNTHETIC_TOP_UPPER_MS =
  2 * DURATION_BUCKET_CENTERS_MS[7] - DURATION_BUCKET_UPPER_BOUNDS_MS[6]
