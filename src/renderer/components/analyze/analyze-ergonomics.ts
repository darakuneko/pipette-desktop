// SPDX-License-Identifier: GPL-2.0-or-later
// Aggregators that fold a merged heatmap into ergonomics dimensions
// (finger / hand / row category). Pure functions — covered by tests.

import type { TypingHeatmapCell } from '../../../shared/types/typing-analytics'
import type { KleKey } from '../../../shared/kle/types'
import {
  FINGER_LIST,
  HAND_OF_FINGER,
  buildErgonomicsByPos,
  type FingerType,
  type HandType,
  type RowCategory,
} from '../../../shared/kle/kle-ergonomics'

// Re-export so callers (Ergonomics chart, CSV export builders, etc.)
// reach the constant via this module without re-importing the deeper
// kle-ergonomics path.
export { FINGER_LIST }

/** Display order for the row category bars / CSV — matches the
 * physical board layout (function row first, thumb cluster last). */
export const ROW_ORDER: readonly RowCategory[] = [
  'function',
  'number',
  'top',
  'home',
  'bottom',
  'thumb',
]

/** Keystroke counts bucketed by one ergonomic dimension. */
export type FingerCounts = Record<FingerType, number>
export type HandCounts = Record<HandType, number>
export type RowCategoryCounts = Record<RowCategory, number>

export interface ErgonomicsAggregation {
  finger: FingerCounts
  hand: HandCounts
  row: RowCategoryCounts
  /** Per-hand split of `row` so the Row pyramid can plot left vs.
   * right keystroke counts per row category without re-walking the
   * heatmap. `row[r]` equals `rowByHand.left[r] + rowByHand.right[r]`
   * plus any unmapped-hand keystrokes. */
  rowByHand: Record<HandType, RowCategoryCounts>
  /** Sum across every counted cell. Useful for `shareOfTotal` later. */
  total: number
  /** Counts whose key fell outside the finger mapping (non-thumb and not
   * resolvable by column position). Still included in `total`, `hand`
   * and `row` when those resolve. */
  unmappedFinger: number
}

export function zeroFingerCounts(): FingerCounts {
  const o = {} as FingerCounts
  for (const f of FINGER_LIST) o[f] = 0
  return o
}

export function zeroHandCounts(): HandCounts {
  return { left: 0, right: 0 }
}

export function zeroRowCounts(): RowCategoryCounts {
  return {
    number: 0,
    top: 0,
    home: 0,
    bottom: 0,
    thumb: 0,
    function: 0,
  }
}

/**
 * Aggregate a pre-merged heatmap into finger / hand / row buckets.
 * `heatmap` is expected to already reflect the caller's layer grouping
 * and normalization (see sumAndNormalizeGroupCells). Cells whose
 * `row,col` key is not present in `allKeys` are silently skipped.
 *
 * `fingerOverrides` wins over the geometry estimate when set. The hand
 * is re-derived from the override finger so "Y taken with the left
 * hand" reclassifies both the finger AND the hand in one click. Row
 * category is never overridden — it is a physical-layout property.
 */
export function aggregateErgonomics(
  heatmap: Map<string, TypingHeatmapCell>,
  allKeys: KleKey[],
  fingerOverrides?: Record<string, FingerType>,
): ErgonomicsAggregation {
  const result: ErgonomicsAggregation = {
    finger: zeroFingerCounts(),
    hand: zeroHandCounts(),
    row: zeroRowCounts(),
    rowByHand: { left: zeroRowCounts(), right: zeroRowCounts() },
    total: 0,
    unmappedFinger: 0,
  }
  const ergonomicsByPos = buildErgonomicsByPos(allKeys)

  for (const [pos, cell] of heatmap) {
    const count = cell.total
    if (!(count > 0)) continue
    const estimate = ergonomicsByPos.get(pos)
    if (!estimate) continue
    const override = fingerOverrides?.[pos]
    const finger = override ?? estimate.finger
    const hand = override ? HAND_OF_FINGER[override] : estimate.hand
    result.total += count
    if (finger) {
      result.finger[finger] += count
    } else {
      result.unmappedFinger += count
    }
    if (hand) result.hand[hand] += count
    if (estimate.row) {
      result.row[estimate.row] += count
      if (hand) result.rowByHand[hand][estimate.row] += count
    }
  }
  return result
}
