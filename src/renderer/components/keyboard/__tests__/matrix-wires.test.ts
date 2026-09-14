// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { buildMatrixWires, type MatrixWiresGutter } from '../matrix-wires'
import { KEY_UNIT, KEY_SPACING } from '../constants'
import { posKey } from '../../../../shared/kle/pos-key'
import { rotatePoint } from '../../../../shared/kle/rotate-point'
import { makeKey, NO_GUTTER, IDENTITY_CELLS, loadVirtualDeviceLayout } from './kle-test-keys'

describe('buildMatrixWires — virtual device GPK60-63R fixture', () => {
  const layout = loadVirtualDeviceLayout()

  it('reflects the sparse row 4 (cols 0,1,2,4,6,7,8,9,10,11 — no 3/5/12/13)', () => {
    const keys = layout.keys
    const { rows, cols } = buildMatrixWires(keys, IDENTITY_CELLS, 1, NO_GUTTER)

    const row4 = rows.find((r) => r.index === 4)!
    expect(row4.points).toHaveLength(10)

    const row4Cols = keys
      .filter((k) => k.row === 4 && !k.decal && k.encoderIdx < 0)
      .map((k) => k.col)
      .sort((a, b) => a - b)
    expect(row4Cols).toEqual([0, 1, 2, 4, 6, 7, 8, 9, 10, 11])

    for (const gapCol of [3, 5, 12, 13]) {
      const colWire = cols.find((c) => c.index === gapCol)
      expect(colWire).toBeDefined()
      const rowsInGapCol = keys
        .filter((k) => k.col === gapCol && !k.decal && k.encoderIdx < 0)
        .map((k) => k.row)
      expect(rowsInGapCol).not.toContain(4)
    }
  })

  it('orders row 4 points by ascending column', () => {
    const keys = layout.keys
    const { rows } = buildMatrixWires(keys, IDENTITY_CELLS, 1, NO_GUTTER)
    const row4 = rows.find((r) => r.index === 4)!
    const expectedCols = [0, 1, 2, 4, 6, 7, 8, 9, 10, 11]
    const s = KEY_UNIT
    const expectedXs = expectedCols.map((col) => {
      const key = keys.find((k) => k.row === 4 && k.col === col)!
      return s * (key.x + key.width / 2) - (KEY_SPACING / 2)
    })
    expect(row4.points.map((p) => p.x)).toEqual(expectedXs)
  })
})

describe('buildMatrixWires — key center geometry', () => {
  it('matches rotatePoint for a rotated key', () => {
    const key = makeKey({
      row: 2,
      col: 3,
      x: 4,
      y: 1,
      width: 1,
      height: 1,
      rotation: 15,
      rotationX: 4.5,
      rotationY: 1.5,
    })
    const scale = 1
    const { nodes } = buildMatrixWires([key], IDENTITY_CELLS, scale, NO_GUTTER)

    const s = KEY_UNIT * scale
    const spacing = KEY_SPACING * scale
    const cx = s * (key.x + key.width / 2) - spacing / 2
    const cy = s * (key.y + key.height / 2) - spacing / 2
    const [ex, ey] = rotatePoint(cx, cy, key.rotation, s * key.rotationX, s * key.rotationY)

    expect(nodes).toHaveLength(1)
    expect(nodes[0].x).toBeCloseTo(ex)
    expect(nodes[0].y).toBeCloseTo(ey)
  })

  it('uses the main rect center for stepped/ISO keys (ignores the secondary rect)', () => {
    const key = makeKey({
      row: 0,
      col: 0,
      x: 0,
      y: 0,
      width: 1.25,
      height: 1,
      x2: 0.25,
      y2: 0,
      width2: 1,
      height2: 2,
    })
    const { nodes } = buildMatrixWires([key], IDENTITY_CELLS, 1, NO_GUTTER)
    const s = KEY_UNIT
    const spacing = KEY_SPACING
    expect(nodes[0].x).toBeCloseTo(s * (0 + 1.25 / 2) - spacing / 2)
    expect(nodes[0].y).toBeCloseTo(s * (0 + 1 / 2) - spacing / 2)
  })
})

describe('buildMatrixWires — exclusions and dedup', () => {
  it('excludes decal keys', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 0 }),
      makeKey({ row: 0, col: 1, x: 1, decal: true }),
    ]
    const { nodes } = buildMatrixWires(keys, IDENTITY_CELLS, 1, NO_GUTTER)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].posKey).toBe(posKey(0, 0))
  })

  it('excludes encoder keys', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 0 }),
      makeKey({ row: -1, col: -1, x: 1, encoderIdx: 0, encoderDir: 0 }),
    ]
    const { nodes } = buildMatrixWires(keys, IDENTITY_CELLS, 1, NO_GUTTER)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].posKey).toBe(posKey(0, 0))
  })

  it('keeps only the first key for a duplicate posKey (first wins)', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 0 }),
      makeKey({ row: 0, col: 0, x: 5 }), // same physical position, later in array
    ]
    const { nodes, rows } = buildMatrixWires(keys, IDENTITY_CELLS, 1, NO_GUTTER)
    expect(nodes).toHaveLength(1)
    const s = KEY_UNIT
    const spacing = KEY_SPACING
    expect(nodes[0].x).toBeCloseTo(s * 0.5 - spacing / 2)
    expect(rows.find((r) => r.index === 0)!.points).toHaveLength(1)
  })
})

