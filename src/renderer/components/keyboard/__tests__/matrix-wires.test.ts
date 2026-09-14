// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { buildMatrixWires, rowLabelPitch } from '../matrix-wires'
import { KEY_UNIT, KEY_SPACING } from '../constants'
import { posKey } from '../../../../shared/kle/pos-key'
import { rotatePoint } from '../../../../shared/kle/rotate-point'
import { makeKey, makeColumnStackKeys, NO_GUTTER_FONT_SIZE, IDENTITY_CELLS, loadVirtualDeviceLayout } from './kle-test-keys'

describe('buildMatrixWires — virtual device GPK60-63R fixture', () => {
  const layout = loadVirtualDeviceLayout()

  it('reflects the sparse row 4 (cols 0,1,2,4,6,7,8,9,10,11 — no 3/5/12/13)', () => {
    const keys = layout.keys
    const { rows, cols } = buildMatrixWires(keys, IDENTITY_CELLS, 1, NO_GUTTER_FONT_SIZE)

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
    const { rows } = buildMatrixWires(keys, IDENTITY_CELLS, 1, NO_GUTTER_FONT_SIZE)
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
    const { nodes } = buildMatrixWires([key], IDENTITY_CELLS, scale, NO_GUTTER_FONT_SIZE)

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
    const { nodes } = buildMatrixWires([key], IDENTITY_CELLS, 1, NO_GUTTER_FONT_SIZE)
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
    const { nodes } = buildMatrixWires(keys, IDENTITY_CELLS, 1, NO_GUTTER_FONT_SIZE)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].posKey).toBe(posKey(0, 0))
  })

  it('excludes encoder keys', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 0 }),
      makeKey({ row: -1, col: -1, x: 1, encoderIdx: 0, encoderDir: 0 }),
    ]
    const { nodes } = buildMatrixWires(keys, IDENTITY_CELLS, 1, NO_GUTTER_FONT_SIZE)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].posKey).toBe(posKey(0, 0))
  })

  it('keeps only the first key for a duplicate posKey (first wins)', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 0 }),
      makeKey({ row: 0, col: 0, x: 5 }), // same physical position, later in array
    ]
    const { nodes, rows } = buildMatrixWires(keys, IDENTITY_CELLS, 1, NO_GUTTER_FONT_SIZE)
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
    const { rows, cols } = buildMatrixWires(keys, new Map(), 1, NO_GUTTER_FONT_SIZE)
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
    const { rows } = buildMatrixWires(keys, cells, 1, NO_GUTTER_FONT_SIZE)
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
    const { rows, cols } = buildMatrixWires(keys, IDENTITY_CELLS, 1, NO_GUTTER_FONT_SIZE)
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
    const { rows, cols } = buildMatrixWires(keys, IDENTITY_CELLS, 1, NO_GUTTER_FONT_SIZE)
    expect(rows.map((r) => r.index)).toEqual([0, 1, 3])
    expect(cols.map((c) => c.index)).toEqual([0, 1, 2])
  })
})

