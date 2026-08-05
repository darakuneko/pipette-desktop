// SPDX-License-Identifier: GPL-2.0-or-later
// Bigram inter-key interval (IKI) bucketing. Raw IKIs are accumulated by
// MinuteBuffer and bucketized here at flush time before being persisted
// as a fixed-size histogram. The boundary set is log-scale so the slow
// tail (300ms+) is preserved without inflating storage.

import { BIGRAM_HIST_BUCKETS } from './jsonl/jsonl-row'
// The duration grid itself lives in shared/duration-buckets.ts (the
// renderer's Analyze duration UI and CSV export need it too, and main
// can't be imported from the renderer process). Only the upper-bounds
// array is needed here, for `bucketizeDurations` below — main has no
// use for the bucket centers.
import { DURATION_BUCKET_UPPER_BOUNDS_MS } from '../../shared/duration-buckets'

/** Exclusive upper bounds of each histogram bucket in ms. The final
 * bucket has implicit positive-infinity upper bound; the recorder
 * already discards any interval slower than NGRAM_MAX_IKI_MS, so the
 * open end is bounded to that ceiling in practice rather than to a
 * genuine multi-minute gap. Exported so range aggregators can derive
 * avg / median / p95 from a histogram without re-deriving the layout. */
export const BIGRAM_BUCKET_UPPER_BOUNDS_MS: readonly number[] = [
  60,
  100,
  150,
  200,
  300,
  500,
  1000,
  Number.POSITIVE_INFINITY,
] as const

/** Estimated bucket centers (ms) used to derive avg IKI / percentile
 * estimates from a packed histogram. Closed buckets use their
 * midpoint; the open-ended final bucket keeps a synthetic 1500 ms
 * center rather than reflecting its real ceiling (most >1s pairs are
 * one-second hesitations, and NGRAM_MAX_IKI_MS now bounds the
 * bucket's true contents at 5000 ms instead of the 5-minute span it
 * used to see). That synthetic center — and the POSITIVE_INFINITY
 * upper bound above — are left alone on purpose even though the real
 * ceiling tightened: giving the final bucket a genuine 5000 ms upper
 * bound would stretch the percentile interpolation span from the
 * synthetic [1000, 2000] this histogram was built against to
 * [1000, 5000], silently reshaping every percentile already derived
 * from data recorded under the old ceiling. Kept next to the
 * upper-bound array so changes to either stay in lockstep. */
export const BIGRAM_BUCKET_CENTERS_MS: readonly number[] = [
  30,    // bucket 0: < 60
  80,    // bucket 1: 60-100
  125,   // bucket 2: 100-150
  175,   // bucket 3: 150-200
  250,   // bucket 4: 200-300
  400,   // bucket 5: 300-500
  750,   // bucket 6: 500-1000
  1500,  // bucket 7: >= 1000 (slow-tail estimate)
] as const

/** Shared bucket-index lookup, generalized over any exclusive-upper-bound
 * array so the IKI and duration grids don't need their own copy of the
 * same linear scan. `bounds` must have exactly BIGRAM_HIST_BUCKETS - 1
 * meaningful entries plus a POSITIVE_INFINITY tail (both exported bound
 * arrays satisfy this) — a value that doesn't fall under any bound before
 * the last one falls into the final (catch-all) bucket. */
function bucketIndexFor(value: number, bounds: readonly number[]): number {
  for (let i = 0; i < bounds.length; i += 1) {
    if (value < bounds[i]) return i
  }
  return BIGRAM_HIST_BUCKETS - 1
}

/** Bucketize raw values into a fixed-size histogram against any grid —
 * shared by {@link bucketizeIki} and {@link bucketizeDurations} below,
 * which stay as distinctly-named one-liners so a call site reads which
 * grid it means without chasing an extra argument. */
function bucketize(values: readonly number[], bounds: readonly number[]): number[] {
  const buckets = new Array<number>(BIGRAM_HIST_BUCKETS).fill(0)
  for (const v of values) {
    buckets[bucketIndexFor(v, bounds)] += 1
  }
  return buckets
}

/** Bucketize raw IKI values into a fixed-size histogram. Output array
 * length is always BIGRAM_HIST_BUCKETS; each entry is the count of
 * IKIs that fell into that bucket. */
export function bucketizeIki(ikis: readonly number[]): number[] {
  return bucketize(ikis, BIGRAM_BUCKET_UPPER_BOUNDS_MS)
}

/** Bucketize raw keypress-duration values (ms) into a fixed-size
 * histogram using the tighter {@link DURATION_BUCKET_UPPER_BOUNDS_MS}
 * grid. Same shape/semantics as {@link bucketizeIki} otherwise. */
export function bucketizeDurations(durationsMs: readonly number[]): number[] {
  return bucketize(durationsMs, DURATION_BUCKET_UPPER_BOUNDS_MS)
}

/** Sum and sum-of-squares of raw IKI values, persisted alongside the
 * histogram so the range-aggregate layer can compute a true (non
 * histogram-approximated) standard deviation. Used for both bigram and
 * trigram emission — trigram values are already interval averages by
 * the time they reach here, so the same accumulation applies. */
export function sumAndSumSquares(values: readonly number[]): { sum: number; sumSq: number } {
  let sum = 0
  let sumSq = 0
  for (const v of values) {
    sum += v
    sumSq += v * v
  }
  return { sum, sumSq }
}
