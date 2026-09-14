// SPDX-License-Identifier: GPL-2.0-or-later

// Pure geometry for the View Matrix wiring overlay: given a keyboard's
// visible keys and each key's effective (View Matrix) row/col, build one
// polyline per matrix row, one per matrix column, and one node per key.
// No React/DOM here so the overlay component and its tests can both build
// on a plain, side-effect-free function.

import type { KleKey } from '../../../shared/kle/types'
import { posKey } from '../../../shared/kle/pos-key'
import { keyCenter } from './key-geometry'

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

/** Builds one axis's wires (row or col) from the same placed-key list.
 *  Row wires group by effective row, order members left-to-right (x),
 *  and anchor their label at the leftmost member's y; col wires are the
 *  mirror image, grouping by effective col, ordering top-to-bottom (y),
 *  anchoring at the topmost member's x. `along` is both the ordering
 *  tie-break axis and the axis used to find each wire's label anchor
 *  (the member nearest the gutter); `across` is the anchor's other
 *  coordinate, which becomes the label's fixed position along the wire. */
function buildAxisWires(
  placed: readonly PlacedKey[],
  axis: 'row' | 'col',
  gutter: MatrixWiresGutter,
): MatrixWire[] {
  const groupBy = axis === 'row' ? (p: PlacedKey) => p.effectiveRow : (p: PlacedKey) => p.effectiveCol
  const orderBy = axis === 'row' ? (p: PlacedKey) => p.effectiveCol : (p: PlacedKey) => p.effectiveRow
  const along = axis === 'row' ? (p: PlacedKey) => p.x : (p: PlacedKey) => p.y
  const across = axis === 'row' ? (p: PlacedKey) => p.y : (p: PlacedKey) => p.x

  const groups = groupAndOrder(placed, groupBy, orderBy, along)
  const indices = [...groups.keys()].sort((a, b) => a - b)

  const labelPositions = indices.map((index) => {
    const members = groups.get(index)!
    const anchor = members.reduce((min, p) => (along(p) < along(min) ? p : min), members[0])
    return across(anchor)
  })
  const lines = assignLabelLines(labelPositions, gutter.fontSize)
  const base = axis === 'row' ? gutter.originX + gutter.size / 2 : gutter.originY + gutter.size / 2

  return indices.map((index, i) => {
    const alongGutterPos = lines[i] === 1 ? base + gutter.fontSize : base
    return {
      index,
      points: groups.get(index)!.map((p) => ({ x: p.x, y: p.y })),
      label: axis === 'row'
        ? { x: alongGutterPos, y: labelPositions[i] }
        : { x: labelPositions[i], y: alongGutterPos },
    }
  })
}

export function buildMatrixWires(
  visibleKeys: readonly KleKey[],
  cells: ReadonlyMap<string, { row: number; col: number }>,
  scale: number,
  gutter: MatrixWiresGutter,
): MatrixWiresLayout {
  const seen = new Set<string>()
  const placed: PlacedKey[] = []

  for (const key of visibleKeys) {
    if (key.decal || key.encoderIdx >= 0) continue
    const pos = posKey(key.row, key.col)
    if (seen.has(pos)) continue
    seen.add(pos)

    const center = keyCenter(key, scale)
    const effective = cells.get(pos) ?? { row: key.row, col: key.col }
    placed.push({ posKey: pos, effectiveRow: effective.row, effectiveCol: effective.col, ...center })
  }

  return {
    rows: buildAxisWires(placed, 'row', gutter),
    cols: buildAxisWires(placed, 'col', gutter),
    nodes: placed.map(({ posKey, x, y }) => ({ posKey, x, y })),
  }
}
