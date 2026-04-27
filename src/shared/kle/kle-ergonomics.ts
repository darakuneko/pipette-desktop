// SPDX-License-Identifier: GPL-2.0-or-later
// Ergonomics metadata estimation from KLE geometry.

import { posKey } from './pos-key'
import type { KleKey } from './types'

// -------- Types --------

export type FingerType =
  | 'left-pinky'
  | 'left-ring'
  | 'left-middle'
  | 'left-index'
  | 'left-thumb'
  | 'right-thumb'
  | 'right-index'
  | 'right-middle'
  | 'right-ring'
  | 'right-pinky'

export type HandType = 'left' | 'right'

export type RowCategory =
  | 'number'
  | 'top'
  | 'home'
  | 'bottom'
  | 'thumb'
  | 'function'

export interface ErgonomicsMeta {
  finger?: FingerType
  hand?: HandType
  row?: RowCategory
}

export const FINGER_LIST: readonly FingerType[] = [
  'left-pinky',
  'left-ring',
  'left-middle',
  'left-index',
  'left-thumb',
  'right-thumb',
  'right-index',
  'right-middle',
  'right-ring',
  'right-pinky',
] as const

export const HAND_OF_FINGER: Record<FingerType, HandType> = {
  'left-pinky': 'left',
  'left-ring': 'left',
  'left-middle': 'left',
  'left-index': 'left',
  'left-thumb': 'left',
  'right-thumb': 'right',
  'right-index': 'right',
  'right-middle': 'right',
  'right-ring': 'right',
  'right-pinky': 'right',
}

// -------- Internal helpers --------

interface Bounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

const ROW_CLUSTER_Y_THRESHOLD = 0.5
const SPLIT_GAP_MIN_UNITS = 1.5
const SPLIT_GAP_RATIO = 1.5

function centerX(k: KleKey): number {
  return k.x + k.width / 2
}

function centerY(k: KleKey): number {
  return k.y + k.height / 2
}

function keyId(k: Pick<KleKey, 'row' | 'col'>): string {
  return `${k.row},${k.col}`
}

function computeBounds(keys: KleKey[]): Bounds | null {
  if (keys.length === 0) return null
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const k of keys) {
    const cx = centerX(k)
    const cy = centerY(k)
    if (cx < minX) minX = cx
    if (cx > maxX) maxX = cx
    if (cy < minY) minY = cy
    if (cy > maxY) maxY = cy
  }
  return { minX, maxX, minY, maxY }
}

// -------- Public API --------

/**
 * Group keys into rows by their center-Y coordinate.
 * Keys within ROW_CLUSTER_Y_THRESHOLD of the previous cluster are treated as
 * the same row. Returned clusters are sorted top-to-bottom; each cluster is
 * sorted left-to-right.
 */
export function clusterRowsByY(keys: KleKey[]): KleKey[][] {
  if (keys.length === 0) return []
  const sorted = [...keys].sort((a, b) => centerY(a) - centerY(b))
  const clusters: KleKey[][] = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i++) {
    const k = sorted[i]
    const prev = clusters[clusters.length - 1]
    const prevY = centerY(prev[prev.length - 1])
    if (centerY(k) - prevY < ROW_CLUSTER_Y_THRESHOLD) {
      prev.push(k)
    } else {
      clusters.push([k])
    }
  }
  for (const cluster of clusters) {
    cluster.sort((a, b) => centerX(a) - centerX(b))
  }
  return clusters
}

/**
 * Detect a split-keyboard center gap from the x-position histogram.
 * Requires the biggest gap to be at least {@link SPLIT_GAP_MIN_UNITS} units wide
 * AND clearly larger than the second-largest gap, so a regular row with uneven
 * spacing doesn't get mistaken for a split.
 */
