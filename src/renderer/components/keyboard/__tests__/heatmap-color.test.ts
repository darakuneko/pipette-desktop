// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { heatmapFill, outerHeatmapFillForCell, innerHeatmapFillForCell } from '../heatmap-color'
import type { TypingHeatmapCell } from '../../../../shared/types/typing-analytics'

function cells(entries: Array<[string, TypingHeatmapCell]>): Map<string, TypingHeatmapCell> {
  return new Map(entries)
}

describe('heatmapFill', () => {
  it('returns null below the visibility floor (sqrt(t) < 0.05)', () => {
    // 0.0024 after sqrt is ~0.049 — still below the floor.
    expect(heatmapFill(0, 'light')).toBeNull()
    expect(heatmapFill(0.0024, 'light')).toBeNull()
    expect(heatmapFill(0, 'dark')).toBeNull()
    expect(heatmapFill(0.0024, 'dark')).toBeNull()
  })

  it('starts at the cool (blue) end just above the floor', () => {
    // sqrt(0.01) = 0.1 → hue = 220 - 220*0.1 = 198°, saturation follows
    // the theme knob (60% light / 65% dark).
    expect(heatmapFill(0.01, 'light')).toMatch(/^hsl\(198, 60%, /)
    expect(heatmapFill(0.01, 'dark')).toMatch(/^hsl\(198, 65%, /)
  })

  it('ends at the warm (red) end at intensity 1', () => {
    expect(heatmapFill(1, 'light')).toBe('hsl(0, 60%, 50%)')
    expect(heatmapFill(1, 'dark')).toBe('hsl(0, 65%, 48%)')
  })

  it('rides a lighter lightness in light theme than in dark', () => {
    // Light theme stays at or above 50% lightness so the ramp reads on
    // the #ffffff key bg; dark theme stays at or below ~48% so labels
    // keep contrast against dark fills.
    const light = heatmapFill(0.5, 'light') ?? ''
    const dark = heatmapFill(0.5, 'dark') ?? ''
    const lightL = Number.parseFloat(light.split(',')[2])
    const darkL = Number.parseFloat(dark.split(',')[2])
    expect(lightL).toBeGreaterThan(darkL)
  })

  it('clamps intensities above 1 to the red end', () => {
    expect(heatmapFill(5, 'light')).toBe(heatmapFill(1, 'light'))
    expect(heatmapFill(5, 'dark')).toBe(heatmapFill(1, 'dark'))
  })

  it('returns null for negative or non-finite input', () => {
    expect(heatmapFill(-0.5, 'light')).toBeNull()
    expect(heatmapFill(Number.NaN, 'light')).toBeNull()
    expect(heatmapFill(Number.POSITIVE_INFINITY, 'light')).toBeNull()
  })
})

describe('outerHeatmapFillForCell', () => {
  it('returns null when cells is null (hook disabled)', () => {
    expect(outerHeatmapFillForCell(null, 10, 10, '1,2', 'light')).toBeNull()
  })

  it('returns null when the cell has no data at all', () => {
    expect(outerHeatmapFillForCell(cells([]), 10, 10, '1,2', 'light')).toBeNull()
  })

  it('scales by the hold axis when the cell has holds and the keyboard has seen any', () => {
    const map = cells([['1,2', { total: 10, tap: 2, hold: 8 }]])
    expect(outerHeatmapFillForCell(map, 8, 10, '1,2', 'light')).toBe(heatmapFill(1, 'light'))
  })

  it('falls back to the total axis for non-tap-hold cells', () => {
    const map = cells([['1,2', { total: 10, tap: 0, hold: 0 }]])
    // hold max is 0 — no hold axis data; use the total axis.
    expect(outerHeatmapFillForCell(map, 0, 10, '1,2', 'light')).toBe(heatmapFill(1, 'light'))
  })

  it('returns null when every axis is empty for this cell', () => {
    const map = cells([['1,2', { total: 0, tap: 0, hold: 0 }]])
    expect(outerHeatmapFillForCell(map, 0, 0, '1,2', 'light')).toBeNull()
  })

  it('honours the dark theme knob', () => {
    const map = cells([['1,2', { total: 10, tap: 2, hold: 8 }]])
    expect(outerHeatmapFillForCell(map, 8, 10, '1,2', 'dark')).toBe(heatmapFill(1, 'dark'))
  })
})

describe('innerHeatmapFillForCell', () => {
  it('returns null when cells is null', () => {
    expect(innerHeatmapFillForCell(null, 10, '1,2', 'light')).toBeNull()
  })

  it('returns null when the tap axis is empty', () => {
    const map = cells([['1,2', { total: 10, tap: 0, hold: 10 }]])
    expect(innerHeatmapFillForCell(map, 0, '1,2', 'light')).toBeNull()
    expect(innerHeatmapFillForCell(map, 10, '1,2', 'light')).toBeNull()
  })

  it('scales proportionally to maxTap when the cell has taps', () => {
    const map = cells([['1,2', { total: 10, tap: 5, hold: 5 }]])
    expect(innerHeatmapFillForCell(map, 10, '1,2', 'light')).toBe(heatmapFill(0.5, 'light'))
  })

  it('returns null for cells that never saw a press', () => {
    const map = cells([['1,2', { total: 10, tap: 5, hold: 5 }]])
    expect(innerHeatmapFillForCell(map, 10, '9,9', 'light')).toBeNull()
  })
})
