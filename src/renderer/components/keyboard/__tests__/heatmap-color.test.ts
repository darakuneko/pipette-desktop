// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { heatmapFill, outerHeatmapFillForCell, innerHeatmapFillForCell } from '../heatmap-color'
import type { TypingHeatmapCell } from '../../../../shared/types/typing-analytics'

function cells(entries: Array<[string, TypingHeatmapCell]>): Map<string, TypingHeatmapCell> {
  return new Map(entries)
}

describe('heatmapFill', () => {
  it('returns a yellow fill at intensity 0', () => {
    expect(heatmapFill(0)).toContain('hsl(60, 70%,')
  })

  it('returns a red fill at intensity 1', () => {
    expect(heatmapFill(1)).toContain('hsl(0, 70%,')
  })

  it('clamps intensities above 1 to the red end', () => {
    expect(heatmapFill(5)).toBe(heatmapFill(1))
  })

  it('clamps intensities below 0 to the yellow end', () => {
    expect(heatmapFill(-0.5)).toBe(heatmapFill(0))
  })
})

describe('outerHeatmapFillForCell', () => {
  it('returns null when cells is null (hook disabled)', () => {
    expect(outerHeatmapFillForCell(null, 10, 10, '1,2')).toBeNull()
  })

  it('returns null when the cell has no data at all', () => {
    expect(outerHeatmapFillForCell(cells([]), 10, 10, '1,2')).toBeNull()
  })

  it('scales by the hold axis when the cell has holds and the keyboard has seen any', () => {
    const map = cells([['1,2', { total: 10, tap: 2, hold: 8 }]])
    expect(outerHeatmapFillForCell(map, 8, 10, '1,2')).toBe(heatmapFill(1))
  })

  it('falls back to the total axis for non-tap-hold cells', () => {
    const map = cells([['1,2', { total: 10, tap: 0, hold: 0 }]])
    // hold max is 0 — no hold axis data; use the total axis.
    expect(outerHeatmapFillForCell(map, 0, 10, '1,2')).toBe(heatmapFill(1))
  })

  it('returns null when every axis is empty for this cell', () => {
    const map = cells([['1,2', { total: 0, tap: 0, hold: 0 }]])
    expect(outerHeatmapFillForCell(map, 0, 0, '1,2')).toBeNull()
  })
})

describe('innerHeatmapFillForCell', () => {
  it('returns null when cells is null', () => {
    expect(innerHeatmapFillForCell(null, 10, '1,2')).toBeNull()
  })

  it('returns null when the tap axis is empty', () => {
    const map = cells([['1,2', { total: 10, tap: 0, hold: 10 }]])
    expect(innerHeatmapFillForCell(map, 0, '1,2')).toBeNull()
    expect(innerHeatmapFillForCell(map, 10, '1,2')).toBeNull()
  })

  it('scales proportionally to maxTap when the cell has taps', () => {
    const map = cells([['1,2', { total: 10, tap: 5, hold: 5 }]])
    expect(innerHeatmapFillForCell(map, 10, '1,2')).toBe(heatmapFill(0.5))
  })

  it('returns null for cells that never saw a press', () => {
    const map = cells([['1,2', { total: 10, tap: 5, hold: 5 }]])
    expect(innerHeatmapFillForCell(map, 10, '9,9')).toBeNull()
  })
})
