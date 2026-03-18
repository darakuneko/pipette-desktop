// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  computeUnionPolygon,
  polygonToSvgPath,
  computeUnionPath,
} from '../rect-union'

describe('computeUnionPolygon', () => {
  it('returns empty for non-overlapping rects', () => {
    // R1 at (0,0,1,1), R2 at (5,5,1,1) - no overlap
    expect(computeUnionPolygon(0, 0, 1, 1, 5, 5, 1, 1)).toEqual([])
  })

  it('returns empty for edge-touching rects (no area overlap)', () => {
    // R1 right edge = R2 left edge
    expect(computeUnionPolygon(0, 0, 1, 1, 1, 0, 1, 1)).toEqual([])
  })

  it('returns 4 vertices when one rect contains the other', () => {
    // R2 inside R1
    const verts = computeUnionPolygon(0, 0, 4, 4, 1, 1, 2, 2)
    expect(verts).toHaveLength(4)
    // Should be the outer rect
    expect(verts).toContainEqual([0, 0])
    expect(verts).toContainEqual([4, 0])
    expect(verts).toContainEqual([4, 4])
    expect(verts).toContainEqual([0, 4])
  })

  it('returns 6 vertices for L-shaped ISO Enter', () => {
    // R1: tall narrow (0,0, 2,3), R2: wide short (0,0, 3,1)
    // Union is L-shape
    const verts = computeUnionPolygon(0, 0, 2, 3, 0, 0, 3, 1)
    expect(verts).toHaveLength(6)
    // Vertices should trace: (0,0)→(3,0)→(3,1)→(2,1)→(2,3)→(0,3)
    expect(verts[0]).toEqual([0, 0])
    expect(verts[1]).toEqual([3, 0])
    expect(verts[2]).toEqual([3, 1])
    expect(verts[3]).toEqual([2, 1])
    expect(verts[4]).toEqual([2, 3])
    expect(verts[5]).toEqual([0, 3])
  })

  it('returns 6 vertices for ISO Enter with offset x2', () => {
    // Simulates typical ISO Enter: primary w=1.25,h=2, secondary x2=-0.25,w2=1.5,h2=1
    // In pixel coords (scaled): primary at (10,0, 60,100), secondary at (-5,0, 75,50)
    // rect1: left=10, top=0, right=70, bottom=100
    // rect2: left=-5, top=0, right=70, bottom=50
    // Union: (-5,0)→(70,0)→(70,100)→(10,100)→(10,50)→(-5,50)
    const verts = computeUnionPolygon(10, 0, 60, 100, -5, 0, 75, 50)
    expect(verts).toHaveLength(6)
    expect(verts[0]).toEqual([-5, 0])
    expect(verts[1]).toEqual([70, 0])
    expect(verts[2]).toEqual([70, 100])
    expect(verts[3]).toEqual([10, 100])
    expect(verts[4]).toEqual([10, 50])
    expect(verts[5]).toEqual([-5, 50])
  })

  it('handles identical rects (degenerate case)', () => {
    const verts = computeUnionPolygon(0, 0, 2, 2, 0, 0, 2, 2)
    expect(verts).toHaveLength(4)
  })

  it('returns 6 vertices for BAE key with y2 offset (issue #60)', () => {
    // BAE: primary w=1.5 h=2, secondary w2=2.25 h2=1 x2=-0.75 y2=1
    // Simulates the exact pixel coordinates that trigger FP precision bug:
    // r1b = 54*2 - spacing  vs  r2b = 54 + (54 - spacing)
    // These differ by ~1e-14 in IEEE 754.
    const KEY_UNIT = 54
    const KEY_SPACING = KEY_UNIT * 0.2 / (3.2 + 0.2)
    const s = KEY_UNIT
    const gx = 0
    const gy = 0
    const gw = s * 1.5 - KEY_SPACING
    const gh = s * 2 - KEY_SPACING
    const gx2 = gx + s * (-0.75)
    const gy2 = gy + s * 1
    const gw2 = s * 2.25 - KEY_SPACING
    const gh2 = s * 1 - KEY_SPACING

    const verts = computeUnionPolygon(gx, gy, gw, gh, gx2, gy2, gw2, gh2)
    // Must be 6-vertex L-shape, NOT 5-vertex (diagonal)
    expect(verts).toHaveLength(6)
    // Bottom-right corner must exist (was missing before fix)
    const bottomRight = verts.find(
      (v) => Math.abs(v[0] - (gx + gw)) < 1e-3 && Math.abs(v[1] - (gy + gh)) < 1e-3,
    )
    expect(bottomRight).toBeDefined()
  })

  it('snaps near-equal coordinates (FP noise) without merging distant ones', () => {
    // L-shape where shared bottom differs by ~1e-14 (same mechanism as #60)
    // Rect1: narrow tall (0,0)→(10,30), Rect2: wide lower (0,10)→(15,30+ε)
    const verts = computeUnionPolygon(
      0, 0, 10, 30,              // r1b = 30
      0, 10, 15, 20 + 1e-14,     // r2b = 30 + 1e-14 (FP noise)
    )
    // Must produce clean 6-vertex L-shape, not 5-vertex diagonal
    expect(verts).toHaveLength(6)

    // Rects with genuinely different dimensions must NOT be snapped
    const verts2 = computeUnionPolygon(0, 0, 10, 20, 0, 0, 15, 10.5)
    expect(verts2).toHaveLength(6) // L-shape with distinct step position
  })

  it('vertices are ordered clockwise (positive signed area in screen coords)', () => {
    const verts = computeUnionPolygon(0, 0, 2, 3, 0, 0, 3, 1)
    // Signed area via shoelace formula: positive = clockwise in y-down screen coords
    const n = verts.length
    let signedArea = 0
    for (let i = 0; i < n; i++) {
      const curr = verts[i]
      const next = verts[(i + 1) % n]
      signedArea += curr[0] * next[1] - next[0] * curr[1]
    }
    expect(signedArea).toBeGreaterThan(0)
  })
})

