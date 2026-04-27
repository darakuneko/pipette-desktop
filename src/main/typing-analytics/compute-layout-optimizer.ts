// SPDX-License-Identifier: GPL-2.0-or-later
//
// Layout Optimizer Phase 1 metric aggregation. Pure compute layer
// that takes pre-fetched matrix counts + a snapshot + KleKey geometry
// and folds them into per-target finger / hand / row distributions.
//
// The IPC handler in `typing-analytics-service.ts` is responsible for
// resolving the machine hash, pulling the matrix counts and the
// snapshot, parsing `snapshot.layout` into KleKeys, and calling
// `computeLayoutOptimizer` with the assembled inputs. Keeping the
// compute step pure lets tests exercise the metric math without
// faking IPC, DB, or filesystem.
//
// See Plan-analyze-layout-optimizer §「metric 計算式」.

import type { ErgonomicsMeta, FingerType, RowCategory } from '../../shared/kle/kle-ergonomics'
import type { KleKey } from '../../shared/kle/types'
import type {
  LayoutOptimizerFingerKey,
  LayoutOptimizerInputLayout,
  LayoutOptimizerMetric,
  LayoutOptimizerResult,
  LayoutOptimizerRowKey,
  LayoutOptimizerTargetResult,
  TypingHeatmapCell,
  TypingKeymapSnapshot,
} from '../../shared/types/typing-analytics'
import { buildLayoutResolver, type ResolveResult } from './layout-resolver'

export interface ComputeLayoutOptimizerInput {
  /** posKey → matrix count for the recorded range and scope. The
   * loader is allowed to pass either the full Map<…, full cell> or a
   * Map keyed by total-only — only `cell.total` is consumed here. */
  matrixCounts: Map<string, Pick<TypingHeatmapCell, 'total'>>
  snapshot: TypingKeymapSnapshot
  kleKeys: KleKey[]
  source: LayoutOptimizerInputLayout
  targets: LayoutOptimizerInputLayout[]
  /** Subset of metrics to compute. Empty array yields just the
   * total / skipped event counts. */
  metrics: LayoutOptimizerMetric[]
  /** Layer to read from `snapshot.keymap`. Phase 1 reads layer 0. */
  layer?: number
}

interface TargetAccumulator {
  totalEvents: number
  skippedEvents: number
  fingerCounts: Map<FingerType, number>
  unmappedFinger: number
  handCounts: { left: number; right: number }
  rowCounts: Map<RowCategory, number>
  homeEvents: number
}

function newAccumulator(): TargetAccumulator {
  return {
    totalEvents: 0,
    skippedEvents: 0,
    fingerCounts: new Map(),
    unmappedFinger: 0,
    handCounts: { left: 0, right: 0 },
    rowCounts: new Map(),
    homeEvents: 0,
  }
}

function record(acc: TargetAccumulator, count: number, result: ResolveResult): void {
  if (result.skipped) {
    acc.skippedEvents += count
    return
  }
  acc.totalEvents += count
  const meta: ErgonomicsMeta = {
    finger: result.finger,
    hand: result.hand,
    row: result.rowCategory,
  }
  if (meta.finger) {
    acc.fingerCounts.set(meta.finger, (acc.fingerCounts.get(meta.finger) ?? 0) + count)
  } else {
    acc.unmappedFinger += count
  }
  if (meta.hand === 'left' || meta.hand === 'right') {
    acc.handCounts[meta.hand] += count
  }
  if (meta.row) {
    acc.rowCounts.set(meta.row, (acc.rowCounts.get(meta.row) ?? 0) + count)
    if (meta.row === 'home') acc.homeEvents += count
  }
}

function ratio(numer: number, denom: number): number {
  return denom > 0 ? numer / denom : 0
}

function finalizeTarget(
  layoutId: string,
  acc: TargetAccumulator,
  metrics: ReadonlySet<LayoutOptimizerMetric>,
): LayoutOptimizerTargetResult {
  const totalRaw = acc.totalEvents + acc.skippedEvents
  const out: LayoutOptimizerTargetResult = {
    layoutId,
    totalEvents: acc.totalEvents,
    skippedEvents: acc.skippedEvents,
    skipRate: ratio(acc.skippedEvents, totalRaw),
  }
  if (metrics.has('fingerLoad')) {
    const fingerLoad: Partial<Record<LayoutOptimizerFingerKey, number>> = {}
    for (const [finger, count] of acc.fingerCounts) {
      fingerLoad[finger as LayoutOptimizerFingerKey] = ratio(count, acc.totalEvents)
    }
    out.fingerLoad = fingerLoad
    out.unmappedFinger = ratio(acc.unmappedFinger, acc.totalEvents)
  }
  if (metrics.has('handBalance')) {
    const handTotal = acc.handCounts.left + acc.handCounts.right
    out.handBalance = {
      left: ratio(acc.handCounts.left, handTotal),
      right: ratio(acc.handCounts.right, handTotal),
    }
  }
  if (metrics.has('rowDist')) {
    const rowDist: Partial<Record<LayoutOptimizerRowKey, number>> = {}
    for (const [row, count] of acc.rowCounts) {
      rowDist[row as LayoutOptimizerRowKey] = ratio(count, acc.totalEvents)
    }
    out.rowDist = rowDist
  }
  if (metrics.has('homeRow')) {
    out.homeRowStay = ratio(acc.homeEvents, acc.totalEvents)
  }
  return out
}

export function computeLayoutOptimizer(input: ComputeLayoutOptimizerInput): LayoutOptimizerResult {
  const layer = input.layer ?? 0
  const metrics = new Set(input.metrics)
  const targets: LayoutOptimizerTargetResult[] = []
  for (const target of input.targets) {
    const resolver = buildLayoutResolver({
      snapshot: input.snapshot,
      kleKeys: input.kleKeys,
      sourceLayout: input.source,
      targetLayout: target,
      layer,
    })
    const acc = newAccumulator()
    for (const [pos, cell] of input.matrixCounts) {
      const count = cell.total
      if (!(count > 0)) continue
      const [rowStr, colStr] = pos.split(',')
      const row = Number(rowStr)
      const col = Number(colStr)
      if (!Number.isFinite(row) || !Number.isFinite(col)) continue
      record(acc, count, resolver.resolve(row, col))
    }
    targets.push(finalizeTarget(target.id, acc, metrics))
  }
  return {
    sourceLayoutId: input.source.id,
    targets,
  }
}
