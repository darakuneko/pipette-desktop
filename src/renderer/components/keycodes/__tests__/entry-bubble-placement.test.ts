// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { placeBesideAnchor, tallestSpaceBesideAnchor, type AnchorRect } from '../entry-bubble-placement'

const VIEWPORT = { width: 1000, height: 800 }
const OFFSET = 8
const MARGIN = 8

function anchor(left: number, top: number, width = 40, height = 40): AnchorRect {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

function place(a: AnchorRect, width: number, height: number, viewport = VIEWPORT) {
  return placeBesideAnchor(a, { width, height }, viewport, OFFSET, MARGIN)
}

function covers(a: AnchorRect, p: { top: number; left: number }, width: number, height: number): boolean {
  return p.left < a.right && p.left + width > a.left && p.top < a.bottom && p.top + height > a.top
}

describe('placeBesideAnchor', () => {
  it('goes above, centered, with its bottom edge 8px from the anchor', () => {
    const a = anchor(480, 400)
    expect(place(a, 200, 100)).toEqual({ side: 'top', top: 400 - 8 - 100, left: 500 - 100 })
  })

  it('slides only sideways above an anchor near a screen edge', () => {
    expect(place(anchor(0, 400), 200, 100)).toEqual({ side: 'top', top: 292, left: MARGIN })
    expect(place(anchor(960, 400), 200, 100)).toEqual({ side: 'top', top: 292, left: 1000 - MARGIN - 200 })
  })

  it('goes below when there is no room above', () => {
    const a = anchor(480, 100)
    expect(place(a, 200, 300)).toEqual({ side: 'bottom', top: 140 + 8, left: 400 })
  })

  it('goes right, sliding only vertically, when neither above nor below has room', () => {
    const a = anchor(100, 380)
    const p = place(a, 300, 500)
    expect(p).toEqual({ side: 'right', left: 140 + 8, top: 400 - 250 })
    // Near the bottom edge it slides up but keeps touching the anchor.
    expect(place(anchor(100, 740), 300, 760)).toEqual({ side: 'right', left: 148, top: 800 - MARGIN - 760 })
  })

  it('goes left when the right has no room either', () => {
    const a = anchor(800, 380)
    expect(place(a, 300, 500)).toEqual({ side: 'left', left: 800 - 8 - 300, top: 150 })
  })

  it('returns null when no side fits', () => {
    expect(place(anchor(480, 380), 600, 500)).toBeNull()
  })

  it('never covers the anchor', () => {
    for (const [x, y] of [[0, 0], [480, 380], [960, 760], [0, 760], [960, 0]]) {
      for (const [w, h] of [[100, 100], [300, 500], [480, 380], [900, 300]]) {
        const a = anchor(x, y)
        const p = place(a, w, h)
        if (p) expect(covers(a, p, w, h)).toBe(false)
      }
    }
  })

  it('accepts an exact fit, including fractional edges', () => {
    // Above: 100.5 - 8 - 84.5 = 8, exactly the margin.
    expect(place(anchor(480, 100.5), 200, 84.5)).toMatchObject({ side: 'top', top: 8 })
    // Right: 148.25 + 843.75 = 992, exactly the viewport minus the margin.
    const right = place(anchor(100.25, 10, 40, 780), 843.75, 780)
    expect(right).toMatchObject({ side: 'right', left: 148.25 })
    // Alignment axis: a bubble exactly as wide as the viewport minus margins.
    expect(place(anchor(480, 400), 984, 100)).toMatchObject({ side: 'top', left: MARGIN })
  })

  it('rejects a quarter pixel past the edge', () => {
    const p = place(anchor(480, 100.5), 200, 84.75)
    expect(p?.side).toBe('bottom')
  })

  it('drops a side whose alignment axis is too long for the viewport', () => {
    // 985 wide can't sit above or below; 790 tall can't sit left or right.
    expect(place(anchor(480, 400), 985, 100)).toBeNull()
    expect(place(anchor(100, 380), 300, 790)).toBeNull()
  })

  it('returns null for a viewport smaller than its margins', () => {
    expect(place(anchor(2, 2, 4, 4), 1, 1, { width: 12, height: 12 })).toBeNull()
  })
})

describe('tallestSpaceBesideAnchor', () => {
  it('takes the taller of the spaces above and below', () => {
    expect(tallestSpaceBesideAnchor(anchor(0, 100), 800, OFFSET, MARGIN)).toBe(800 - 140 - 16)
    expect(tallestSpaceBesideAnchor(anchor(0, 600), 800, OFFSET, MARGIN)).toBe(600 - 16)
  })

  it('goes to zero or below when the anchor leaves no room', () => {
    expect(tallestSpaceBesideAnchor(anchor(0, 0, 40, 800), 800, OFFSET, MARGIN)).toBeLessThanOrEqual(0)
    expect(tallestSpaceBesideAnchor(anchor(0, 16, 40, 768), 800, OFFSET, MARGIN)).toBe(0)
  })
})
