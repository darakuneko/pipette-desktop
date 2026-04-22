// SPDX-License-Identifier: GPL-2.0-or-later
// Aggregators that fold a merged heatmap into ergonomics dimensions
// (finger / hand / row category). Pure functions — covered by tests.

import type { TypingHeatmapCell } from '../../../shared/types/typing-analytics'
import type { KleKey } from '../../../shared/kle/types'
import {
  FINGER_LIST,
  buildErgonomicsContext,
  estimateErgonomicsWithContext,
  type FingerType,
  type HandType,
  type RowCategory,
} from '../../../shared/kle/kle-ergonomics'

/** Keystroke counts bucketed by one ergonomic dimension. */
export type FingerCounts = Record<FingerType, number>
export type HandCounts = Record<HandType, number>
export type RowCategoryCounts = Record<RowCategory, number>

export interface ErgonomicsAggregation {
  finger: FingerCounts
  hand: HandCounts
  row: RowCategoryCounts
  /** Sum across every counted cell. Useful for `shareOfTotal` later. */
  total: number
  /** Counts whose key fell outside the finger mapping (non-thumb and not
   * resolvable by column position). Still included in `total`, `hand`
   * and `row` when those resolve. */
  unmappedFinger: number
}

function zeroFingerCounts(): FingerCounts {
  const o = {} as FingerCounts
  for (const f of FINGER_LIST) o[f] = 0
  return o
}

function zeroHandCounts(): HandCounts {
  return { left: 0, right: 0 }
}

function zeroRowCounts(): RowCategoryCounts {
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
 */
export function aggregateErgonomics(
  heatmap: Map<string, TypingHeatmapCell>,
  allKeys: KleKey[],
): ErgonomicsAggregation {
  const result: ErgonomicsAggregation = {
    finger: zeroFingerCounts(),
    hand: zeroHandCounts(),
    row: zeroRowCounts(),
    total: 0,
    unmappedFinger: 0,
  }
  const ctx = buildErgonomicsContext(allKeys)
  if (!ctx) return result

  const keyByPos = new Map<string, KleKey>()
  for (const k of allKeys) keyByPos.set(`${k.row},${k.col}`, k)

  for (const [posKey, cell] of heatmap) {
    const count = cell.total
    if (!(count > 0)) continue
    const key = keyByPos.get(posKey)
    if (!key) continue
    const meta = estimateErgonomicsWithContext(key, ctx)
    result.total += count
    if (meta.finger) {
      result.finger[meta.finger] += count
    } else {
      result.unmappedFinger += count
    }
    if (meta.hand) result.hand[meta.hand] += count
    if (meta.row) result.row[meta.row] += count
  }
  return result
}
