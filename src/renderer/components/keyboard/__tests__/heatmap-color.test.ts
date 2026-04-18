// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { heatmapFill, heatmapFillForCell } from '../heatmap-color'

describe('heatmapFill', () => {
  it('returns a cool fill at intensity 0', () => {
    // hue=220 (blue) at the low end, so the 220 hue must appear.
    expect(heatmapFill(0)).toContain('hsl(220, 70%,')
  })

  it('returns a warm fill at intensity 1', () => {
    // hue=0 (red) at the high end.
    expect(heatmapFill(1)).toContain('hsl(0, 70%,')
  })

  it('clamps intensities above 1 to the warm end', () => {
    expect(heatmapFill(5)).toBe(heatmapFill(1))
  })

  it('clamps intensities below 0 to the cool end', () => {
    expect(heatmapFill(-0.5)).toBe(heatmapFill(0))
  })
})

describe('heatmapFillForCell', () => {
  it('returns null when the map is null (hook disabled)', () => {
    expect(heatmapFillForCell(null, 10, '1,2')).toBeNull()
  })

  it('returns null when the map is undefined (prop not wired)', () => {
    expect(heatmapFillForCell(undefined, 10, '1,2')).toBeNull()
  })

  it('returns null when maxCount is zero (no data yet)', () => {
    expect(heatmapFillForCell(new Map([['1,2', 5]]), 0, '1,2')).toBeNull()
  })

  it('returns null for cells that never saw a press', () => {
    expect(heatmapFillForCell(new Map([['1,2', 5]]), 5, '9,9')).toBeNull()
  })

  it('derives a warm fill for the peak cell', () => {
    expect(heatmapFillForCell(new Map([['1,2', 10]]), 10, '1,2')).toBe(heatmapFill(1))
  })

  it('scales intermediate cells proportionally to the peak', () => {
    const map = new Map([['1,2', 5], ['3,4', 10]])
    expect(heatmapFillForCell(map, 10, '1,2')).toBe(heatmapFill(0.5))
  })
})
