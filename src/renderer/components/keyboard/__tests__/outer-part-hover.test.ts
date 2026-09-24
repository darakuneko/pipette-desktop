// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import type { MouseEvent } from 'react'
import { outerPartHoverHandlers } from '../outer-part-hover'

const SVG_NS = 'http://www.w3.org/2000/svg'

function widget() {
  const group = document.createElementNS(SVG_NS, 'g') as SVGGElement
  const outer = document.createElementNS(SVG_NS, 'circle')
  const inner = document.createElementNS(SVG_NS, 'rect')
  group.append(outer, inner)
  const elsewhere = document.createElementNS(SVG_NS, 'g')
  return { group, outer, inner, elsewhere }
}

function leave(from: SVGElement, to: EventTarget | null): MouseEvent<SVGElement> {
  return { currentTarget: from, relatedTarget: to } as unknown as MouseEvent<SVGElement>
}

describe('outerPartHoverHandlers', () => {
  it('ends the hover on entering the inner rect', () => {
    const emitHover = vi.fn()
    const onHoverEnd = vi.fn()
    outerPartHoverHandlers(emitHover, onHoverEnd).onInnerEnter()
    expect(onHoverEnd).toHaveBeenCalledTimes(1)
    expect(emitHover).not.toHaveBeenCalled()
  })

  it('reports the hover again with the group when moving onto the outer part of the same group', () => {
    const { group, outer, inner } = widget()
    const emitHover = vi.fn()
    outerPartHoverHandlers(emitHover, undefined).onInnerLeave(leave(inner, outer))
    expect(emitHover).toHaveBeenCalledWith(group)
  })

  it.each([
    ['another widget', true],
    ['outside the window (null)', false],
  ])('does not resume when leaving to %s', (_label, toElsewhere) => {
    const { inner, elsewhere } = widget()
    const emitHover = vi.fn()
    outerPartHoverHandlers(emitHover, vi.fn()).onInnerLeave(leave(inner, toElsewhere ? elsewhere : null))
    expect(emitHover).not.toHaveBeenCalled()
  })

  it('tolerates a missing onHoverEnd', () => {
    expect(() => outerPartHoverHandlers(vi.fn(), undefined).onInnerEnter()).not.toThrow()
  })
})
