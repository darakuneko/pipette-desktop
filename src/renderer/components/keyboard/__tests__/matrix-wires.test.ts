// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { buildMatrixWires, rowLabelPitch, colLabelPitch } from '../matrix-wires'
import { KEY_UNIT, KEY_SPACING } from '../constants'
import { posKey } from '../../../../shared/kle/pos-key'
import { rotatePoint } from '../../../../shared/kle/rotate-point'
import { parseKle } from '../../../../shared/kle'
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

  it('gives every col wire exactly one label on this single-piece board', () => {
    // Regression: the top-row rule must not double up labels on a board
    // whose topmost physical row already coincides with every column's
    // own topmost member.
    const { cols } = buildMatrixWires(layout.keys, IDENTITY_CELLS, 1, NO_GUTTER_FONT_SIZE)
    for (const col of cols) {
      expect(col.labels).toHaveLength(1)
    }
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
    expect(row0.labels).toHaveLength(1)
    expect(row0.labels[0].line).toBe(0)
    expect(row0.labels[0].across).toBeCloseTo(leftMost.y)
  })

  it('places the col label anchor at the topmost point x, on line 0 when nothing collides', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 5 }),
      makeKey({ row: 1, col: 0, x: 0, y: 0 }), // topmost (y smallest)
    ]
    const { cols } = buildMatrixWires(keys, IDENTITY_CELLS, 1, 8)
    const col0 = cols.find((c) => c.index === 0)!
    const topMost = col0.points.reduce((min, p) => (p.y < min.y ? p : min), col0.points[0])
    expect(col0.labels).toHaveLength(1)
    expect(col0.labels[0].line).toBe(0)
    expect(col0.labels[0].across).toBeCloseTo(topMost.x)
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
    const lines = [0, 1, 2].map((index) => rows.find((r) => r.index === index)!.labels[0].line)
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
    const lines = [0, 1, 2].map((index) => cols.find((c) => c.index === index)!.labels[0].line)
    expect(lines).toEqual([0, 1, 2])
    expect(colLineCount).toBe(3)
  })

  it('stacks the reported physical-column overlap (matrix cols 1, 3, 7 sharing one x) onto three lines', () => {
    // Regression for the user-reported gutter overlap: several matrix
    // columns anchored at the same physical column must not collapse
    // their third label back onto the second.
    const keys = makeColumnStackKeys()
    const { cols, colLineCount } = buildMatrixWires(keys, IDENTITY_CELLS, 1, 20)
    const lines = [1, 3, 7].map((index) => cols.find((c) => c.index === index)!.labels[0].line)
    expect(lines).toEqual([0, 1, 2])
    expect(colLineCount).toBe(3)
  })

  it('keeps labels farther apart than the pitch on line 0, with lineCount 1', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 0 }),
      makeKey({ row: 1, col: 0, x: 0, y: 5 }),
    ]
    const { rows, rowLineCount } = buildMatrixWires(keys, IDENTITY_CELLS, 1, 8)
    expect(rows[0].labels[0].line).toBe(0)
    expect(rows[1].labels[0].line).toBe(0)
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
    expect(row0.labels[0].line).toBe(0)
    expect(row1.labels[0].line).toBe(0)
    expect(row2.labels[0].line).toBe(1)
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

    expect(row0.labels[0].line).toBe(0)
    expect(row1.labels[0].line).toBe(1)
    expect(row2.labels[0].line).toBe(2)
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
    expect(Math.abs(row0.labels[0].across - row1.labels[0].across)).toBe(pitch)
    expect(row0.labels[0].line).toBe(0)
    expect(row1.labels[0].line).toBe(0)
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
    expect(rows.find((r) => r.index === 3)!.labels[0].line).toBe(0)
    expect(rows.find((r) => r.index === 7)!.labels[0].line).toBe(1)
  })

  it('keeps a sub-pixel col-coordinate difference from deciding which of two colliding col labels lands on top', () => {
    // Mirror of the row-axis case above, for the top gutter.
    const keys = [
      makeKey({ row: 0, col: 3, x: 3, y: 0 }),
      makeKey({ row: 0, col: 7, x: 3 - 0.3 / KEY_UNIT, y: 0 }),
    ]
    const { cols } = buildMatrixWires(keys, IDENTITY_CELLS, 1, 8)
    expect(cols.find((c) => c.index === 3)!.labels[0].line).toBe(0)
    expect(cols.find((c) => c.index === 7)!.labels[0].line).toBe(1)
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
        if (Math.abs(a.labels[0].across - b.labels[0].across) < pitch) {
          expect(a.labels[0].line).toBeLessThan(b.labels[0].line)
        }
      }
    }

    const row3 = rows.find((r) => r.index === 3)!
    const row7 = rows.find((r) => r.index === 7)!
    expect(row3.labels[0].line).toBe(0)
    expect(row7.labels[0].line).toBe(1)
  })
})