describe('polygonToSvgPath', () => {
  it('returns empty string for less than 3 vertices', () => {
    expect(polygonToSvgPath([], 5)).toBe('')
    expect(
      polygonToSvgPath(
        [
          [0, 0],
          [1, 1],
        ],
        5,
      ),
    ).toBe('')
  })

  it('generates path with M, L, and Z for zero radius', () => {
    const verts: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]
    const path = polygonToSvgPath(verts, 0)
    expect(path).toContain('M')
    expect(path).toContain('L')
    expect(path).toContain('Z')
    expect(path).not.toContain('A')
  })

  it('generates arcs at convex corners with nonzero radius', () => {
    const verts: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]
    const path = polygonToSvgPath(verts, 2)
    // All 4 corners of a rectangle are convex, so 4 arcs
    const arcCount = (path.match(/A /g) ?? []).length
    expect(arcCount).toBe(4)
  })

  it('does not add arcs at concave corners (L-shape)', () => {
    // L-shape: has 5 convex and 1 concave corner
    const verts: [number, number][] = [
      [0, 0],
      [30, 0],
      [30, 10],
      [20, 10],
      [20, 30],
      [0, 30],
    ]
    const path = polygonToSvgPath(verts, 2)
    // 5 convex corners get arcs, 1 concave (at [20,10]) does not
    const arcCount = (path.match(/A /g) ?? []).length
    expect(arcCount).toBe(5)
  })
})

describe('computeUnionPath', () => {
  it('returns empty string for non-overlapping rects', () => {
    expect(computeUnionPath(0, 0, 1, 1, 5, 5, 1, 1, 3)).toBe('')
  })

  it('returns a valid SVG path for overlapping rects', () => {
    const path = computeUnionPath(0, 0, 20, 30, 0, 0, 30, 10, 3)
    expect(path).toMatch(/^M /)
    expect(path).toContain('Z')
  })

  it('produces a path with arcs for nonzero corner radius', () => {
    const path = computeUnionPath(0, 0, 20, 30, 0, 0, 30, 10, 3)
    expect(path).toContain('A ')
  })
})