export function detectSplitGap(
  keys: KleKey[],
): { gap: number; midX: number } | null {
  if (keys.length < 2) return null
  const xs = keys.map(centerX).sort((a, b) => a - b)
  let maxGap = 0
  let midX = 0
  const gaps: number[] = []
  for (let i = 1; i < xs.length; i++) {
    const g = xs[i] - xs[i - 1]
    gaps.push(g)
    if (g > maxGap) {
      maxGap = g
      midX = (xs[i] + xs[i - 1]) / 2
    }
  }
  if (gaps.length < 2) return null
  const sortedGaps = [...gaps].sort((a, b) => b - a)
  const secondGap = sortedGaps[1] ?? 0
  if (maxGap >= SPLIT_GAP_MIN_UNITS && maxGap > secondGap * SPLIT_GAP_RATIO) {
    return { gap: maxGap, midX }
  }
  return null
}

/**
 * Collect the "row,col" identifiers of keys classified as thumb-row keys.
 * Treats the bottom-most row cluster as the thumb row (space bar + adjacent modifiers).
 * Returns an empty set when the keyboard has fewer than two rows.
 */
export function detectThumbSet(rowClusters: KleKey[][]): Set<string> {
  if (rowClusters.length < 2) return new Set()
  const bottom = rowClusters[rowClusters.length - 1]
  const set = new Set<string>()
  for (const k of bottom) {
    set.add(keyId(k))
  }
  return set
}

/**
 * Always returns 'left' or 'right'. Boundary-value keys (cx === handMidX)
 * go to the left hand — on ANSI 60% that keeps B on the left index finger
 * instead of flipping sides. Never returns undefined so Hand Balance charts
 * don't drop half their data.
 */
export function estimateHandFromX(x: number, handMidX: number): HandType {
  return x <= handMidX ? 'left' : 'right'
}

/**
 * Pick the x coordinate that splits left vs right hand.
 * The home row (3rd from bottom) is the most balanced row on typical layouts,
 * so we use the midpoint between its two middle keys. When the home row can't
 * be identified (e.g. fewer than 3 rows), fall back to the bounds midpoint.
 */
function computeHandMidX(rowClusters: KleKey[][], bounds: Bounds): number {
  const homeIdx = rowClusters.length - 3
  const candidate = homeIdx >= 0 ? rowClusters[homeIdx] : null
  if (candidate && candidate.length >= 2) {
    const sorted = [...candidate].sort((a, b) => centerX(a) - centerX(b))
    const mid = Math.floor(sorted.length / 2)
    return (centerX(sorted[mid - 1]) + centerX(sorted[mid])) / 2
  }
  return (bounds.minX + bounds.maxX) / 2
}

function rowCategoryForIndex(
  idx: number,
  total: number,
): RowCategory | undefined {
  const bottomIdx = total - 1
  if (idx === bottomIdx) return 'thumb'
  const order: RowCategory[] = ['bottom', 'home', 'top', 'number', 'function']
  return order[bottomIdx - idx - 1]
}

/**
 * Map a key to a row category (number / top / home / bottom / thumb / function)
 * based on which cluster it belongs to. Layouts with only one row are ambiguous
 * and get undefined.
 */
export function estimateRowCategoryFromClusters(
  key: Pick<KleKey, 'row' | 'col'>,
  rowClusters: KleKey[][],
): RowCategory | undefined {
  if (rowClusters.length < 2) return undefined
  for (let i = 0; i < rowClusters.length; i++) {
    if (rowClusters[i].some((k) => k.row === key.row && k.col === key.col)) {
      return rowCategoryForIndex(i, rowClusters.length)
    }
  }
  return undefined
}

type NonThumbRole = 'index' | 'middle' | 'ring' | 'pinky'

function roleByDistanceFromHandCenter(distance: number): NonThumbRole {
  if (distance <= 1) return 'index'
  if (distance === 2) return 'middle'
  if (distance === 3) return 'ring'
  return 'pinky'
}