describe('buildMatrixWires — top-row col labels', () => {
  it('gives every col wire on the split-thumb fixture 2 labels (one per half) and every row wire 1', () => {
    // Regression for the split-board report: cols 0-4 are shared by both
    // halves, and each half's topmost key must get its own gutter number.
    const layout = loadSplitThumbLayout()
    const { rows, cols, nodes } = buildMatrixWires(layout.keys, IDENTITY_CELLS, 1, NO_GUTTER_FONT_SIZE)
    const nodeByPos = new Map(nodes.map((n) => [n.posKey, n]))

    for (const row of rows) {
      expect(row.labels).toHaveLength(1)
    }

    for (let col = 0; col <= 4; col++) {
      const wire = cols.find((c) => c.index === col)!
      const leftX = nodeByPos.get(posKey(0, col))!.x
      const rightX = nodeByPos.get(posKey(4, col))!.x
      const acrossValues = wire.labels.map((l) => l.across).sort((a, b) => a - b)
      expect(acrossValues).toHaveLength(2)
      expect(acrossValues[0]).toBeCloseTo(Math.min(leftX, rightX))
      expect(acrossValues[1]).toBeCloseTo(Math.max(leftX, rightX))
    }
  })

  it('keeps exactly one label for a column that only exists in a lower row (no top-row member)', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 0 }), // top row, a different column
      makeKey({ row: 1, col: 1, x: 1, y: 1 }), // the column under test, one row down
    ]
    const { cols } = buildMatrixWires(keys, IDENTITY_CELLS, 1, NO_GUTTER_FONT_SIZE)
    const col1 = cols.find((c) => c.index === 1)!
    expect(col1.labels).toHaveLength(1)
    expect(col1.labels[0].across).toBeCloseTo(col1.points[0].x)
  })

  it('collapses to one label when the wire anchor is itself the top-row member', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 0 }), // topmost row and this col's own anchor
      makeKey({ row: 1, col: 0, x: 0, y: 1 }),
    ]
    const { cols } = buildMatrixWires(keys, IDENTITY_CELLS, 1, NO_GUTTER_FONT_SIZE)
    expect(cols.find((c) => c.index === 0)!.labels).toHaveLength(1)
  })

  it('keeps both ends of a non-transitive dedupe chain (0, 0.75 pitch, 1.5 pitch) when 0 is the anchor', () => {
    // Closeness isn't transitive: 0.75 pitch collides with the anchor at 0
    // and is dropped before 1.5 pitch is even considered, so both ends
    // survive here regardless of whether every kept candidate is checked or
    // only the most recently kept one — this case alone doesn't tell the two
    // strategies apart. The 1.2/0/1.0 pitch cluster below does.
    const fontSize = 8
    const pitch = colLabelPitch(fontSize)
    const toDeltaUnits = (px: number) => px / KEY_UNIT
    const keys = [
      makeKey({ row: 0, col: 10, x: 0, y: 0 }),
      makeKey({ row: 1, col: 11, x: toDeltaUnits(pitch * 0.75), y: 0 }),
      makeKey({ row: 2, col: 12, x: toDeltaUnits(pitch * 1.5), y: 0 }),
    ]
    const cells = new Map<string, { row: number; col: number }>([
      [posKey(0, 10), { row: 0, col: 0 }],
      [posKey(1, 11), { row: 1, col: 0 }],
      [posKey(2, 12), { row: 2, col: 0 }],
    ])
    const { cols, nodes } = buildMatrixWires(keys, cells, 1, fontSize)
    const nodeByPos = new Map(nodes.map((n) => [n.posKey, n]))
    const col0 = cols.find((c) => c.index === 0)!
    expect(col0.labels).toHaveLength(2)
    const acrossValues = col0.labels.map((l) => l.across).sort((a, b) => a - b)
    expect(acrossValues[0]).toBeCloseTo(nodeByPos.get(posKey(0, 10))!.x)
    expect(acrossValues[1]).toBeCloseTo(nodeByPos.get(posKey(2, 12))!.x)
  })

  it('drops a candidate close to the anchor even when it is a full pitch from the previously kept candidate', () => {
    // Distinguishes "compare against every kept candidate" from "compare
    // against only the most recently kept one": the anchor (topmost, so
    // smallest y) sits at 1.2 pitch, one member sits at 0 (1.2 pitch from
    // the anchor — kept) and the other at 1.0 pitch (0.2 pitch from the
    // anchor — must be dropped, even though it's a full pitch from the
    // already-kept 0). Candidates are walked anchor-first, so a check
    // against only the previously kept candidate (0, at the time 1.0 pitch
    // is considered) would wrongly keep it. y = 0 for the anchor and 0.25
    // for the other two keeps all three in one top-row cluster (threshold
    // 0.5u) while still making the first key the topmost.
    const fontSize = 8
    const pitch = colLabelPitch(fontSize)
    const toDeltaUnits = (px: number) => px / KEY_UNIT
    const keys = [
      makeKey({ row: 0, col: 20, x: toDeltaUnits(pitch * 1.2), y: 0 }), // anchor
      makeKey({ row: 1, col: 21, x: 0, y: 0.25 }),
      makeKey({ row: 2, col: 22, x: toDeltaUnits(pitch * 1.0), y: 0.25 }),
    ]
    const cells = new Map<string, { row: number; col: number }>([
      [posKey(0, 20), { row: 0, col: 0 }],
      [posKey(1, 21), { row: 1, col: 0 }],
      [posKey(2, 22), { row: 2, col: 0 }],
    ])
    const { cols, nodes } = buildMatrixWires(keys, cells, 1, fontSize)
    const nodeByPos = new Map(nodes.map((n) => [n.posKey, n]))
    const col0 = cols.find((c) => c.index === 0)!
    expect(col0.labels).toHaveLength(2)
    const acrossValues = col0.labels.map((l) => l.across).sort((a, b) => a - b)
    expect(acrossValues[0]).toBeCloseTo(nodeByPos.get(posKey(1, 21))!.x)
    expect(acrossValues[1]).toBeCloseTo(nodeByPos.get(posKey(0, 20))!.x)
  })

  it('labels both halves when each half is rotated as a rigid block', () => {
    // Each half's rows are rotated together around its own origin, so
    // their rotated y ranges overlap the row below — the top row has to
    // come from the unrotated grid, not the final on-screen position.
    const deg = 15
    const half = (r: number, rx: number, rowBase: number): unknown[][] => [
      [{ r, rx, ry: 1, y: -1, x: 0 }, ...[0, 1, 2, 3, 4].map((c) => `${rowBase},${c}`)],
      [0, 1, 2, 3, 4].map((c) => `${rowBase + 1},${c}`),
      [0, 1, 2, 3, 4].map((c) => `${rowBase + 2},${c}`),
    ]
    const { keys } = parseKle([...half(deg, 1, 0), ...half(-deg, 8, 3)])

    const { cols, colLineCount } = buildMatrixWires(keys, IDENTITY_CELLS, 1, NO_GUTTER_FONT_SIZE)
    for (let col = 0; col <= 4; col++) {
      expect(cols.find((c) => c.index === col)!.labels).toHaveLength(2)
    }
    expect(colLineCount).toBe(1)
  })

  it('assigns both labels of the same wire to line 0 when they collide with nothing else', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 0 }),
      makeKey({ row: 4, col: 0, x: 10, y: 0 }), // same top row, same effective col, far apart in x
    ]
    const { cols } = buildMatrixWires(keys, IDENTITY_CELLS, 1, 8)
    const col0 = cols.find((c) => c.index === 0)!
    expect(col0.labels).toHaveLength(2)
    for (const label of col0.labels) {
      expect(label.line).toBe(0)
    }
  })

  it('lets colliding labels from two different col wires land on separate lines together', () => {
    // Two col wires, each carrying two top-row labels of its own,
    // interleaved within one pitch of each other: col 0's members sit at 0
    // and 500px, col 1's sit half a pitch to the right of each — so every
    // col-1 label collides with its col-0 counterpart, not just with its own
    // wire's other label.
    const fontSize = 8
    const pitch = colLabelPitch(fontSize)
    const toDeltaUnits = (px: number) => px / KEY_UNIT
    const keys = [
      makeKey({ row: 0, col: 50, x: 0, y: 0 }),
      makeKey({ row: 1, col: 51, x: toDeltaUnits(500), y: 0 }),
      makeKey({ row: 2, col: 52, x: toDeltaUnits(pitch * 0.5), y: 0 }),
      makeKey({ row: 3, col: 53, x: toDeltaUnits(500 + pitch * 0.5), y: 0 }),
    ]
    const cells = new Map<string, { row: number; col: number }>([
      [posKey(0, 50), { row: 0, col: 0 }],
      [posKey(1, 51), { row: 1, col: 0 }],
      [posKey(2, 52), { row: 2, col: 1 }],
      [posKey(3, 53), { row: 3, col: 1 }],
    ])
    const { cols, colLineCount } = buildMatrixWires(keys, cells, 1, fontSize)
    const col0 = cols.find((c) => c.index === 0)!
    const col1 = cols.find((c) => c.index === 1)!
    expect(col0.labels).toHaveLength(2)
    expect(col1.labels).toHaveLength(2)
    for (const label of col0.labels) expect(label.line).toBe(0)
    for (const label of col1.labels) expect(label.line).toBe(1)
    expect(colLineCount).toBe(2)
  })
})
