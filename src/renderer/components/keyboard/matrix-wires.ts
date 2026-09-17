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
// A col wire can carry more than one label: the keys in the physical top
// row get their column number above them, so a split board sharing
// columns across both halves shows the number over both (see
// computeTopRowPosKeys).

import type { KleKey } from '../../../shared/kle/types'
import { posKey } from '../../../shared/kle/pos-key'
import { clusterRowsByY } from '../../../shared/kle/kle-ergonomics'
import { keyCenter } from './key-geometry'

export interface WirePoint {
  x: number
  y: number
}

/** A wire's label position, expressed independently of the gutter's own
 *  screen geometry: `across` is the anchor coordinate perpendicular to the
 *  gutter (the same axis `points` already carries — a row label's `y`, a
 *  col label's `x`), and `line` is which stacked gutter line the label
 *  landed on (0-based; assigned in ascending wire-index order, so two
 *  colliding labels always keep the lower index on the lower line).
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
  /** Row wires always carry exactly one label. Col wires carry one per
   *  physical top-row key on this wire (plus the wire's own anchor when it
   *  isn't one of them), minus any closer together than the label pitch —
   *  see `buildAxisWires`. Sorted ascending by `across`. */
  labels: MatrixWireLabel[]
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
   *  keep every row label legible — 0 when the axis has no wires at all,
   *  1 when no two row labels' `y` positions collided, more when several
   *  matrix rows share a physical y. Unbounded: as many lines as
   *  actually needed, never capped. */
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

/** Assigns each label position a stacking "line", walking positions in the
 *  caller's own ascending wire-index order (not coordinate order) and
 *  comparing each label against every earlier one, not just its
 *  immediate neighbor — that still catches a collision between far-apart
 *  indices whose coordinates coincide (split boards, reordered View
 *  Matrix positions). Each label lands one line past the highest line of
 *  any earlier label within `pitch` of it (line 0 when it collides with
 *  none), so it never drops back to or below the line of a label it
 *  collides with — though it may still share a line with labels it
 *  doesn't collide with.
 *
 *  Two guarantees follow: two labels sharing a line are never closer than
 *  `pitch`, and for any colliding pair the lower index always lands on
 *  the lower line — immune to a sub-pixel coordinate difference (e.g. two
 *  split-board thumb rows whose rotated anchors differ by a fraction of a
 *  pixel) flipping that order. The trade-off is that a chain of collisions
 *  spends one line per link instead of dropping back onto a line that
 *  looks free, and the gutter grows to fit `lineCount` — e.g. positions
 *  `[0, 8, 16]` with `pitch` 14 use 3 lines, not the 2 a reuse strategy
 *  could pack them into.
 *
 *  `lines` is aligned to the input order; `lineCount` is one past the
 *  highest line opened, 0 when `positions` is empty. */
function assignLabelLines(
  positions: readonly number[],
  pitch: number,
): { lines: number[]; lineCount: number } {
  const lines = new Array<number>(positions.length).fill(0)
  let lineCount = 0
  for (let i = 0; i < positions.length; i++) {
    let line = 0
    for (let j = 0; j < i; j++) {
      if (Math.abs(positions[i] - positions[j]) < pitch) {
        line = Math.max(line, lines[j] + 1)
      }
    }
    lines[i] = line
    lineCount = Math.max(lineCount, line + 1)
  }
  return { lines, lineCount }
}

/** The posKeys of the physical top row — the keys that get a column number
 *  above them. "Top row" is `clusterRowsByY`'s first cluster, deliberately
 *  taken from the unrotated layout grid: a half rotated as a rigid block
 *  keeps its own top row there, whereas its rotated y ranges overlap the
 *  row below and would chain every row together. It is a heuristic — a
 *  column-stagger chain can pull in a second physical row (extra but
 *  correctly numbered labels), and a low-sitting top-row key can fall out
 *  (its column still gets the anchor label). `wiredKeys` must be the same
 *  deduped list `placed` is built from. */
function computeTopRowPosKeys(wiredKeys: KleKey[]): Set<string> {
  const topRow = clusterRowsByY(wiredKeys)[0] ?? []
  return new Set(topRow.map((key) => posKey(key.row, key.col)))
}

