// SPDX-License-Identifier: GPL-2.0-or-later
//
// Aggregator for the Analyze Ergonomic Learning Curve. Groups
// per-day matrix-cell rows into week / month buckets and folds each
// bucket into ergonomic sub-scores (finger load deviation / hand
// balance / home row stay). Pure functions — covered by tests.
//
// Score notes:
// - All sub-scores live in `[0, 1]`; 1 = ideal, 0 = worst-case.
//   The composite `overall` is a weighted mean over the three
//   scores so it also stays in `[0, 1]`. The UI scales to a
//   0–100 % display.
// - `overall` is intentionally NOT a calibrated absolute metric. The
//   weights are heuristic and finger-stddev is sensitive to layout
//   choices. Treat the curve as a relative trend over time, not as
//   an absolute "good" vs "bad" judgement.

import type { TypingMatrixCellDailyRow } from '../../../shared/types/typing-analytics'
import type {
  ErgonomicsMeta,
  FingerType,
  HandType,
  RowCategory,
} from '../../../shared/kle/kle-ergonomics'
import { FINGER_LIST } from '../../../shared/kle/kle-ergonomics'
import { posKey } from '../../../shared/kle/pos-key'
import type { RangeMs } from './analyze-types'
import { MONTH_MS, WEEK_MS, snapBucketStartLocal } from './analyze-bucket'
import {
  zeroFingerCounts,
  zeroHandCounts,
  zeroRowCounts,
} from './analyze-ergonomics'

export type LearningCurvePeriod = 'week' | 'month'

/** Default minimum keystrokes required for a bucket to count toward
 * trend summaries. Buckets below this stay visible (so empty-week
 * gaps don't create misleading jumps) but are flagged
 * `qualified = false` so the chart can dim or annotate them. */
export const DEFAULT_LEARNING_MIN_SAMPLE = 1000

/** Fixed weights for the composite `overall` score. Heuristic — not
 * derived from a formal study; the UI surfaces a "relative trend
 * only" note alongside the score so users don't read absolute
 * meaning into the number. */
export const LEARNING_SCORE_WEIGHTS = {
  fingerLoadDeviation: 0.35,
  handBalance: 0.35,
  homeRowStay: 0.30,
} as const

/** Per-bucket roll-up. All sub-scores are in `[0, 1]` (1 = ideal). */
export interface LearningCurveBucket {
  bucketStartMs: number
  totalKeystrokes: number
  fingerCounts: Record<FingerType, number>
  handCounts: Record<HandType, number>
  rowCounts: Record<RowCategory, number>
  unmappedFingerKeystrokes: number
  fingerLoadDeviation: number
  handBalance: number
  homeRowStay: number
  overall: number
  /** `true` when `totalKeystrokes >= minSampleKeystrokes`. */
  qualified: boolean
}

export interface LearningCurveResult {
  period: LearningCurvePeriod
  buckets: LearningCurveBucket[]
}

export interface BuildLearningCurveInput {
  rows: readonly TypingMatrixCellDailyRow[]
  range: RangeMs
  period: LearningCurvePeriod
  /** Pre-computed by `buildErgonomicsByPos(allKeys)` so the same
   * geometry context is shared with the snapshot view. Cells whose
   * `posKey(row, col)` is missing from the map are skipped — the row
   * is silently dropped from the aggregate but does not contribute
   * to `unmappedFinger` (that bucket is reserved for keys whose
   * geometry is known but whose finger could not be resolved by
   * column position). */
  ergonomicsByPos: Map<string, ErgonomicsMeta>
  /** Counts at or above this threshold mark the bucket as qualified;
   * the trend summary only considers qualified buckets. */
  minSampleKeystrokes?: number
}

function periodWidthMs(period: LearningCurvePeriod): number {
  return period === 'week' ? WEEK_MS : MONTH_MS
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  if (v <= 0) return 0
  if (v >= 1) return 1
  return v
}

/** Map finger-load standard deviation to a 0..1 score. Worst case
 * (all keystrokes on a single finger) hits the maximum stddev for
 * the chosen finger count; we normalize against that maximum so the
 * mapping stays linear and well-behaved. Even spread (stddev = 0)
 * returns 1, single-finger lock-in returns 0. */
function fingerLoadDeviationScore(
  fingerCounts: Record<FingerType, number>,
  total: number,
): number {
  if (total <= 0) return 0
  const ideal = 1 / FINGER_LIST.length
  let sumSq = 0
  for (const f of FINGER_LIST) {
    const fr = fingerCounts[f] / total
    sumSq += (fr - ideal) ** 2
  }
  const stddev = Math.sqrt(sumSq / FINGER_LIST.length)
  // Worst case: one finger holds 100 % → stddev =
  // sqrt(((1 - ideal)^2 + (n - 1) * ideal^2) / n).
  const worstStddev = Math.sqrt(
    ((1 - ideal) ** 2 + (FINGER_LIST.length - 1) * ideal ** 2) / FINGER_LIST.length,
  )
  if (worstStddev === 0) return 1
  return clamp01(1 - stddev / worstStddev)
}