/**
 * Map a key to a finger by its in-row position within the same hand side.
 * Thumb-cluster keys collapse to left-thumb / right-thumb.
 * Non-thumb keys are column-mapped: for the left hand the right-most columns
 * (reverse index) are index -> pinky; for the right hand the left-most columns
 * (forward index) are index -> pinky. This keeps Q/A/Z all on left-pinky
 * regardless of how much the row is horizontally shifted by modifiers.
 */
export function estimateFingerFromXY(
  key: KleKey,
  rowClusters: KleKey[][],
  thumbSet: Set<string>,
  hand: HandType,
  handMidX: number,
): FingerType | undefined {
  if (thumbSet.has(keyId(key))) {
    return hand === 'left' ? 'left-thumb' : 'right-thumb'
  }
  const row = rowClusters.find((r) =>
    r.some((k) => k.row === key.row && k.col === key.col),
  )
  if (!row) return undefined
  const handKeys = row.filter((k) => {
    const cx = centerX(k)
    const sameHand = hand === 'left' ? cx <= handMidX : cx > handMidX
    return sameHand && !thumbSet.has(keyId(k))
  })
  if (handKeys.length === 0) return undefined
  const idx = handKeys.findIndex(
    (k) => k.row === key.row && k.col === key.col,
  )
  if (idx === -1) return undefined
  const distance = hand === 'left' ? handKeys.length - 1 - idx : idx
  return `${hand}-${roleByDistanceFromHandCenter(distance)}` as FingerType
}

/**
 * Cached geometry needed for ergonomics estimation. Build once per layout and
 * reuse via {@link estimateErgonomicsWithContext} to avoid recomputing clusters
 * for every key. Bounds are intentionally not exposed — they are only used
 * internally to compute handMidX.
 */
export interface ErgonomicsContext {
  rowClusters: KleKey[][]
  thumbSet: Set<string>
  splitMidX: number | null
  handMidX: number
}

export function buildErgonomicsContext(
  allKeys: KleKey[],
): ErgonomicsContext | null {
  const bounds = computeBounds(allKeys)
  if (!bounds) return null
  const splitGap = detectSplitGap(allKeys)
  const splitMidX = splitGap?.midX ?? null
  const rowClusters = clusterRowsByY(allKeys)
  const thumbSet = detectThumbSet(rowClusters)
  const handMidX = splitMidX ?? computeHandMidX(rowClusters, bounds)
  return { rowClusters, thumbSet, splitMidX, handMidX }
}

export function estimateErgonomicsWithContext(
  key: KleKey,
  ctx: ErgonomicsContext,
): ErgonomicsMeta {
  const hand = estimateHandFromX(centerX(key), ctx.handMidX)
  const row = estimateRowCategoryFromClusters(key, ctx.rowClusters)
  const finger = estimateFingerFromXY(
    key,
    ctx.rowClusters,
    ctx.thumbSet,
    hand,
    ctx.handMidX,
  )
  return { finger, hand, row }
}

/**
 * Single-key entry point. For many keys in a row, prefer
 * {@link buildErgonomicsContext} + {@link estimateErgonomicsWithContext}.
 */
export function estimateErgonomics(
  key: KleKey,
  allKeys: KleKey[],
): ErgonomicsMeta {
  const ctx = buildErgonomicsContext(allKeys)
  if (!ctx) return {}
  return estimateErgonomicsWithContext(key, ctx)
}

/**
 * Pre-compute ergonomics meta for every key, keyed by `posKey(row, col)`.
 * Returns an empty Map when geometry context can't be built (e.g.
 * empty key set). Callers can then fold per-event lookups to a single
 * Map.get() without repeating estimateErgonomicsWithContext.
 */
export function buildErgonomicsByPos(
  keys: KleKey[],
): Map<string, ErgonomicsMeta> {
  const out = new Map<string, ErgonomicsMeta>()
  const ctx = buildErgonomicsContext(keys)
  if (!ctx) return out
  for (const k of keys) {
    out.set(posKey(k.row, k.col), estimateErgonomicsWithContext(k, ctx))
  }
  return out
}
