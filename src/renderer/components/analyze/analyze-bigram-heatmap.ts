// SPDX-License-Identifier: GPL-2.0-or-later
// Bigram → key-pair heatmap helpers for the Analyze Bigrams Heatmap
// view. Selects the top-N most frequent keycodes (by total appearance
// count across the from + to halves of every pair) and lays them out
// as both axes of an N × N grid; each cell holds the avg IKI of that
// specific bigram (or null when the pair has no recorded events).

import type { TypingBigramTopEntry } from '../../../shared/types/typing-analytics'

const HIST_BUCKETS = 8

export interface BigramHeatmapCell {
  count: number
  hist: number[]
}

export interface BigramHeatmapResult {
  keys: number[]
  /** Square N × N matrix indexed as `cells[fromIdx][toIdx]`. Empty
   * cells (no recorded pair) are `null`. */
  cells: (BigramHeatmapCell | null)[][]
}

/** Pick the top-N keycodes by total occurrences (sum of count for
 * every pair the keycode is on either side of), then build an N × N
 * matrix of cells indexed by the from / to keycode. */
export function aggregateKeyHeatmap(
  entries: readonly TypingBigramTopEntry[],
  topN: number,
): BigramHeatmapResult {
  if (entries.length === 0 || topN <= 0) return { keys: [], cells: [] }

  // Sum each keycode's appearances across both halves of every pair.
  const totals = new Map<number, number>()
  const parsed: { prev: number; curr: number; entry: TypingBigramTopEntry }[] = []
  for (const entry of entries) {
    const parts = entry.bigramId.split('_')
    if (parts.length !== 2) continue
    const prev = Number(parts[0])
    const curr = Number(parts[1])
    if (!Number.isFinite(prev) || !Number.isFinite(curr)) continue
    parsed.push({ prev, curr, entry })
    totals.set(prev, (totals.get(prev) ?? 0) + entry.count)
    totals.set(curr, (totals.get(curr) ?? 0) + entry.count)
  }

  const keys = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, topN)
    .map(([key]) => key)
  const idx = new Map<number, number>()
  keys.forEach((k, i) => idx.set(k, i))

  const cells: (BigramHeatmapCell | null)[][] = Array.from(
    { length: keys.length },
    () => Array<BigramHeatmapCell | null>(keys.length).fill(null),
  )

  for (const { prev, curr, entry } of parsed) {
    const i = idx.get(prev)
    const j = idx.get(curr)
    if (i === undefined || j === undefined) continue
    let cell = cells[i][j]
    if (!cell) {
      cell = { count: 0, hist: new Array<number>(HIST_BUCKETS).fill(0) }
      cells[i][j] = cell
    }
    cell.count += entry.count
    for (let h = 0; h < HIST_BUCKETS; h += 1) {
      cell.hist[h] += entry.hist[h] ?? 0
    }
  }

  return { keys, cells }
}

/** Bucket-center driven avg IKI estimate from a histogram. Mirrors
 * the main-process aggregator (BIGRAM_BUCKET_CENTERS_MS) so renderer
 * callers don't have to import from main. */
const BUCKET_CENTERS_MS: readonly number[] = [30, 80, 125, 175, 250, 400, 750, 1500]
/** Exclusive upper bounds; the open final bucket synthesises a
 * `2 * center - lower` upper to keep p95 interpolation in range. */
const BUCKET_UPPER_BOUNDS_MS: readonly number[] = [60, 100, 150, 200, 300, 500, 1000, Number.POSITIVE_INFINITY]

export function avgIkiFromHist(hist: readonly number[]): number | null {
  let sum = 0
  let count = 0
  for (let i = 0; i < HIST_BUCKETS; i += 1) {
    const c = hist[i] ?? 0
    if (c <= 0) continue
    sum += c * BUCKET_CENTERS_MS[i]
    count += c
  }
  return count > 0 ? sum / count : null
}

/** Returns the avg IKI when the pair both has data and meets the
 * minimum threshold, otherwise null. `minMs <= 0` disables the
 * threshold check. Centralises the "skip if too fast" predicate
 * shared by the Bigrams Slow ranking and Finger pair bar chart. */
export function avgIkiAtOrAboveThreshold(
  hist: readonly number[],
  minMs: number,
): number | null {
  const avg = avgIkiFromHist(hist)
  if (avg === null) return null
  if (minMs > 0 && avg < minMs) return null
  return avg
}

/** Linear-interp percentile estimate from a packed histogram. Mirrors
 * the main-process aggregator so the Slow ranking renders the same
 * p95 whether it came over the wire or was computed client-side. */
export function percentileFromHist(hist: readonly number[], q: number): number | null {
  let total = 0
  for (let i = 0; i < HIST_BUCKETS; i += 1) total += hist[i] ?? 0
  if (total === 0) return null
  const target = q * total
  let acc = 0
  for (let i = 0; i < HIST_BUCKETS; i += 1) {
    const c = hist[i] ?? 0
    if (c <= 0) continue
    if (acc + c >= target) {
      const lower = i === 0 ? 0 : BUCKET_UPPER_BOUNDS_MS[i - 1]
      const upper = Number.isFinite(BUCKET_UPPER_BOUNDS_MS[i])
        ? BUCKET_UPPER_BOUNDS_MS[i]
        : 2 * BUCKET_CENTERS_MS[i] - lower
      const fraction = (target - acc) / c
      return lower + fraction * (upper - lower)
    }
    acc += c
  }
  // Unreachable when total > 0; defensive return.
  return null
}
