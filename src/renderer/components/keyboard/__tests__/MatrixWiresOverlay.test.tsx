// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MatrixWiresOverlay } from '../MatrixWiresOverlay'
import { buildMatrixWires, colLabelPitch, type MatrixWiresLayout, type MatrixWiresGutter } from '../matrix-wires'
import { WIRE_ROW_COLOR, WIRE_COL_COLOR, WIRE_NODE_COLOR } from '../constants'
import { makeKey, makeColumnStackKeys, NO_GUTTER_FONT_SIZE, IDENTITY_CELLS, loadVirtualDeviceLayout } from './kle-test-keys'
import { posKey } from '../../../../shared/kle/pos-key'

/** A gutter fixture wide enough for label-placement math without a real
 *  KeyboardWidget render — used by suites that don't care about the exact
 *  band size, only that one is present. */
function makeGutter(overrides: Partial<MatrixWiresGutter> = {}): MatrixWiresGutter {
  return { originX: -20, originY: -20, left: 30, top: 30, fontSize: 10, ...overrides }
}

/** Renders inside a bare <svg> — `<g>`/`<polyline>`/`<circle>`/`<text>`
 *  are only valid SVG children, and jsdom's querySelector needs a real
 *  SVG namespace context to find them by tag name. */
function renderOverlay(layout: MatrixWiresLayout, gutter: MatrixWiresGutter = makeGutter(), scale = 1) {
  return render(
    <svg>
      <MatrixWiresOverlay layout={layout} scale={scale} gutter={gutter} />
    </svg>,
  )
}

describe('MatrixWiresOverlay — virtual device GPK60-63R fixture', () => {
  const kleLayout = loadVirtualDeviceLayout()
  const layout = buildMatrixWires(kleLayout.keys, IDENTITY_CELLS, 1, 10)

  it('renders one polyline per row (5) and one per col (14)', () => {
    const { container } = renderOverlay(layout)
    const polylines = container.querySelectorAll('polyline')
    // Every row/col group on this fixture has >= 2 points (verified by
    // matrix-wires.test.ts), so every one of the 5 rows and 14 cols
    // produces a polyline.
    expect(layout.rows).toHaveLength(5)
    expect(layout.cols).toHaveLength(14)
    expect(polylines.length).toBe(5 + 14)
  })

  it('renders a hollow node circle for every key', () => {
    const { container } = renderOverlay(layout)
    const circles = container.querySelectorAll('circle')
    expect(circles.length).toBe(layout.nodes.length)
    for (const circle of circles) {
      expect(circle.getAttribute('fill')).toBe('none')
      expect(circle.getAttribute('stroke')).toBe(WIRE_NODE_COLOR)
    }
  })

  it('renders row/col wires with their own CSS variable strokes', () => {
    const { container } = renderOverlay(layout)
    const polylines = [...container.querySelectorAll('polyline')]
    // Row wires are drawn before col wires (5 + 14 total, first 5 are rows).
    const rowStrokes = new Set(polylines.slice(0, 5).map((p) => p.getAttribute('stroke')))
    const colStrokes = new Set(polylines.slice(5).map((p) => p.getAttribute('stroke')))
    expect(rowStrokes).toEqual(new Set([WIRE_ROW_COLOR]))
    expect(colStrokes).toEqual(new Set([WIRE_COL_COLOR]))
  })

  it('is wrapped in a pointer-events-none, opacity-60 group with the matrix-wires testid', () => {
    const { container } = renderOverlay(layout)
    const group = container.querySelector('[data-testid="matrix-wires"]')!
    expect(group.tagName.toLowerCase()).toBe('g')
    expect(group.classList.contains('pointer-events-none')).toBe(true)
    expect(group.classList.contains('opacity-60')).toBe(true)
  })
})

describe('MatrixWiresOverlay — single-point wire', () => {
  it('produces no polyline but still produces a label for a lone key', () => {
    const key = makeKey({ row: 0, col: 0, x: 0, y: 0 })
    const layout = buildMatrixWires([key], IDENTITY_CELLS, 1, NO_GUTTER_FONT_SIZE)
    expect(layout.cols[0].points).toHaveLength(1)

    const { container } = renderOverlay(layout)
    expect(container.querySelectorAll('polyline').length).toBe(0)
    const texts = container.querySelectorAll('text')
    expect(texts.length).toBe(2) // one row label, one col label
    expect(texts[0].textContent).toBe('0')
    expect(texts[1].textContent).toBe('0')
  })
})

