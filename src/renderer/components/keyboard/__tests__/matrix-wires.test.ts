// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { buildMatrixWires, rowLabelPitch } from '../matrix-wires'
import { KEY_UNIT, KEY_SPACING } from '../constants'
import { posKey } from '../../../../shared/kle/pos-key'
import { rotatePoint } from '../../../../shared/kle/rotate-point'
import {
  makeKey,
  makeColumnStackKeys,
  NO_GUTTER_FONT_SIZE,
  IDENTITY_CELLS,
  loadVirtualDeviceLayout,
  loadSplitThumbLayout,
} from './kle-test-keys'

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
    expect(lines).toEqual([0, 1, 2])
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
    expect(lines).toEqual([0, 1, 2])
    expect(colLineCount).toBe(3)
  })

  it('stacks the reported physical-column overlap (matrix cols 1, 3, 7 sharing one x) onto three lines', () => {
    // Regression for the user-reported gutter overlap: several matrix
    // columns anchored at the same physical column must not collapse
    // their third label back onto the second.
    const keys = makeColumnStackKeys()
    const { cols, colLineCount } = buildMatrixWires(keys, IDENTITY_CELLS, 1, 20)
    const lines = [1, 3, 7].map((index) => cols.find((c) => c.index === index)!.label.line)
    expect(lines).toEqual([0, 1, 2])
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

  it('detects a collision between far-apart indices whose positions coincide, not just adjacent-index neighbors', () => {
    // Row 0 and row 2 share the same y (0); row 1 sits a full key unit
    // away in between them index-wise. An index-adjacent-only comparison
    // would only check row0-vs-row1 and row1-vs-row2 (neither collides),
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

  it('walks a chain of overlapping labels into an ascending staircase of lines', () => {
    // fontSize 10 => row pitch 14px. Adjacent pairs (rows 0/1 and 1/2, 8px
    // apart) each collide, but the head and tail (rows 0/2, 16px apart) do
    // not. Reusing row 0's now-free line for row 2 would still break the
    // ascending-index guarantee here: lowest-free-line reuse gives lines
    // [0, 1, 0], putting the colliding pair rows 1 and 2 in descending
    // order (row 1 on line 1, row 2 on line 0). Placing each label one
    // line past the highest line any colliding predecessor used avoids
    // that, so the chain climbs in a strict staircase.
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

    expect(row0.label.line).toBe(0)
    expect(row1.label.line).toBe(1)
    expect(row2.label.line).toBe(2)
    expect(rowLineCount).toBe(3)
  })

  it('does not treat labels exactly one pitch apart as colliding', () => {
    const fontSize = 10
    const pitch = rowLabelPitch(fontSize)
    // height: 0 keeps each key's across-anchor a plain `s * y` (keyCenter's
    // `+ height / 2` term would otherwise add a rounding step that lands
    // the two anchors a hair off `pitch`, breaking the exact-boundary
    // premise this test pins below).
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 0, height: 0 }),
      makeKey({ row: 1, col: 0, x: 0, y: pitch / KEY_UNIT, height: 0 }),
    ]
    const { rows, rowLineCount } = buildMatrixWires(keys, IDENTITY_CELLS, 1, fontSize)
    const row0 = rows.find((r) => r.index === 0)!
    const row1 = rows.find((r) => r.index === 1)!
    // Pin the premise: the two anchors really are exactly one pitch apart,
    // so a future change to the pitch constant can't silently turn this
    // into a just-over/just-under test without failing here first.
    expect(Math.abs(row0.label.across - row1.label.across)).toBe(pitch)
    expect(row0.label.line).toBe(0)
    expect(row1.label.line).toBe(0)
    expect(rowLineCount).toBe(1)
  })

  it('reports zero lines on both axes when there are no keys', () => {
    const { rowLineCount, colLineCount } = buildMatrixWires([], IDENTITY_CELLS, 1, 12)
    expect(rowLineCount).toBe(0)
    expect(colLineCount).toBe(0)
  })

  it('keeps a sub-pixel row-coordinate difference from deciding which of two colliding row labels lands to the left', () => {
    // Row 7's anchor y is a fraction of a pixel smaller than row 3's.
    // Walking labels in coordinate order would let row 7's slightly
    // smaller y claim line 0 first; walking in index order keeps row 3
    // (the lower index) on the lower line regardless of which one sits
    // fractionally higher.
    const keys = [
      makeKey({ row: 3, col: 0, x: 0, y: 3 }),
      makeKey({ row: 7, col: 0, x: 0, y: 3 - 0.3 / KEY_UNIT }),
    ]
    const { rows } = buildMatrixWires(keys, IDENTITY_CELLS, 1, 8)
    expect(rows.find((r) => r.index === 3)!.label.line).toBe(0)
    expect(rows.find((r) => r.index === 7)!.label.line).toBe(1)
  })

  it('keeps a sub-pixel col-coordinate difference from deciding which of two colliding col labels lands on top', () => {
    // Mirror of the row-axis case above, for the top gutter.
    const keys = [
      makeKey({ row: 0, col: 3, x: 3, y: 0 }),
      makeKey({ row: 0, col: 7, x: 3 - 0.3 / KEY_UNIT, y: 0 }),
    ]
    const { cols } = buildMatrixWires(keys, IDENTITY_CELLS, 1, 8)
    expect(cols.find((c) => c.index === 3)!.label.line).toBe(0)
    expect(cols.find((c) => c.index === 7)!.label.line).toBe(1)
  })
})

describe('buildMatrixWires — split-board label order regression', () => {
  const layout = loadSplitThumbLayout()

  it('keeps every colliding row-label pair on the split-thumb fixture in ascending index order', () => {
    // Regression guard: the fixture's thumb rows (3 and 7) have label
    // anchors a fraction of a pixel apart, which used to render row 7
    // before row 3 in the left gutter.
    const fontSize = 12
    const { rows } = buildMatrixWires(layout.keys, IDENTITY_CELLS, 1, fontSize)
    const pitch = rowLabelPitch(fontSize)

    for (const a of rows) {
      for (const b of rows) {
        if (a.index >= b.index) continue
        if (Math.abs(a.label.across - b.label.across) < pitch) {
          expect(a.label.line).toBeLessThan(b.label.line)
        }
      }
    }

    const row3 = rows.find((r) => r.index === 3)!
    const row7 = rows.find((r) => r.index === 7)!
    expect(row3.label.line).toBe(0)
    expect(row7.label.line).toBe(1)
  })
})
