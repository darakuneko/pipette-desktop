// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { MatrixWiresOverlay } from '../MatrixWiresOverlay'
import { buildMatrixWires, type MatrixWiresGutter, type MatrixWiresLayout } from '../matrix-wires'
import { parseDefinitionLayout } from '../../../../shared/kle/definition-layout'
import type { KeyboardDefinition } from '../../../../shared/types/protocol'
import type { KleKey } from '../../../../shared/kle/types'

const NO_GUTTER: MatrixWiresGutter = { originX: -10, originY: -10, size: 20, fontSize: 10 }
const IDENTITY_CELLS = new Map<string, { row: number; col: number }>()

function makeKey(overrides: Partial<KleKey> = {}): KleKey {
  return {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    x2: 0,
    y2: 0,
    width2: 1,
    height2: 1,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    color: '',
    labels: [],
    textColor: [],
    textSize: [],
    row: 0,
    col: 0,
    encoderIdx: -1,
    encoderDir: -1,
    layoutIndex: -1,
    layoutOption: -1,
    decal: false,
    nub: false,
    stepped: false,
    ghost: false,
    ...overrides,
  }
}

/** Renders inside a bare <svg> — `<g>`/`<polyline>`/`<circle>`/`<text>`
 *  are only valid SVG children, and jsdom's querySelector needs a real
 *  SVG namespace context to find them by tag name. */
function renderOverlay(layout: MatrixWiresLayout, scale = 1, fontSize = 10) {
  return render(
    <svg>
      <MatrixWiresOverlay layout={layout} scale={scale} fontSize={fontSize} />
    </svg>,
  )
}

describe('MatrixWiresOverlay — virtual device GPK60-63R fixture', () => {
  const fixturePath = join(
    __dirname,
    '../../../../main/virtual-device/gpk60-63r-definition.json',
  )
  const definition = JSON.parse(readFileSync(fixturePath, 'utf-8')) as KeyboardDefinition
  const { layout: kleLayout } = parseDefinitionLayout(definition)
  const layout = buildMatrixWires(kleLayout!.keys, IDENTITY_CELLS, 1, {
    originX: -20,
    originY: -20,
    size: 30,
    fontSize: 10,
  })

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
      expect(circle.getAttribute('stroke')).toBe('var(--content-secondary)')
    }
  })

  it('renders row/col wires with their own CSS variable strokes', () => {
    const { container } = renderOverlay(layout)
    const polylines = container.querySelectorAll('polyline')
    const rowStrokes = new Set<string>()
    const colStrokes = new Set<string>()
    for (const polyline of polylines) {
      const stroke = polyline.getAttribute('stroke')!
      // Row wires are drawn before col wires (5 + 14 total, first 5 are rows).
      if ([...polylines].indexOf(polyline) < 5) rowStrokes.add(stroke)
      else colStrokes.add(stroke)
    }
    expect(rowStrokes).toEqual(new Set(['var(--wire-row)']))
    expect(colStrokes).toEqual(new Set(['var(--wire-col)']))
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
    const layout = buildMatrixWires([key], IDENTITY_CELLS, 1, NO_GUTTER)
    expect(layout.rows[0].points).toHaveLength(1)
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
    const layout = buildMatrixWires(keys, IDENTITY_CELLS, 1, NO_GUTTER)
    const { container } = renderOverlay(layout, 1, 11)
    const texts = [...container.querySelectorAll('text')]
    const rowLabel = texts.find((t) => t.textContent === '0' && t.getAttribute('fill') === 'var(--wire-row)')
    const colLabels = texts.filter((t) => t.getAttribute('fill') === 'var(--wire-col)')
    expect(rowLabel).toBeDefined()
    expect(colLabels).toHaveLength(2)
    for (const text of texts) {
      expect(text.getAttribute('text-anchor')).toBe('middle')
      expect(text.getAttribute('dominant-baseline')).toBe('central')
      expect(text.getAttribute('font-size')).toBe('11')
    }
  })
})