describe('MatrixWiresOverlay — label styling', () => {
  it('gives row labels the row color and col labels the col color, centered text', () => {
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 0 }),
      makeKey({ row: 0, col: 1, x: 1, y: 0 }),
    ]
    const layout = buildMatrixWires(keys, IDENTITY_CELLS, 1, 11)
    const { container } = renderOverlay(layout, makeGutter({ fontSize: 11 }))
    const texts = [...container.querySelectorAll('text')]
    const rowLabel = texts.find((t) => t.textContent === '0' && t.getAttribute('fill') === WIRE_ROW_COLOR)
    const colLabels = texts.filter((t) => t.getAttribute('fill') === WIRE_COL_COLOR)
    expect(rowLabel).toBeDefined()
    expect(colLabels).toHaveLength(2)
    for (const text of texts) {
      expect(text.getAttribute('text-anchor')).toBe('middle')
      expect(text.getAttribute('dominant-baseline')).toBe('central')
      expect(text.getAttribute('font-size')).toBe('11')
    }
  })
})

describe('MatrixWiresOverlay — label coordinates', () => {
  it('positions a single-line label at the gutter band center (line 0 of 1)', () => {
    const key = makeKey({ row: 0, col: 0, x: 0, y: 0 })
    const layout = buildMatrixWires([key], IDENTITY_CELLS, 1, 10)
    const gutter = makeGutter({ originX: -20, originY: -20, left: 30, top: 30, fontSize: 10 })
    const { container } = renderOverlay(layout, gutter)
    const texts = [...container.querySelectorAll('text')]
    const rowText = texts.find((t) => t.getAttribute('fill') === WIRE_ROW_COLOR)!
    const colText = texts.find((t) => t.getAttribute('fill') === WIRE_COL_COLOR)!

    // Single line (rowLineCount/colLineCount === 1) means the centering
    // offset is exactly zero — the label sits on the band's own midline.
    expect(Number(rowText.getAttribute('x'))).toBeCloseTo(gutter.originX + gutter.left / 2)
    expect(Number(rowText.getAttribute('y'))).toBeCloseTo(layout.rows[0].labels[0].across)
    expect(Number(colText.getAttribute('x'))).toBeCloseTo(layout.cols[0].labels[0].across)
    expect(Number(colText.getAttribute('y'))).toBeCloseTo(gutter.originY + gutter.top / 2)
  })

  it('centers a three-line label stack around the gutter band middle', () => {
    // Regression fixture for the reported gutter overlap: matrix cols
    // 1, 3, 7 anchored at the same physical column stack onto three
    // lines instead of the old two-line cap.
    const keys = makeColumnStackKeys()
    const fontSize = 20
    const layout = buildMatrixWires(keys, IDENTITY_CELLS, 1, fontSize)
    expect(layout.colLineCount).toBe(3)
    const gutter = makeGutter({ originX: -40, originY: -40, left: 90, top: 90, fontSize })
    const { container } = renderOverlay(layout, gutter)
    const pitch = colLabelPitch(fontSize)
    const center = gutter.originY + gutter.top / 2
    const texts = [...container.querySelectorAll('text')]

    for (const colIndex of [1, 3, 7]) {
      const wire = layout.cols.find((c) => c.index === colIndex)!
      const text = texts.find((t) => t.getAttribute('fill') === WIRE_COL_COLOR && t.textContent === String(colIndex))!
      const expectedY = center + (wire.labels[0].line - (layout.colLineCount - 1) / 2) * pitch
      expect(Number(text.getAttribute('y'))).toBeCloseTo(expectedY)
      expect(Number(text.getAttribute('x'))).toBeCloseTo(wire.labels[0].across)
    }
  })
})

describe('MatrixWiresOverlay — multiple labels per wire', () => {
  it('renders one <text> per label with no duplicate React keys', () => {
    // Two physical top-row keys sharing an effective col: buildMatrixWires
    // gives that wire 2 labels, and the overlay must render both. React
    // warns to the console (not by throwing) when two siblings share a key,
    // so the spy below is what actually proves there's no duplicate among
    // them — the DOM output alone only proves the count and text match.
    const keys = [
      makeKey({ row: 0, col: 0, x: 0, y: 0 }),
      makeKey({ row: 0, col: 1, x: 10, y: 0 }),
    ]
    const cells = new Map<string, { row: number; col: number }>([
      [posKey(0, 0), { row: 0, col: 0 }],
      [posKey(0, 1), { row: 0, col: 0 }],
    ])
    const layout = buildMatrixWires(keys, cells, 1, NO_GUTTER_FONT_SIZE)
    const col0 = layout.cols.find((c) => c.index === 0)!
    expect(col0.labels).toHaveLength(2)

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = renderOverlay(layout)
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()

    const colTexts = [...container.querySelectorAll('text')].filter(
      (t) => t.getAttribute('fill') === WIRE_COL_COLOR,
    )
    expect(colTexts).toHaveLength(2)
    for (const text of colTexts) {
      expect(text.textContent).toBe('0')
    }
  })
})