describe('buildMatrixWires — effective position (View Matrix override)', () => {
  it('falls back to the physical position when a key is missing from cells', () => {
    const keys = [makeKey({ row: 2, col: 5, x: 0, y: 0 })]
    const { rows, cols } = buildMatrixWires(keys, new Map(), 1, NO_GUTTER)
    expect(rows.map((r) => r.index)).toEqual([2])
    expect(cols.map((c) => c.index)).toEqual([5])
  })

  it('groups/orders by the overridden effective position, not the physical one', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 0 }),
      makeKey({ row: 1, col: 1, x: 1 }),
    ]
    // Override both keys onto the same effective row 9, with key(1,1)'s
    // effective col (0) placed before key(0,0)'s effective col (1) —
    // the reverse of their physical/array order.
    const cells = new Map<string, { row: number; col: number }>([
      [posKey(0, 0), { row: 9, col: 1 }],
      [posKey(1, 1), { row: 9, col: 0 }],
    ])
    const { rows } = buildMatrixWires(keys, cells, 1, NO_GUTTER)
    expect(rows).toHaveLength(1)
    expect(rows[0].index).toBe(9)
    // Ordered by effective col ascending: (1,1)->col0 first, (0,0)->col1 second.
    expect(rows[0].points).toHaveLength(2)
    const s = KEY_UNIT
    const spacing = KEY_SPACING
    expect(rows[0].points[0].x).toBeCloseTo(s * 1.5 - spacing / 2) // key (1,1) at x=1
    expect(rows[0].points[1].x).toBeCloseTo(s * 0.5 - spacing / 2) // key (0,0) at x=0
  })
})

describe('buildMatrixWires — single-point wires', () => {
  it('keeps a wire with a single member (points.length === 1)', () => {
    const keys = [makeKey({ row: 0, col: 0, x: 0 })]
    const { rows, cols } = buildMatrixWires(keys, IDENTITY_CELLS, 1, NO_GUTTER)
    expect(rows).toHaveLength(1)
    expect(rows[0].points).toHaveLength(1)
    expect(cols).toHaveLength(1)
    expect(cols[0].points).toHaveLength(1)
  })
})

describe('buildMatrixWires — row/col ordering of output arrays', () => {
  it('returns rows and cols sorted by index ascending', () => {
    const keys = [
      makeKey({ row: 3, col: 0, x: 0, y: 3 }),
      makeKey({ row: 0, col: 2, x: 2, y: 0 }),
      makeKey({ row: 1, col: 1, x: 1, y: 1 }),
    ]
    const { rows, cols } = buildMatrixWires(keys, IDENTITY_CELLS, 1, NO_GUTTER)
    expect(rows.map((r) => r.index)).toEqual([0, 1, 3])
    expect(cols.map((c) => c.index)).toEqual([0, 1, 2])
  })
})

