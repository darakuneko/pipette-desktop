// SPDX-License-Identifier: GPL-2.0-or-later

// Pure geometry for the View Matrix wiring overlay: given a keyboard's
// visible keys and each key's effective (View Matrix) row/col, build one
// polyline per matrix row, one per matrix column, and one node per key.
// No React/DOM here so the overlay component and its tests can both build
// on a plain, side-effect-free function. Label *placement* (which of
// possibly several stacked lines a row/col number lands on) is computed
// here too, since it depends on the same effective-position geometry; the
// label's actual screen coordinates are left to the caller (`KeyboardWidget`
// sizes the gutter band, `MatrixWiresOverlay` centers each stack inside it)
// since neither is needed to decide which keys share a matrix row/column.

import type { KleKey } from '../../../shared/kle/types'
import { posKey } from '../../../shared/kle/pos-key'
import { keyCenter } from './key-geometry'

export interface WirePoint {
  x: number
  y: number
}

/** A wire's label position, expressed independently of the gutter's own
 *  screen geometry: `across` is the anchor coordinate perpendicular to the
 *  gutter (the same axis `points` already carries — a row label's `y`, a
 *  col label's `x`), and `line` is which stacked gutter line the label
 *  landed on (0-based, in placement order — not necessarily draw order).
 *  The caller turns `{ across, line }` into an actual `{x, y}` once it
 *  knows the gutter's band geometry and how many lines the axis needed in
 *  total (`MatrixWiresLayout.rowLineCount` / `colLineCount`). */
export interface MatrixWireLabel {
  across: number
  line: number
}

export interface MatrixWire {
  index: number
  points: WirePoint[]
  label: MatrixWireLabel
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
  /** How many stacked lines the row-number gutter (left side) needed to
   *  keep every row label legible — 1 when no two row labels' `y`
   *  positions collided, more when several matrix rows share a physical
   *  y. Unbounded: as many lines as actually needed, never capped. */
  rowLineCount: number
  /** Same as `rowLineCount` but for the col-number gutter (top side) —
   *  how many stacked lines several matrix columns sharing a physical x
   *  needed. */
  colLineCount: number
}

/** The label gutter band `MatrixWiresOverlay` draws row/col numbers into.
 *  `left`/`top` are the band's own thickness on each side (sized by the
 *  caller, `KeyboardWidget`, to fit however many lines `rowLineCount` /
 *  `colLineCount` actually need); `originX`/`originY` are the SVG
 *  viewBox's own origin, since the gutter sits flush against it. This
 *  module never reads this type itself — it only produces the
 *  `{ across, line }` labels the overlay turns into coordinates against
 *  this geometry. */
export interface MatrixWiresGutter {
  originX: number
  originY: number
  left: number
  top: number
  fontSize: number
}

/** Col labels stack vertically (one number's height per line); row labels
 *  stack horizontally, and a two-digit row number is wider than it is
 *  tall, so its stacking pitch is wider than a col label's. Both
 *  `buildMatrixWires` (deciding which labels collide) and
 *  `MatrixWiresOverlay` (turning a line index into a screen offset) must
 *  agree on the same pitch, hence the shared helpers instead of each side
 *  hard-coding its own multiplier. */
export function rowLabelPitch(fontSize: number): number {
  return fontSize * 1.4
}

export function colLabelPitch(fontSize: number): number {
  return fontSize
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

/** Assigns each label position a stacking "line", walking the positions in
 *  ascending coordinate order rather than the caller's index order —
 *  comparing only index-adjacent neighbors misses collisions between
 *  labels whose matrix indices are far apart but whose coordinates
 *  coincide (split boards, reordered View Matrix positions). Greedy and
 *  unbounded: each label goes on the lowest-numbered line whose
 *  most-recently-placed label is at least `pitch` away, and only opens a
 *  new line when every existing line is still too close — so three or
 *  more matrix rows/cols anchored at the same physical coordinate stack
 *  onto as many lines as they need instead of the third one landing back
 *  on top of the second. The returned `lines` array is aligned back to
 *  the input's original order; `lineCount` is the total number of lines
 *  opened. */
function assignLabelLines(
  positions: readonly number[],
  pitch: number,
): { lines: number[]; lineCount: number } {
  const order = positions.map((_, index) => index).sort((a, b) => positions[a] - positions[b])
  const lines = new Array<number>(positions.length).fill(0)
  const lastOnLine: number[] = []
  for (const index of order) {
    const pos = positions[index]
    let line = lastOnLine.findIndex((last) => Math.abs(pos - last) >= pitch)
    if (line === -1) line = lastOnLine.length
    lines[index] = line
    lastOnLine[line] = pos
  }
  return { lines, lineCount: lastOnLine.length }
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
  fontSize: number,
): { wires: MatrixWire[]; lineCount: number } {
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
  const pitch = axis === 'row' ? rowLabelPitch(fontSize) : colLabelPitch(fontSize)
  const { lines, lineCount } = assignLabelLines(labelPositions, pitch)

  const wires = indices.map((index, i) => ({
    index,
    points: groups.get(index)!.map((p) => ({ x: p.x, y: p.y })),
    label: { across: labelPositions[i], line: lines[i] },
  }))
  return { wires, lineCount }
}

export function buildMatrixWires(
  visibleKeys: readonly KleKey[],
  cells: ReadonlyMap<string, { row: number; col: number }>,
  scale: number,
  fontSize: number,
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

  const { wires: rows, lineCount: rowLineCount } = buildAxisWires(placed, 'row', fontSize)
  const { wires: cols, lineCount: colLineCount } = buildAxisWires(placed, 'col', fontSize)

  return {
    rows,
    cols,
    nodes: placed.map(({ posKey, x, y }) => ({ posKey, x, y })),
    rowLineCount,
    colLineCount,
  }
}