function handBalanceScore(handCounts: Record<HandType, number>): number {
  const total = handCounts.left + handCounts.right
  if (total <= 0) return 0
  const leftFraction = handCounts.left / total
  const offset = Math.abs(leftFraction - 0.5)
  // offset ∈ [0, 0.5]; doubling maps to [0, 1] before the clamp.
  return clamp01(1 - offset * 2)
}

function homeRowStayScore(
  rowCounts: Record<RowCategory, number>,
  total: number,
): number {
  if (total <= 0) return 0
  return clamp01(rowCounts.home / total)
}

function compositeOverall(parts: {
  fingerLoadDeviation: number
  handBalance: number
  homeRowStay: number
}): number {
  const w = LEARNING_SCORE_WEIGHTS
  return clamp01(
    parts.fingerLoadDeviation * w.fingerLoadDeviation +
    parts.handBalance * w.handBalance +
    parts.homeRowStay * w.homeRowStay,
  )
}

/** Group per-day matrix-cell rows into week / month buckets and
 * compute ergonomic sub-scores per bucket. Buckets are ordered
 * ascending by `bucketStartMs`; buckets with no contributing keys
 * are omitted (the chart bridges gaps via the X-axis). */
export function buildLearningCurve({
  rows,
  range,
  period,
  ergonomicsByPos,
  minSampleKeystrokes = DEFAULT_LEARNING_MIN_SAMPLE,
}: BuildLearningCurveInput): LearningCurveResult {
  const bucketWidth = periodWidthMs(period)
  const accum = new Map<
    number,
    {
      finger: Record<FingerType, number>
      hand: Record<HandType, number>
      row: Record<RowCategory, number>
      unmappedFinger: number
      total: number
    }
  >()
  for (const r of rows) {
    if (r.dayMs < range.fromMs || r.dayMs >= range.toMs) continue
    if (!(r.count > 0)) continue
    const meta = ergonomicsByPos.get(posKey(r.row, r.col))
    if (!meta) continue
    const bucketStart = snapBucketStartLocal(r.dayMs, bucketWidth)
    let entry = accum.get(bucketStart)
    if (!entry) {
      entry = {
        finger: zeroFingerCounts(),
        hand: zeroHandCounts(),
        row: zeroRowCounts(),
        unmappedFinger: 0,
        total: 0,
      }
      accum.set(bucketStart, entry)
    }
    entry.total += r.count
    if (meta.finger) {
      entry.finger[meta.finger] += r.count
    } else {
      entry.unmappedFinger += r.count
    }
    if (meta.hand) entry.hand[meta.hand] += r.count
    if (meta.row) entry.row[meta.row] += r.count
  }
  const buckets: LearningCurveBucket[] = Array.from(accum.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([bucketStartMs, e]) => {
      const fld = fingerLoadDeviationScore(e.finger, e.total)
      const hb = handBalanceScore(e.hand)
      const hrs = homeRowStayScore(e.row, e.total)
      const overall = compositeOverall({
        fingerLoadDeviation: fld,
        handBalance: hb,
        homeRowStay: hrs,
      })
      return {
        bucketStartMs,
        totalKeystrokes: e.total,
        fingerCounts: e.finger,
        handCounts: e.hand,
        rowCounts: e.row,
        unmappedFingerKeystrokes: e.unmappedFinger,
        fingerLoadDeviation: fld,
        handBalance: hb,
        homeRowStay: hrs,
        overall,
        qualified: e.total >= minSampleKeystrokes,
      }
    })
  return { period, buckets }
}

/** Latest qualified bucket compared against the mean of the earlier
 * qualified buckets. The UI uses this to render an "improving by
 * +X %" line; returns null when there is no comparable history
 * (under two qualified buckets). */
export interface LearningCurveTrend {
  latest: LearningCurveBucket
  baselineMean: number
  /** `latest.overall - baselineMean`. A delta of `+0.05` means
   * "5 percentage points above the earlier average". */
  delta: number
  baselineCount: number
}

export function summarizeLearningCurve(
  buckets: readonly LearningCurveBucket[],
): LearningCurveTrend | null {
  const qualified = buckets.filter((b) => b.qualified)
  if (qualified.length < 2) return null
  const latest = qualified[qualified.length - 1]
  const earlier = qualified.slice(0, -1)
  const baselineMean =
    earlier.reduce((sum, b) => sum + b.overall, 0) / earlier.length
  return {
    latest,
    baselineMean,
    delta: latest.overall - baselineMean,
    baselineCount: earlier.length,
  }
}
