// SPDX-License-Identifier: GPL-2.0-or-later
// Range aggregation helpers for the Analyze Bigrams view. Pure
// functions over NgramMinuteCellRow arrays — no DB / IPC concerns.
// Histogram boundaries are imported from bigram-bucket so the merge,
// emit, and aggregation layers all share the same bucket layout.

import {
  BIGRAM_BUCKET_CENTERS_MS,
  BIGRAM_BUCKET_UPPER_BOUNDS_MS,
} from './bigram-bucket'
import type { MatrixDurationCellRow, NgramMinuteCellRow } from './db/typing-analytics-db'
import { BIGRAM_HIST_BUCKETS } from './jsonl/jsonl-row'
import type {
  TypingBigramSlowEntry,
  TypingBigramTopEntry,
} from '../../shared/types/typing-analytics'
import { sdFromSums } from '../../shared/stat-sums'

// `sdFromSums` itself now lives in shared/stat-sums.ts (the renderer's
// Analyze duration section needs it too, and main can't be imported from
// the renderer process) — re-exported here so this module's own call
// sites and existing external importers don't need a second import path.
export { sdFromSums }

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
  /** Running physical-overlap accumulators (see OverlapCounts in
   * minute-buffer.ts). Deliberately NOT null-poisoned the way
   * sumIki/sumSqIki are (see {@link aggregatePairTotals}'s doc comment
   * for why that rule doesn't transfer here) — a row with no oc/on
   * (older data, or a v8 row whose events never had a determined
   * overlap, or a trigram row where the columns don't exist at all)
   * simply contributes 0 to both. Always a plain number, never null. */
  overlapCount: number
  overlapN: number
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
        overlapCount: 0,
        overlapN: 0,
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
    // Deliberate deviation from the sumIki/sumSqIki null-poisoning rule
    // above (codex P1 review — overrides the original task doc's "same
    // rule as SD" instruction): `undefined` (trigram rows never carry
    // these columns) and `null` (a bigram row that predates schema v8,
    // or whose events never had a determined overlap) both just mean
    // "this row observed nothing about overlap" and contribute 0 to
    // both accumulators, rather than poisoning the whole pair. Unlike
    // sumIki, there is no cross-row inconsistency possible here: each
    // row's own oc/on is already a self-consistent fraction of the
    // events THAT row observed, so a missing row can never hide a real
    // partial count the way an incomplete sum could silently understate
    // an SD. Poisoning here would mean every pair touched by even one
    // v7-era row — i.e. every pair for the entire v7->v8 transition
    // month — or one v8 row whose presses all had undefined overlap,
    // permanently nulls that pair's contribution to observedRolloverRatio.
    if (row.overlapCount != null && row.overlapN != null) {
      entry.overlapCount += row.overlapCount
      entry.overlapN += row.overlapN
    }
  }
  return totals
}

/** Selection-wide overlap ratio: ΣoverlapCount / ΣoverlapN across every
 * pair in `totals` (see {@link aggregatePairTotals} — a row with no
 * overlap data just contributes 0 to both sums, it is never poisoned).
 * Null when the resulting denominator is 0 (no pair in the selection
 * ever had a determined overlap — e.g. a trigram view, or a selection
 * entirely from before schema v8).
 *
 * Named with the `observed` prefix everywhere this value travels (type,
 * IPC field, any future CSV/UI column) because it is a SAMPLED
 * approximation of how often consecutive keys physically overlapped —
 * bounded by the renderer's polling cadence, not a measurement of true
 * rollover timing (see Plan-typing-metrics-chi2018.md "制約 2"). It must
 * never be presented as "the" rollover rate.
 *
 * Residual bias, even after the fixes above: a same-frame tie (two
 * presses landing in one polled frame, iki === 0 in
 * MinuteBuffer.recordNgramChain) folds its overlap into the TIED pair
 * rather than advancing the chain, so the tie key becomes stale for
 * whatever pair the chain completes next. Concretely — A and B pressed
 * in the same frame, then C pressed later: pair A_C's overlap sample
 * actually describes "was B still down when C was pressed", not
 * A's relationship to C. Full reference-key realignment (re-deriving
 * which physical key the NEXT pair should compare against after a tie)
 * was considered and rejected as machinery disproportionate to an
 * avowedly sampled, approximate metric. What remains after the tie fix
 * is this: the ratio no longer has a systematic downward bias (ties used
 * to discard the overlap evidence entirely), but it does carry
 * attribution noise — a small, non-systematic chance that a sample
 * counted toward one pair actually describes a different, adjacent one —
 * concentrated in fast chords where same-frame ties are common. */
