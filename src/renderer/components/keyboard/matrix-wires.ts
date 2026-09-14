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

/** Assigns each label position a "line" (0 or 1), walking the positions in
 *  ascending coordinate order rather than the caller's index order —
 *  comparing only index-adjacent neighbors misses collisions between
 *  labels whose matrix indices are far apart but whose coordinates
 *  coincide (split boards, reordered View Matrix positions). A label
 *  stays on line 0 unless it lands closer than `fontSize` to the last
 *  label already placed on line 0, in which case it moves to line 1 —
 *  even if that also collides with the last label on line 1, since two
 *  lines is the cap. The returned array is aligned back to the input's
 *  original order. */
function assignLabelLines(positions: readonly number[], fontSize: number): number[] {
  const order = positions.map((_, index) => index).sort((a, b) => positions[a] - positions[b])
  const lines = new Array<number>(positions.length).fill(0)
  const lastOnLine: [number | null, number | null] = [null, null]
  for (const index of order) {
    const pos = positions[index]
    const line = lastOnLine[0] !== null && Math.abs(pos - lastOnLine[0]) < fontSize ? 1 : 0
    lines[index] = line
    lastOnLine[line] = pos
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
  // The gutter's two label lines sit symmetrically around its own center
  // line so neither one leans further into the key area than the other.
  const center = axis === 'row' ? gutter.originX + gutter.size / 2 : gutter.originY + gutter.size / 2

  return indices.map((index, i) => {
    const alongGutterPos = center + (lines[i] === 1 ? gutter.fontSize / 2 : -gutter.fontSize / 2)
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
