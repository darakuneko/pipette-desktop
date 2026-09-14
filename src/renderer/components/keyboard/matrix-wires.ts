// SPDX-License-Identifier: GPL-2.0-or-later

// Pure geometry for the View Matrix wiring overlay: given a keyboard's
// visible keys and each key's effective (View Matrix) row/col, build one
// polyline per matrix row, one per matrix column, and one node per key.
// No React/DOM here so the overlay component and its tests can both build
// on a plain, side-effect-free function.

import type { KleKey } from '../../../shared/kle/types'
import { posKey } from '../../../shared/kle/pos-key'
import { KEY_UNIT, KEY_SPACING } from './constants'
import { rotatePoint } from './key-geometry'

export interface WirePoint {
  x: number
  y: number
}

export interface MatrixWire {
  index: number
  points: WirePoint[]
  label: WirePoint
}

export interface MatrixNode {
  posKey: string
  x: number
  y: number
}

export interface MatrixWiresLayout {
  rows: MatrixWire[]
  cols: MatrixWire[]
  nodes: MatrixNode[]
}

/** The label gutter band the overlay draws row/col numbers into. The
 *  caller owns sizing and positioning the band (it widens the SVG bounds
 *  by `size` on every side so the keyboard stays centered while the
 *  overlay is on); this module only reads it to place labels. */
export interface MatrixWiresGutter {
  originX: number
  originY: number
  size: number
  fontSize: number
}

/** A key placed for wiring purposes: its physical identity, the
 *  effective (View Matrix override, or physical when absent) row/col
 *  used for grouping and ordering, and its own drawn center — which
 *  never moves regardless of the effective position. */
interface PlacedKey {
  posKey: string
  effectiveRow: number
  effectiveCol: number
  x: number
  y: number
}

/** A key's own rotated center point. Always the main rect's center, even
 *  for stepped/ISO keys with a secondary rect. */
function keyCenter(key: KleKey, scale: number): WirePoint {
  const s = KEY_UNIT * scale
  const spacing = KEY_SPACING * scale
  const cx = s * (key.x + key.width / 2) - spacing / 2
  const cy = s * (key.y + key.height / 2) - spacing / 2
  if (key.rotation === 0) return { x: cx, y: cy }
  const [x, y] = rotatePoint(cx, cy, key.rotation, s * key.rotationX, s * key.rotationY)
  return { x, y }
}

function comparePosKey(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** Groups `placed` keys by `groupBy(key)`, sorting each group's members
 *  by `orderBy` ascending, tie-breaking on `tieBreakAxis` ascending and
 *  finally on `posKey` — the shared shape of both the row-wire pass
 *  (group by effective row, order by effective col, tie on x) and the
 *  col-wire pass (group by effective col, order by effective row, tie
 *  on y). */
function groupAndOrder(
  placed: readonly PlacedKey[],
  groupBy: (p: PlacedKey) => number,
  orderBy: (p: PlacedKey) => number,
  tieBreakAxis: (p: PlacedKey) => number,
): Map<number, PlacedKey[]> {
  const groups = new Map<number, PlacedKey[]>()
  for (const p of placed) {
    const index = groupBy(p)
    const members = groups.get(index)
    if (members) members.push(p)
    else groups.set(index, [p])
  }
  for (const members of groups.values()) {
    members.sort((a, b) => {
      const byOrder = orderBy(a) - orderBy(b)
      if (byOrder !== 0) return byOrder
      const byAxis = tieBreakAxis(a) - tieBreakAxis(b)
      if (byAxis !== 0) return byAxis
      return comparePosKey(a.posKey, b.posKey)
    })
  }
  return groups
}

/** Alternates a "line" (0 or 1) assignment across a sequence of
 *  already-ordered label positions: whenever two consecutive positions
 *  are closer than `fontSize`, the later one flips to the other line;
 *  otherwise the run resets to line 0. Keeps a cluster of overlapping
 *  labels legible with just two lines instead of drifting further with
 *  every additional close neighbor. */
function assignLabelLines(positions: readonly number[], fontSize: number): number[] {
  const lines = new Array<number>(positions.length).fill(0)
  for (let i = 1; i < positions.length; i++) {
    const overlaps = Math.abs(positions[i] - positions[i - 1]) < fontSize
    lines[i] = overlaps ? (lines[i - 1] === 0 ? 1 : 0) : 0
  }
  return lines
}

export function buildMatrixWires(
  visibleKeys: readonly KleKey[],
  cells: ReadonlyMap<string, { row: number; col: number }>,
  scale: number,
  gutter: MatrixWiresGutter,
): MatrixWiresLayout {
  const seen = new Set<string>()
  const placed: PlacedKey[] = []
  const nodes: MatrixNode[] = []

  for (const key of visibleKeys) {
    if (key.decal || key.encoderIdx >= 0) continue
    const pos = posKey(key.row, key.col)
    if (seen.has(pos)) continue
    seen.add(pos)

    const center = keyCenter(key, scale)
    const effective = cells.get(pos) ?? { row: key.row, col: key.col }
    placed.push({ posKey: pos, effectiveRow: effective.row, effectiveCol: effective.col, ...center })
    nodes.push({ posKey: pos, x: center.x, y: center.y })
  }

  const rowGroups = groupAndOrder(
    placed,
    (p) => p.effectiveRow,
    (p) => p.effectiveCol,
    (p) => p.x,
  )
  const colGroups = groupAndOrder(
    placed,
    (p) => p.effectiveCol,
    (p) => p.effectiveRow,
    (p) => p.y,
  )

  const rowIndices = [...rowGroups.keys()].sort((a, b) => a - b)
  const colIndices = [...colGroups.keys()].sort((a, b) => a - b)

  // Row labels sit at the leftmost (min-x) member's y; col labels sit at
  // the topmost (min-y) member's x. Computed up front so the overlap
  // pass can alternate lines across the whole index-ordered sequence.
  const rowLabelPositions = rowIndices.map((index) => {
    const members = rowGroups.get(index)!
    return members.reduce((min, p) => (p.x < min.x ? p : min), members[0]).y
  })
  const colLabelPositions = colIndices.map((index) => {
    const members = colGroups.get(index)!
    return members.reduce((min, p) => (p.y < min.y ? p : min), members[0]).x
  })

  const rowLines = assignLabelLines(rowLabelPositions, gutter.fontSize)
  const colLines = assignLabelLines(colLabelPositions, gutter.fontSize)

  const rowBaseX = gutter.originX + gutter.size / 2
  const colBaseY = gutter.originY + gutter.size / 2

  const rows: MatrixWire[] = rowIndices.map((index, i) => ({
    index,
    points: rowGroups.get(index)!.map((p) => ({ x: p.x, y: p.y })),
    label: {
      x: rowLines[i] === 1 ? rowBaseX + gutter.fontSize : rowBaseX,
      y: rowLabelPositions[i],
    },
  }))

  const cols: MatrixWire[] = colIndices.map((index, i) => ({
    index,
    points: colGroups.get(index)!.map((p) => ({ x: p.x, y: p.y })),
    label: {
      x: colLabelPositions[i],
      y: colLines[i] === 1 ? colBaseY + gutter.fontSize : colBaseY,
    },
  }))

  return { rows, cols, nodes }
}