export function observedRolloverRatio(totals: ReadonlyMap<string, BigramPairTotal>): number | null {
  let oc = 0
  let on = 0
  for (const entry of totals.values()) {
    oc += entry.overlapCount
    on += entry.overlapN
  }
  return on > 0 ? oc / on : null
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

/** Per-pair overlapCount/overlapN projection shared by
 * `rankBigramsByCount` and `rankBigramsBySlow` — see
 * {@link TypingBigramTopEntry.overlapCount} for the null-pairing
 * contract this enforces: `overlapN === 0` (no determined-overlap
 * sample for this pair) collapses both fields to null; otherwise the
 * raw accumulated counts pass through unchanged, including a real
 * `overlapCount === 0` (an observed 0% for this pair). */
function overlapProjection(entry: BigramPairTotal): { overlapCount: number | null; overlapN: number | null } {
  if (entry.overlapN === 0) return { overlapCount: null, overlapN: null }
  return { overlapCount: entry.overlapCount, overlapN: entry.overlapN }
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
    ...overlapProjection(t),
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
    ...overlapProjection(entry),
  }))
}

// --- Matrix cell keypress-duration aggregation ------------------------
// Same per-cell-across-minutes folding pattern as aggregatePairTotals
// above, but for matrix-release durations. There is no cross-row
// null-poisoning case here the way there is for sumIki/overlap: every
// MatrixDurationCellRow the DB hands back already has a complete
// hist/sum/sumSq triple (see the JSONL dh/ds/dq all-or-nothing
// validator) — a row with no duration sample that minute is simply
// excluded from the SQL result (see selectMatrixDurationForUidStmt),
// not returned with a partial/inconsistent shape.

export interface MatrixCellDurationTotal {
  row: number
  col: number
  layer: number
  /** Total duration SAMPLE count for this cell across the range — not
   * the press count (see the shared `matrix-release` event type's note
   * on why a minute's duration samples and press count can legitimately
   * differ). */
  count: number
  hist: number[]
  sum: number
  sumSq: number
}

/** Sum per-(scope, minute, cell) duration rows into one entry per
 * physical cell (row, col, layer). Counts add directly (from the
 * histogram bucket totals); histograms add element-wise; sum/sumSq
 * accumulate unconditionally since every contributing row is already a
 * complete triple (see this section's header comment). */
export function aggregateMatrixDurationTotals(
  rows: readonly MatrixDurationCellRow[],
): Map<string, MatrixCellDurationTotal> {
  const totals = new Map<string, MatrixCellDurationTotal>()
  for (const row of rows) {
    const key = `${row.row},${row.col},${row.layer}`
    let entry = totals.get(key)
    if (!entry) {
      entry = {
        row: row.row,
        col: row.col,
        layer: row.layer,
        count: 0,
        hist: new Array<number>(BIGRAM_HIST_BUCKETS).fill(0),
        sum: 0,
        sumSq: 0,
      }
      totals.set(key, entry)
    }
    for (let i = 0; i < BIGRAM_HIST_BUCKETS; i += 1) {
      const bucketCount = row.hist[i] ?? 0
      entry.hist[i] += bucketCount
      entry.count += bucketCount
    }
    entry.sum += row.sum
    entry.sumSq += row.sumSq
  }
  return totals
}