/** Builds one axis's wires (row or col) from the same placed-key list.
 *  Row wires group by effective row, order members left-to-right (x),
 *  and anchor their label at the leftmost member's y; col wires are the
 *  mirror image, grouping by effective col, ordering top-to-bottom (y),
 *  anchoring at the topmost member's x. `along` is both the ordering
 *  tie-break axis and the axis used to find each wire's label anchor
 *  (the member nearest the gutter); `across` is the anchor's other
 *  coordinate, which becomes a label's fixed position along the wire.
 *
 *  Each wire gets one label per candidate in `[anchor, ...members in
 *  extraAnchors, ascending across]` that survives a pitch-distance dedup
 *  against every already-kept candidate (not just the previous one —
 *  closeness isn't transitive: candidates at 0, 0.75 pitch and 1.5 pitch
 *  must keep both ends when 0 is the anchor). `buildMatrixWires` passes
 *  the physical top row as `extraAnchors` for the col axis, and nothing
 *  for the row axis. */
function buildAxisWires(
  placed: readonly PlacedKey[],
  axis: 'row' | 'col',
  fontSize: number,
  extraAnchors?: ReadonlySet<string>,
): { wires: MatrixWire[]; lineCount: number } {
  const groupBy = axis === 'row' ? (p: PlacedKey) => p.effectiveRow : (p: PlacedKey) => p.effectiveCol
  const orderBy = axis === 'row' ? (p: PlacedKey) => p.effectiveCol : (p: PlacedKey) => p.effectiveRow
  const along = axis === 'row' ? (p: PlacedKey) => p.x : (p: PlacedKey) => p.y
  const across = axis === 'row' ? (p: PlacedKey) => p.y : (p: PlacedKey) => p.x

  const groups = groupAndOrder(placed, groupBy, orderBy, along)
  // Ascending order here is what assignLabelLines relies on to keep
  // colliding labels in index order (lower index -> lower line).
  const indices = [...groups.keys()].sort((a, b) => a - b)
  const pitch = axis === 'row' ? rowLabelPitch(fontSize) : colLabelPitch(fontSize)

  const keptAcrossByWire = indices.map((index) => {
    const members = groups.get(index)!
    const anchor = members.reduce((min, p) => (along(p) < along(min) ? p : min), members[0])
    const candidates = [
      anchor,
      ...members.filter((p) => extraAnchors?.has(p.posKey) ?? false).sort((a, b) => across(a) - across(b)),
    ]
    const kept: number[] = []
    for (const candidate of candidates) {
      const value = across(candidate)
      if (kept.some((k) => Math.abs(k - value) < pitch)) continue
      kept.push(value)
    }
    return kept.sort((a, b) => a - b)
  })

  // keptAcrossByWire is already ordered (wire index ascending, across
  // ascending within each wire); flat() preserves that order so a
  // collision between two different wires' labels still keeps the lower
  // wire index on the lower line.
  const { lines, lineCount } = assignLabelLines(keptAcrossByWire.flat(), pitch)

  let cursor = 0
  const wires = indices.map((index, i) => {
    const kept = keptAcrossByWire[i]
    const labels = kept.map((value, k) => ({ across: value, line: lines[cursor + k] }))
    cursor += kept.length
    return { index, points: groups.get(index)!.map((p) => ({ x: p.x, y: p.y })), labels }
  })
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
  const wiredKeys: KleKey[] = []

  for (const key of visibleKeys) {
    if (key.decal || key.encoderIdx >= 0) continue
    const pos = posKey(key.row, key.col)
    if (seen.has(pos)) continue
    seen.add(pos)

    wiredKeys.push(key)
    const center = keyCenter(key, scale)
    const effective = cells.get(pos) ?? { row: key.row, col: key.col }
    placed.push({ posKey: pos, effectiveRow: effective.row, effectiveCol: effective.col, ...center })
  }

  const topRow = computeTopRowPosKeys(wiredKeys)
  const { wires: rows, lineCount: rowLineCount } = buildAxisWires(placed, 'row', fontSize)
  const { wires: cols, lineCount: colLineCount } = buildAxisWires(placed, 'col', fontSize, topRow)

  return {
    rows,
    cols,
    nodes: placed.map(({ posKey, x, y }) => ({ posKey, x, y })),
    rowLineCount,
    colLineCount,
  }
}