describe('buildMatrixWires — label placement', () => {
  it('places the row label at the leftmost point y, line 0 (fontSize/2 above gutter center)', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 5, y: 0 }),
      makeKey({ row: 0, col: 1, x: 0, y: 0 }), // leftmost (x smallest), but higher col index
    ]
    const gutter: MatrixWiresGutter = { originX: -20, originY: -20, size: 16, fontSize: 8 }
    const { rows } = buildMatrixWires(keys, IDENTITY_CELLS, 1, gutter)
    const row0 = rows.find((r) => r.index === 0)!
    const leftMost = row0.points.reduce((min, p) => (p.x < min.x ? p : min), row0.points[0])
    expect(row0.label.x).toBeCloseTo(gutter.originX + gutter.size / 2 - gutter.fontSize / 2)
    expect(row0.label.y).toBeCloseTo(leftMost.y)
  })

  it('places the col label at the topmost point x, line 0 (fontSize/2 left of gutter center)', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 5 }),
      makeKey({ row: 1, col: 0, x: 0, y: 0 }), // topmost (y smallest)
    ]
    const gutter: MatrixWiresGutter = { originX: -20, originY: -20, size: 16, fontSize: 8 }
    const { cols } = buildMatrixWires(keys, IDENTITY_CELLS, 1, gutter)
    const col0 = cols.find((c) => c.index === 0)!
    const topMost = col0.points.reduce((min, p) => (p.y < min.y ? p : min), col0.points[0])
    expect(col0.label.y).toBeCloseTo(gutter.originY + gutter.size / 2 - gutter.fontSize / 2)
    expect(col0.label.x).toBeCloseTo(topMost.x)
  })

  it('moves overlapping row labels onto a second line, capping at two lines even when all three overlap the first', () => {
    // Three single-key rows stacked so close together (0.05u apart) that
    // every pair's label y — not just consecutive ones — is closer than
    // fontSize, so rows 1 and 2 both end up on line 1 once row 0 claims
    // line 0 (two lines is the cap; see matrix-wires.ts's assignLabelLines).
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 0 }),
      makeKey({ row: 1, col: 0, x: 0, y: 0.05 }),
      makeKey({ row: 2, col: 0, x: 0, y: 0.1 }),
    ]
    const gutter: MatrixWiresGutter = { originX: -20, originY: -20, size: 16, fontSize: 20 }
    const { rows } = buildMatrixWires(keys, IDENTITY_CELLS, 1, gutter)
    const center = gutter.originX + gutter.size / 2
    const line0X = center - gutter.fontSize / 2
    const line1X = center + gutter.fontSize / 2
    expect(rows[0].label.x).toBeCloseTo(line0X)
    expect(rows[1].label.x).toBeCloseTo(line1X)
    expect(rows[2].label.x).toBeCloseTo(line1X)
  })

  it('moves overlapping col labels onto a second line, capping at two lines even when all three overlap the first', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 0 }),
      makeKey({ row: 0, col: 1, x: 0.05, y: 0 }),
      makeKey({ row: 0, col: 2, x: 0.1, y: 0 }),
    ]
    const gutter: MatrixWiresGutter = { originX: -20, originY: -20, size: 16, fontSize: 20 }
    const { cols } = buildMatrixWires(keys, IDENTITY_CELLS, 1, gutter)
    const center = gutter.originY + gutter.size / 2
    const line0Y = center - gutter.fontSize / 2
    const line1Y = center + gutter.fontSize / 2
    expect(cols[0].label.y).toBeCloseTo(line0Y)
    expect(cols[1].label.y).toBeCloseTo(line1Y)
    expect(cols[2].label.y).toBeCloseTo(line1Y)
  })

  it('does not offset labels that are farther apart than fontSize (both stay on line 0)', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 0 }),
      makeKey({ row: 1, col: 0, x: 0, y: 5 }),
    ]
    const gutter: MatrixWiresGutter = { originX: -20, originY: -20, size: 16, fontSize: 8 }
    const { rows } = buildMatrixWires(keys, IDENTITY_CELLS, 1, gutter)
    const line0X = gutter.originX + gutter.size / 2 - gutter.fontSize / 2
    expect(rows[0].label.x).toBeCloseTo(line0X)
    expect(rows[1].label.x).toBeCloseTo(line0X)
  })

  it('places labels by coordinate order, not index order, so far-apart indices with coinciding positions still collide', () => {
    // Row 0 and row 2 share the same y (0); row 1 sits a full key unit
    // away in between them index-wise. An index-adjacent comparison would
    // only ever check row0-vs-row1 and row1-vs-row2 (neither collides),
    // missing that row 0 and row 2 land on the exact same position.
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 0 }),
      makeKey({ row: 1, col: 0, x: 0, y: 1 }),
      makeKey({ row: 2, col: 0, x: 0, y: 0 }),
    ]
    const gutter: MatrixWiresGutter = { originX: -20, originY: -20, size: 16, fontSize: 10 }
    const { rows } = buildMatrixWires(keys, IDENTITY_CELLS, 1, gutter)
    const center = gutter.originX + gutter.size / 2
    const row0 = rows.find((r) => r.index === 0)!
    const row1 = rows.find((r) => r.index === 1)!
    const row2 = rows.find((r) => r.index === 2)!
    expect(row0.label.x).toBeCloseTo(center - gutter.fontSize / 2)
    expect(row1.label.x).toBeCloseTo(center - gutter.fontSize / 2)
    expect(row2.label.x).toBeCloseTo(center + gutter.fontSize / 2)
  })

  it('resolves three close labels onto at most two lines without two same-line labels colliding', () => {
    // Adjacent pairs (rows 0/1 and 1/2, 0.1u ~ 5.4px apart) are each
    // closer than fontSize, but the head and tail (rows 0/2, ~10.8px
    // apart) are not — the walk should keep row 0 and row 2 together on
    // line 0 rather than spilling row 2 onto line 1 too.
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 0 }),
      makeKey({ row: 1, col: 0, x: 0, y: 0.1 }),
      makeKey({ row: 2, col: 0, x: 0, y: 0.2 }),
    ]
    const gutter: MatrixWiresGutter = { originX: -20, originY: -20, size: 16, fontSize: 8 }
    const { rows } = buildMatrixWires(keys, IDENTITY_CELLS, 1, gutter)
    const row0 = rows.find((r) => r.index === 0)!
    const row1 = rows.find((r) => r.index === 1)!
    const row2 = rows.find((r) => r.index === 2)!

    const lines = new Set([row0.label.x, row1.label.x, row2.label.x])
    expect(lines.size).toBeLessThanOrEqual(2)
    expect(row0.label.x).toBeCloseTo(row2.label.x)
    expect(row1.label.x).not.toBeCloseTo(row0.label.x)
    // Row 0 and row 2 share a line but their actual y positions are
    // farther apart than fontSize, so they don't visually collide.
    expect(Math.abs(row0.label.y - row2.label.y)).toBeGreaterThanOrEqual(gutter.fontSize)
  })
})
