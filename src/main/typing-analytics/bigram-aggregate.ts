// SPDX-License-Identifier: GPL-2.0-or-later
// Range aggregation helpers for the Analyze Bigrams view. Pure
// functions over NgramMinuteCellRow arrays — no DB / IPC concerns.
// Histogram boundaries are imported from bigram-bucket so the merge,
// emit, and aggregation layers all share the same bucket layout.
// See .claude/plans/Plan-analyze-bigram.md for the metric design.

import {
  BIGRAM_BUCKET_CENTERS_MS,
  BIGRAM_BUCKET_UPPER_BOUNDS_MS,
} from './bigram-bucket'
import type { NgramMinuteCellRow } from './db/typing-analytics-db'
import { BIGRAM_HIST_BUCKETS } from './jsonl/jsonl-row'
import type {
  TypingBigramSlowEntry,
  TypingBigramTopEntry,
} from '../../shared/types/typing-analytics'

export interface BigramPairTotal {
  ngramId: string
  count: number
  hist: number[]
  /** Running sum / sum-of-squares of raw IKI across contributing rows.
   * Set to null the moment any contributing row lacks sum/sumSq (older
   * data written before the sum columns existed) — see
   * {@link aggregatePairTotals}. Once null, later rows for the same
   * pair are no longer added to it. */
  sumIki: number | null
  sumSqIki: number | null
}

/** Sum per-(scope, minute, pair) rows into one entry per pair id
 * (bigramId or trigramId — both project as `ngramId`, see
 * NgramMinuteCellRow). Counts add directly; histograms add
 * element-wise. Input may contain mixed ids in any order — the
 * aggregator does not assume the caller pre-grouped (the SQL ORDER BY
 * is a hint, not a requirement).
 *
 * sum/sumSq accumulate only while every row seen so far for that pair
 * has both fields populated. The moment one row is missing them (an
 * older row written before the sum columns existed), the pair's sums
 * are eagerly nulled and stay null for the rest of this call — mixing
 * a partial sum with a real one would silently understate the SD
 * instead of reporting "unknown". */
export function aggregatePairTotals(
  rows: readonly NgramMinuteCellRow[],
): Map<string, BigramPairTotal> {
  const totals = new Map<string, BigramPairTotal>()
  for (const row of rows) {
    const id = row.ngramId
    let entry = totals.get(id)
    if (!entry) {
      entry = {
        ngramId: id,
        count: 0,
        hist: new Array<number>(BIGRAM_HIST_BUCKETS).fill(0),
        sumIki: 0,
        sumSqIki: 0,
      }
      totals.set(id, entry)
    }
    entry.count += row.count
    for (let i = 0; i < BIGRAM_HIST_BUCKETS; i += 1) {
      entry.hist[i] += row.hist[i] ?? 0
    }
    if (row.sumIki === null || row.sumSqIki === null) {
      entry.sumIki = null
      entry.sumSqIki = null
    } else if (entry.sumIki !== null && entry.sumSqIki !== null) {
      entry.sumIki += row.sumIki
      entry.sumSqIki += row.sumSqIki
    }
  }
  return totals
}

/** Standard deviation of raw IKI from accumulated sum / sum-of-squares.
 * Clips the variance to 0 before the sqrt — with equally-spaced
 * keystrokes, floating-point rounding in `sumSq/n - (sum/n)^2` can go
 * very slightly negative, which would otherwise produce NaN instead of
 * the correct answer (0). Returns null when there are fewer than 2
 * samples (SD is undefined for n < 2). */
export function sdFromSums(sum: number, sumSq: number, count: number): number | null {
  if (count < 2) return null
  const mean = sum / count
  const variance = sumSq / count - mean * mean
  return Math.sqrt(Math.max(0, variance))
}

function sdFromTotal(entry: BigramPairTotal): number | null {
  if (entry.sumIki === null || entry.sumSqIki === null) return null
  return sdFromSums(entry.sumIki, entry.sumSqIki, entry.count)
}

