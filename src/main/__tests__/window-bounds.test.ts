// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { effectiveMinSize, clampBoundsToWorkArea } from '../window-bounds'

const MIN_WIDTH = 1280
const MIN_HEIGHT = 1024

describe('effectiveMinSize', () => {
  it.each([
    ['work area larger than nominal min', { width: 1920, height: 1080 }, { width: 1280, height: 1024 }],
    ['work area shorter than nominal min (macOS laptop Dock case)', { width: 1440, height: 900 }, { width: 1280, height: 900 }],
    ['work area smaller in both axes', { width: 1024, height: 768 }, { width: 1024, height: 768 }],
    ['degenerate tiny work area', { width: 320, height: 240 }, { width: 320, height: 240 }],
  ])('%s', (_name, workArea, expected) => {
    expect(effectiveMinSize(workArea, MIN_WIDTH, MIN_HEIGHT)).toEqual(expected)
  })
})

describe('clampBoundsToWorkArea', () => {
  it.each([
    [
      'already fully inside a larger work area — left untouched',
      { x: 100, y: 50, width: 1440, height: 1024 },
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 100, y: 50, width: 1440, height: 1024 },
    ],
    [
      'taller than the work area — shrinks height and pins flush to its bottom edge',
      { x: 50, y: 50, width: 1440, height: 1024 },
      { x: 0, y: 25, width: 1440, height: 900 },
      { x: 0, y: 25, width: 1440, height: 900 },
    ],
    [
      'wider than the work area — shrinks width and lands flush left',
      { x: 2500, y: 100, width: 1440, height: 800 },
      { x: 0, y: 0, width: 1280, height: 1024 },
      { x: 0, y: 100, width: 1280, height: 800 },
    ],
    [
      'origin overflowing the right/bottom edge slides back inside',
      { x: 1800, y: 1000, width: 1280, height: 1024 },
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 640, y: 56, width: 1280, height: 1024 },
    ],
    [
      'origin left/above the work area slides back inside',
      { x: -500, y: -300, width: 1280, height: 1024 },
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1280, height: 1024 },
    ],
    [
      'negative-coordinate work area (secondary display left of primary)',
      { x: -100, y: 0, width: 1440, height: 1024 },
      { x: -1920, y: 0, width: 1920, height: 1080 },
      { x: -1440, y: 0, width: 1440, height: 1024 },
    ],
    [
      'degenerate tiny work area — fits without negative size',
      { x: 0, y: 0, width: 1280, height: 1024 },
      { x: 100, y: 100, width: 320, height: 240 },
      { x: 100, y: 100, width: 320, height: 240 },
    ],
    [
      'smaller than the work area — never grown',
      { x: 10, y: 10, width: 800, height: 600 },
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 10, y: 10, width: 800, height: 600 },
    ],
    [
      // Mirrors issue #419: a windowState saved from a large external
      // monitor, restored on a MacBook's smaller built-in work area — both
      // dimensions overflow, so the clamp pins the window flush to the
      // work area's own origin.
      'saved state larger than the work area in both axes — pinned to the work area origin',
      { x: -200, y: -50, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1440, height: 900 },
      { x: 0, y: 0, width: 1440, height: 900 },
    ],
  ])('%s', (_name, bounds, workArea, expected) => {
    expect(clampBoundsToWorkArea(bounds, workArea)).toEqual(expected)
  })
})