describe('buildMatrixWires — label placement', () => {
  it('places the row label anchor at the leftmost point y, on line 0 when nothing collides', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 5, y: 0 }),
      makeKey({ row: 0, col: 1, x: 0, y: 0 }), // leftmost (x smallest), but higher col index
    ]
    const { rows } = buildMatrixWires(keys, IDENTITY_CELLS, 1, 8)
    const row0 = rows.find((r) => r.index === 0)!
    const leftMost = row0.points.reduce((min, p) => (p.x < min.x ? p : min), row0.points[0])
    expect(row0.label.line).toBe(0)
    expect(row0.label.across).toBeCloseTo(leftMost.y)
  })

  it('places the col label anchor at the topmost point x, on line 0 when nothing collides', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 5 }),
      makeKey({ row: 1, col: 0, x: 0, y: 0 }), // topmost (y smallest)
    ]
    const { cols } = buildMatrixWires(keys, IDENTITY_CELLS, 1, 8)
    const col0 = cols.find((c) => c.index === 0)!
    const topMost = col0.points.reduce((min, p) => (p.y < min.y ? p : min), col0.points[0])
    expect(col0.label.line).toBe(0)
    expect(col0.label.across).toBeCloseTo(topMost.x)
  })

  it('stacks three row labels anchored at the exact same y onto three separate lines', () => {
    // Three single-key rows, all sharing y=0 — every pair collides, so
    // each one needs its own line rather than the third landing back on
    // top of the second (the old two-line cap this replaces).
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 0 }),
      makeKey({ row: 1, col: 1, x: 1, y: 0 }),
      makeKey({ row: 2, col: 2, x: 2, y: 0 }),
    ]
    const { rows, rowLineCount } = buildMatrixWires(keys, IDENTITY_CELLS, 1, 20)
    const lines = [0, 1, 2].map((index) => rows.find((r) => r.index === index)!.label.line)
    expect(new Set(lines)).toEqual(new Set([0, 1, 2]))
    expect(rowLineCount).toBe(3)
  })

  it('stacks three col labels anchored at the exact same x onto three separate lines', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 0 }),
      makeKey({ row: 1, col: 1, x: 0, y: 1 }),
      makeKey({ row: 2, col: 2, x: 0, y: 2 }),
    ]
    const { cols, colLineCount } = buildMatrixWires(keys, IDENTITY_CELLS, 1, 20)
    const lines = [0, 1, 2].map((index) => cols.find((c) => c.index === index)!.label.line)
    expect(new Set(lines)).toEqual(new Set([0, 1, 2]))
    expect(colLineCount).toBe(3)
  })

  it('stacks the reported physical-column overlap (matrix cols 1, 3, 7 sharing one x) onto three lines', () => {
    // Regression for the user-reported gutter overlap: several matrix
    // columns anchored at the same physical column must not collapse
    // their third label back onto the second.
    const keys = makeColumnStackKeys()
    const { cols, colLineCount } = buildMatrixWires(keys, IDENTITY_CELLS, 1, 20)
    const lines = [1, 3, 7].map((index) => cols.find((c) => c.index === index)!.label.line)
    expect(new Set(lines)).toEqual(new Set([0, 1, 2]))
    expect(colLineCount).toBe(3)
  })

  it('keeps labels farther apart than the pitch on line 0, with lineCount 1', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 0 }),
      makeKey({ row: 1, col: 0, x: 0, y: 5 }),
    ]
    const { rows, rowLineCount } = buildMatrixWires(keys, IDENTITY_CELLS, 1, 8)
    expect(rows[0].label.line).toBe(0)
    expect(rows[1].label.line).toBe(0)
    expect(rowLineCount).toBe(1)
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
    const { rows } = buildMatrixWires(keys, IDENTITY_CELLS, 1, 10)
    const row0 = rows.find((r) => r.index === 0)!
    const row1 = rows.find((r) => r.index === 1)!
    const row2 = rows.find((r) => r.index === 2)!
    expect(row0.label.line).toBe(0)
    expect(row1.label.line).toBe(0)
    expect(row2.label.line).toBe(1)
  })

  it('resolves three close labels onto at most two lines without two same-line labels colliding', () => {
    // fontSize 10 => row pitch 14px. Adjacent pairs (rows 0/1 and 1/2, 8px
    // apart) are each closer than the pitch, but the head and tail (rows
    // 0/2, 16px apart) are not — the walk should keep row 0 and row 2
    // together on line 0 rather than spilling row 2 onto line 1 too.
    const fontSize = 10
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 0 }),
      makeKey({ row: 1, col: 0, x: 0, y: 8 / KEY_UNIT }),
      makeKey({ row: 2, col: 0, x: 0, y: 16 / KEY_UNIT }),
    ]
    const { rows, rowLineCount } = buildMatrixWires(keys, IDENTITY_CELLS, 1, fontSize)
    const row0 = rows.find((r) => r.index === 0)!
    const row1 = rows.find((r) => r.index === 1)!
    const row2 = rows.find((r) => r.index === 2)!

    expect(rowLineCount).toBeLessThanOrEqual(2)
    expect(row0.label.line).toBe(row2.label.line)
    expect(row1.label.line).not.toBe(row0.label.line)
    // Row 0 and row 2 share a line but their actual y positions are
    // farther apart than the row pitch, so they don't visually collide.
    expect(Math.abs(row0.label.across - row2.label.across)).toBeGreaterThanOrEqual(rowLabelPitch(fontSize))
  })
})