/** Weighted-average IKI from a histogram using bucket centers. Returns
 * null when the histogram is empty or the total count is zero so the
 * caller renders "no data" instead of NaN. */
export function avgIkiFromHist(hist: readonly number[]): number | null {
  let sum = 0
  let count = 0
  for (let i = 0; i < BIGRAM_HIST_BUCKETS; i += 1) {
    const c = hist[i] ?? 0
    if (c <= 0) continue
    sum += c * BIGRAM_BUCKET_CENTERS_MS[i]
    count += c
  }
  return count > 0 ? sum / count : null
}

/** Percentile from a histogram via cumulative count + linear
 * interpolation within the matching bucket. `q` is in [0, 1]. The
 * interpolation treats each bucket as uniformly distributed across
 * [lower, upper); the slow-tail bucket uses 1000..2000 as its
 * synthesized span (matches the 1500 ms center). Returns null when
 * the histogram is empty. */
export function percentileFromHist(
  hist: readonly number[],
  q: number,
): number | null {
  let total = 0
  for (let i = 0; i < BIGRAM_HIST_BUCKETS; i += 1) total += hist[i] ?? 0
  if (total === 0) return null
  const target = q * total
  let acc = 0
  for (let i = 0; i < BIGRAM_HIST_BUCKETS; i += 1) {
    const c = hist[i] ?? 0
    if (c <= 0) continue
    if (acc + c >= target) {
      const lower = i === 0 ? 0 : BIGRAM_BUCKET_UPPER_BOUNDS_MS[i - 1]
      const upper = Number.isFinite(BIGRAM_BUCKET_UPPER_BOUNDS_MS[i])
        ? BIGRAM_BUCKET_UPPER_BOUNDS_MS[i]
        : 2 * BIGRAM_BUCKET_CENTERS_MS[i] - lower // slow-tail synthetic span
      const fraction = (target - acc) / c
      return lower + fraction * (upper - lower)
    }
    acc += c
  }
  // Unreachable: total > 0 guarantees at least one bucket triggers the
  // `acc + c >= target` branch for q in [0, 1].
  throw new Error('percentileFromHist: unreachable — total > 0 must consume target inside loop')
}

/** Aliased from the IPC contract type so the ranker output is the
 * wire shape with no copy. */
export type BigramRanked = TypingBigramTopEntry

/** Top-N pairs by occurrence count (descending). Ties broken by
 * ngramId ascending for deterministic output. */
export function rankBigramsByCount(
  totals: ReadonlyMap<string, BigramPairTotal>,
  limit: number,
): BigramRanked[] {
  const ranked = [...totals.values()]
    .sort((a, b) => (b.count - a.count) || a.ngramId.localeCompare(b.ngramId))
    .slice(0, limit)
  return ranked.map((t) => ({
    ngramId: t.ngramId,
    count: t.count,
    hist: t.hist,
    avgIki: avgIkiFromHist(t.hist),
    sd: sdFromTotal(t),
  }))
}

export type BigramSlowRanked = TypingBigramSlowEntry

/** Slowest-N pairs by avg IKI (descending). `minSample` filters out
 * pairs with fewer than N occurrences so a single late press doesn't
 * dominate the ranking. Ties broken by ngramId ascending. */
export function rankBigramsBySlow(
  totals: ReadonlyMap<string, BigramPairTotal>,
  minSample: number,
  limit: number,
): BigramSlowRanked[] {
  const eligible: { entry: BigramPairTotal; avg: number }[] = []
  for (const entry of totals.values()) {
    if (entry.count < minSample) continue
    const avg = avgIkiFromHist(entry.hist)
    if (avg === null) continue
    eligible.push({ entry, avg })
  }
  eligible.sort((a, b) => (b.avg - a.avg) || a.entry.ngramId.localeCompare(b.entry.ngramId))
  return eligible.slice(0, limit).map(({ entry, avg }) => ({
    ngramId: entry.ngramId,
    count: entry.count,
    hist: entry.hist,
    avgIki: avg,
    p95: percentileFromHist(entry.hist, 0.95),
    sd: sdFromTotal(entry),
  }))
}
