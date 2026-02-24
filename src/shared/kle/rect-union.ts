// SPDX-License-Identifier: GPL-2.0-or-later
// Compute the SVG path for the boolean union of two axis-aligned rounded rectangles.
// Equivalent to QPainterPath.united() used in the Python Vial GUI reference.

// Direction vectors: 0=right, 1=down, 2=left, 3=up
const STEP_COL = [1, 0, -1, 0]
const STEP_ROW = [0, 1, 0, -1]

// Interior/exterior cell offsets for each direction (clockwise, interior on right).
// For direction d from grid vertex (col, row):
//   interior cell must be filled, exterior cell must be empty.
const INTERIOR_OFFSET: [number, number][] = [
  [0, 0], // right: cell(col,   row)
  [-1, 0], // down:  cell(col-1, row)
  [-1, -1], // left:  cell(col-1, row-1)
  [0, -1], // up:    cell(col,   row-1)
]
const EXTERIOR_OFFSET: [number, number][] = [
  [0, -1], // right: cell(col,   row-1)
  [0, 0], // down:  cell(col,   row)
  [-1, 0], // left:  cell(col-1, row)
  [-1, -1], // up:    cell(col-1, row-1)
]

// Turn priorities: right turn, straight, left turn, U-turn
const TURN_ORDER = [1, 0, 3, 2]

/**
 * Compute the clockwise-ordered boundary vertices of the union of two
 * overlapping axis-aligned rectangles using grid-based contour tracing.
 *
 * Returns an empty array if the rectangles do not overlap.
 */
export function computeUnionPolygon(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): [number, number][] {
  const r1l = ax
  const r1t = ay
  const r1r = ax + aw
  const r1b = ay + ah
  const r2l = bx
  const r2t = by
  const r2r = bx + bw
  const r2b = by + bh

  if (r1r <= r2l || r2r <= r1l || r1b <= r2t || r2b <= r1t) return []

  // Unique sorted grid-line coordinates
  const xs = [...new Set([r1l, r1r, r2l, r2r])].sort((a, b) => a - b)
  const ys = [...new Set([r1t, r1b, r2t, r2b])].sort((a, b) => a - b)
  const cols = xs.length - 1
  const rows = ys.length - 1

  const filled = (c: number, r: number): boolean => {
    if (c < 0 || c >= cols || r < 0 || r >= rows) return false
    const mx = (xs[c] + xs[c + 1]) / 2
    const my = (ys[r] + ys[r + 1]) / 2
    return (
      (mx > r1l && mx < r1r && my > r1t && my < r1b) ||
      (mx > r2l && mx < r2r && my > r2t && my < r2b)
    )
  }

  // Find the starting edge: the topmost horizontal boundary going right
  let startCol = -1
  let startRow = -1
  for (let r = 0; r < rows && startCol === -1; r++) {
    for (let c = 0; c < cols; c++) {
      if (filled(c, r) && !filled(c, r - 1)) {
        startCol = c
        startRow = r
        break
      }
    }
  }
  if (startCol === -1) return []

  const raw: [number, number][] = []
  let col = startCol
  let row = startRow
  let dir = 0

  do {
    raw.push([xs[col], ys[row]])

    let moved = false
    for (const turn of TURN_ORDER) {
      const nd = (dir + turn) % 4
      const [ic, ir] = INTERIOR_OFFSET[nd]
      const [ec, er] = EXTERIOR_OFFSET[nd]
      if (filled(col + ic, row + ir) && !filled(col + ec, row + er)) {
        dir = nd
        col += STEP_COL[nd]
        row += STEP_ROW[nd]
        moved = true
        break
      }
    }
    if (!moved) break
  } while (
    !(col === startCol && row === startRow) &&
    raw.length < (cols + rows) * 4
  )

  return removeCollinear(raw)
}

