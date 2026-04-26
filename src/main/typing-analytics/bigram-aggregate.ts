// SPDX-License-Identifier: GPL-2.0-or-later
// Range aggregation helpers for the Analyze Bigrams view. Pure
// functions over BigramMinuteCellRow arrays — no DB / IPC concerns.
// Histogram boundaries are imported from bigram-bucket so the merge,
// emit, and aggregation layers all share the same bucket layout.
// See .claude/plans/Plan-analyze-bigram.md for the metric design.

import {
  BIGRAM_BUCKET_CENTERS_MS,
  BIGRAM_BUCKET_UPPER_BOUNDS_MS,
} from './bigram-bucket'
import type { BigramMinuteCellRow } from './db/typing-analytics-db'
import { BIGRAM_HIST_BUCKETS } from './jsonl/jsonl-row'
import type {
  TypingBigramSlowEntry,
  TypingBigramTopEntry,
} from '../../shared/types/typing-analytics'

export interface BigramPairTotal {
  bigramId: string
  count: number
  hist: number[]
}

/** Sum per-(scope, minute, bigram) rows into one entry per bigramId.
 * Counts add directly; histograms add element-wise. Input may contain
 * mixed bigramIds in any order — the aggregator does not assume the
 * caller pre-grouped (the SQL ORDER BY is a hint, not a requirement). */
export function aggregatePairTotals(
  rows: readonly BigramMinuteCellRow[],
): Map<string, BigramPairTotal> {
  const totals = new Map<string, BigramPairTotal>()
  for (const row of rows) {
    let entry = totals.get(row.bigramId)
    if (!entry) {
      entry = {
        bigramId: row.bigramId,
        count: 0,
        hist: new Array<number>(BIGRAM_HIST_BUCKETS).fill(0),
      }
      totals.set(row.bigramId, entry)
    }
    entry.count += row.count
    for (let i = 0; i < BIGRAM_HIST_BUCKETS; i += 1) {
      entry.hist[i] += row.hist[i] ?? 0
    }
  }
  return totals
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
 * bigramId ascending for deterministic output. */
export function rankBigramsByCount(
  totals: ReadonlyMap<string, BigramPairTotal>,
  limit: number,
): BigramRanked[] {
  const ranked = [...totals.values()]
    .sort((a, b) => (b.count - a.count) || a.bigramId.localeCompare(b.bigramId))
    .slice(0, limit)
  return ranked.map((t) => ({
    bigramId: t.bigramId,
    count: t.count,
    hist: t.hist,
    avgIki: avgIkiFromHist(t.hist),
  }))
}

export type BigramSlowRanked = TypingBigramSlowEntry

/** Slowest-N pairs by avg IKI (descending). `minSample` filters out
 * pairs with fewer than N occurrences so a single late press doesn't
 * dominate the ranking. Ties broken by bigramId ascending. */
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
  eligible.sort((a, b) => (b.avg - a.avg) || a.entry.bigramId.localeCompare(b.entry.bigramId))
  return eligible.slice(0, limit).map(({ entry, avg }) => ({
    bigramId: entry.bigramId,
    count: entry.count,
    hist: entry.hist,
    avgIki: avg,
    p95: percentileFromHist(entry.hist, 0.95),
  }))
}
