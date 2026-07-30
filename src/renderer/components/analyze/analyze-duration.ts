// SPDX-License-Identifier: GPL-2.0-or-later
// Client-side aggregation for the Analyze keypress-duration section.
// The TYPING_ANALYTICS_LIST_DURATION_CELLS channel already folds every
// contributing minute into one total per (row, col, layer) cell (see
// aggregateMatrixDurationTotals in main's bigram-aggregate.ts) — this
// module only needs to sum those per-cell totals into one
// selection-wide histogram + sum/sumSq, and turn the shared
// DURATION_BUCKET_UPPER_BOUNDS_MS grid into axis/tooltip labels so the
// chart and any CSV export built from the same grid can't disagree.

import type { TypingDurationCell } from '../../../shared/types/typing-analytics'

export interface DurationTotals {
  /** Element-wise sum of every cell's histogram — index i is bucket i's
   * total sample count across the whole selection. */
  hist: number[]
  /** Total duration SAMPLE count — see TypingDurationCell's doc comment
   * on why this can differ from the press count. */
  samples: number
  sum: number
  sumSq: number
}

const DEFAULT_BUCKET_COUNT = 8

/** Sums every returned cell into one selection-wide total. Cells are
 * already folded per (row, col, layer) main-side; there is no
 * null-poisoning case here (unlike the bigram sumIki accumulator) since
 * every cell the IPC returns already carries a complete hist/sum/sumSq
 * triple (see TypingDurationCell's doc comment). */
export function sumDurationTotals(cells: readonly TypingDurationCell[]): DurationTotals {
  const bucketCount = cells[0]?.hist.length ?? DEFAULT_BUCKET_COUNT
  const hist = new Array<number>(bucketCount).fill(0)
  let samples = 0
  let sum = 0
  let sumSq = 0
  for (const cell of cells) {
    for (let i = 0; i < hist.length; i += 1) hist[i] += cell.hist[i] ?? 0
    samples += cell.durationSamples
    sum += cell.sum
    sumSq += cell.sumSq
  }
  return { hist, samples, sum, sumSq }
}

/** Categorical bin ids for the duration histogram, index-aligned with
 * `DURATION_BUCKET_UPPER_BOUNDS_MS` — translated via
 * `t(\`analyze.duration.bin.${id}\`)`, the same per-bin translated-label
 * convention the interval histogram's `analyze.interval.bin.*` keys use
 * (see `HISTOGRAM_BIN_IDS` in analyze-histogram.ts). */
export const DURATION_BUCKET_BIN_IDS = [
  'lt50', '50to80', '80to110', '110to140', '140to180', '180to250', '250to400', 'gt400',
] as const