function removeCollinear(verts: [number, number][]): [number, number][] {
  const n = verts.length
  if (n <= 3) return verts
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const prev = verts[(i - 1 + n) % n]
    const curr = verts[i]
    const next = verts[(i + 1) % n]
    const cross =
      (curr[0] - prev[0]) * (next[1] - curr[1]) -
      (curr[1] - prev[1]) * (next[0] - curr[0])
    if (Math.abs(cross) > 1e-10) out.push(curr)
  }
  return out
}

interface CornerArc {
  sx: number
  sy: number
  ex: number
  ey: number
  r: number
}

/**
 * Convert an ordered polygon (clockwise, screen coords) to an SVG path string
 * with rounded arcs at convex (outer) corners.
 */
export function polygonToSvgPath(
  vertices: [number, number][],
  r: number,
): string {
  const n = vertices.length
  if (n < 3) return ''

  const arcs: CornerArc[] = vertices.map((curr, i) => {
    const prev = vertices[(i - 1 + n) % n]
    const next = vertices[(i + 1) % n]

    const dx1 = curr[0] - prev[0]
    const dy1 = curr[1] - prev[1]
    const len1 = Math.hypot(dx1, dy1)

    const dx2 = next[0] - curr[0]
    const dy2 = next[1] - curr[1]
    const len2 = Math.hypot(dx2, dy2)

    // Cross product > 0 means right turn (convex) in screen coords (y-down)
    const isConvex = dx1 * dy2 - dy1 * dx2 > 0
    const maxR = Math.min(len1, len2) / 2
    const actualR = isConvex ? Math.min(r, maxR) : 0

    if (actualR <= 0) {
      return { sx: curr[0], sy: curr[1], ex: curr[0], ey: curr[1], r: 0 }
    }
    return {
      sx: curr[0] - (dx1 / len1) * actualR,
      sy: curr[1] - (dy1 / len1) * actualR,
      ex: curr[0] + (dx2 / len2) * actualR,
      ey: curr[1] + (dy2 / len2) * actualR,
      r: actualR,
    }
  })

  // Build SVG path starting at arc-end of vertex 0
  const parts: string[] = [`M ${arcs[0].ex} ${arcs[0].ey}`]
  for (let i = 1; i <= n; i++) {
    const a = arcs[i % n]
    parts.push(`L ${a.sx} ${a.sy}`)
    if (a.r > 0) {
      parts.push(`A ${a.r} ${a.r} 0 0 1 ${a.ex} ${a.ey}`)
    }
  }
  parts.push('Z')

  return parts.join(' ')
}

/**
 * Shrink an axis-aligned polygon (all right-angle turns) inward by `inset`.
 * Assumes clockwise winding in screen coordinates (y-down, interior on right).
 */
export function insetAxisAlignedPolygon(
  verts: [number, number][],
  inset: number,
): [number, number][] {
  if (inset === 0) return verts
  const n = verts.length
  return verts.map((v, i) => {
    const prev = verts[(i - 1 + n) % n]
    const next = verts[(i + 1) % n]
    const dxIn = Math.sign(v[0] - prev[0])
    const dyIn = Math.sign(v[1] - prev[1])
    const dxOut = Math.sign(next[0] - v[0])
    const dyOut = Math.sign(next[1] - v[1])
    // CW inward normal = (-dy, dx); incoming edge determines one axis offset,
    // outgoing edge determines the other.
    let ox = 0
    let oy = 0
    if (dxIn !== 0) oy = dxIn * inset
    else ox = -dyIn * inset
    if (dxOut !== 0) oy = dxOut * inset
    else ox = -dyOut * inset
    return [v[0] + ox, v[1] + oy]
  })
}

/**
 * Compute a single SVG path representing the union of two overlapping
 * rounded rectangles, optionally inset by a uniform amount.
 * Returns an empty string if they don't overlap.
 */
export function computeUnionPath(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  cornerRadius: number,
  inset = 0,
): string {
  const verts = computeUnionPolygon(ax, ay, aw, ah, bx, by, bw, bh)
  if (verts.length === 0) return ''
  return polygonToSvgPath(insetAxisAlignedPolygon(verts, inset), cornerRadius)
}
