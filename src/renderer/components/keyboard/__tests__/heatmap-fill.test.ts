// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { paletteColorFromIntensity } from '../../../utils/chart-palette'
import { innerHeatmapFillForCell, outerHeatmapFillForCell } from '../heatmap-fill'
import type { TypingHeatmapCell } from '../../../../shared/types/typing-analytics'

function cells(entries: Array<[string, TypingHeatmapCell]>): Map<string, TypingHeatmapCell> {
  return new Map(entries)
}

describe('outerHeatmapFillForCell', () => {
  it('returns null when cells is null (hook disabled)', () => {
    expect(outerHeatmapFillForCell(null, 10, 10, '1,2', 'light')).toBeNull()
  })

  it('returns null when the cell has no data at all', () => {
    expect(outerHeatmapFillForCell(cells([]), 10, 10, '1,2', 'light')).toBeNull()
  })

  it('scales by the hold axis when the cell has holds and the keyboard has seen any', () => {
    const map = cells([['1,2', { total: 10, tap: 2, hold: 8 }]])
    expect(outerHeatmapFillForCell(map, 8, 10, '1,2', 'light')).toBe(paletteColorFromIntensity(1, 'light'))
  })

  it('falls back to the total axis for non-tap-hold cells', () => {
    const map = cells([['1,2', { total: 10, tap: 0, hold: 0 }]])
    // hold max is 0 — no hold axis data; use the total axis.
    expect(outerHeatmapFillForCell(map, 0, 10, '1,2', 'light')).toBe(paletteColorFromIntensity(1, 'light'))
  })

  it('returns null when every axis is empty for this cell', () => {
    const map = cells([['1,2', { total: 0, tap: 0, hold: 0 }]])
    expect(outerHeatmapFillForCell(map, 0, 0, '1,2', 'light')).toBeNull()
  })

  it('honours the dark theme knob', () => {
    const map = cells([['1,2', { total: 10, tap: 2, hold: 8 }]])
    expect(outerHeatmapFillForCell(map, 8, 10, '1,2', 'dark')).toBe(paletteColorFromIntensity(1, 'dark'))
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
    expect(innerHeatmapFillForCell(map, 10, '1,2', 'light')).toBe(paletteColorFromIntensity(0.5, 'light'))
  })

  it('returns null for cells that never saw a press', () => {
    const map = cells([['1,2', { total: 10, tap: 5, hold: 5 }]])
    expect(innerHeatmapFillForCell(map, 10, '9,9', 'light')).toBeNull()
  })
})
