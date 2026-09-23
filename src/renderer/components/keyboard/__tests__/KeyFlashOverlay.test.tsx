// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { KeyFlashOverlay, type FlashShape } from '../KeyFlashOverlay'
import { KEY_SELECTED_COLOR } from '../constants'
import { attrs } from './flash-overlay-test-utils'

function renderOverlay(shape: FlashShape, flashGeneration = 1) {
  return (
    <svg>
      <KeyFlashOverlay
        shape={shape}
        flashGeneration={flashGeneration}
        flashElapsedMs={120}
        outerStroke="#123456"
        outerStrokeWidth={2}
      />
    </svg>
  )
}

const cases: { shape: FlashShape; tag: string; geometry: Record<string, string> }[] = [
  { shape: { kind: 'path', d: 'M 0 0 L 10 0 Z' }, tag: 'path', geometry: { d: 'M 0 0 L 10 0 Z' } },
  {
    shape: { kind: 'rect', x: 1, y: 2, w: 30, h: 40, corner: 5 },
    tag: 'rect',
    geometry: { x: '1', y: '2', width: '30', height: '40', rx: '5', ry: '5' },
  },
  { shape: { kind: 'circle', cx: 7, cy: 8, r: 9 }, tag: 'circle', geometry: { cx: '7', cy: '8', r: '9' } },
]

describe('KeyFlashOverlay', () => {
  for (const { shape, tag, geometry } of cases) {
    describe(shape.kind, () => {
      it('draws the fill layer then the border layer with the same geometry', () => {
        const { container } = render(renderOverlay(shape))
        const svg = container.querySelector('svg')!
        expect(svg.children).toHaveLength(2)
        const [fill, border] = Array.from(svg.children)
        expect(fill.tagName).toBe(tag)
        expect(border.tagName).toBe(tag)
        expect(attrs(fill)).toEqual({
          ...geometry,
          'data-testid': 'flash-overlay',
          class: 'key-flash-overlay',
          fill: KEY_SELECTED_COLOR,
          style: 'pointer-events: none; animation-delay: -120ms;',
        })
        expect(attrs(border)).toEqual({
          ...geometry,
          'data-testid': 'flash-overlay-border',
          fill: 'none',
          stroke: '#123456',
          'stroke-width': '2',
          style: 'pointer-events: none;',
        })
      })

      it('replaces only the fill layer when flashGeneration changes', () => {
        const { container, rerender } = render(renderOverlay(shape, 1))
        const [fill1, border1] = Array.from(container.querySelector('svg')!.children)
        rerender(renderOverlay(shape, 2))
        const [fill2, border2] = Array.from(container.querySelector('svg')!.children)
        expect(fill2).not.toBe(fill1)
        expect(border2).toBe(border1)
      })
    })
  }
})
