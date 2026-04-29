// SPDX-License-Identifier: GPL-2.0-or-later
// Bigram inter-key interval (IKI) bucketing. Raw IKIs are accumulated by
// MinuteBuffer and bucketized here at flush time before being persisted
// as a fixed-size histogram. The boundary set is log-scale so the slow
// tail (300ms+) is preserved without inflating storage. See
// .claude/plans/Plan-analyze-bigram.md for the bucket rationale.

import { BIGRAM_HIST_BUCKETS } from './jsonl/jsonl-row'

/** Exclusive upper bounds of each histogram bucket in ms. The final
 * bucket has implicit positive-infinity upper bound; the aggregator
 * already filters IKI greater than SESSION_IDLE_GAP_MS so the open end
 * is bounded in practice. Exported so range aggregators can derive
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
 * midpoint; the open-ended final bucket uses 1500 ms as a slow-tail
 * estimate (most >1s pairs are one-second hesitations rather than
 * multi-minute idles, since SESSION_IDLE_GAP_MS already filters those
 * upstream). Kept next to the upper-bound array so changes to either
 * stay in lockstep. */
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

function bucketIndex(iki: number): number {
  // Drive selection from the exported boundary array so downstream
  // percentile / avg derivations stay consistent if boundaries change.
  for (let i = 0; i < BIGRAM_BUCKET_UPPER_BOUNDS_MS.length; i += 1) {
    if (iki < BIGRAM_BUCKET_UPPER_BOUNDS_MS[i]) return i
  }
  return BIGRAM_HIST_BUCKETS - 1
}

/** Bucketize raw IKI values into a fixed-size histogram. Output array
 * length is always BIGRAM_HIST_BUCKETS; each entry is the count of
 * IKIs that fell into that bucket. */
export function bucketizeIki(ikis: readonly number[]): number[] {
  const buckets = new Array<number>(BIGRAM_HIST_BUCKETS).fill(0)
  for (const iki of ikis) {
    buckets[bucketIndex(iki)] += 1
  }
  return buckets
}
