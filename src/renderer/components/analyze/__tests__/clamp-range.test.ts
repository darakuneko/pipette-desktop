// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { clampRangeToBoundaries, getSnapshotBoundaries } from '../clamp-range'
import type { TypingKeymapSnapshotSummary } from '../../../../shared/types/typing-analytics'

function snap(savedAt: number): TypingKeymapSnapshotSummary {
  return {
    uid: 'kb',
    machineHash: 'h',
    productName: 'KB',
    savedAt,
    layers: 1,
    matrix: { rows: 1, cols: 1 },
  }
}

describe('getSnapshotBoundaries', () => {
  it('returns null when selectedSavedAt is null', () => {
    expect(getSnapshotBoundaries(null, [snap(50)], 300)).toBeNull()
  })

  it('returns null when summaries is empty', () => {
    expect(getSnapshotBoundaries(50, [], 300)).toBeNull()
  })

  it('returns null when selectedSavedAt is not in summaries', () => {
    expect(getSnapshotBoundaries(99, [snap(50)], 300)).toBeNull()
  })

  it('returns lo and hi for a mid snapshot using next.savedAt as upper bound', () => {
    expect(getSnapshotBoundaries(50, [snap(50), snap(300)], 500)).toEqual({ lo: 50, hi: 300 })
  })

  it('returns lo and nowMs for the latest snapshot', () => {
    expect(getSnapshotBoundaries(300, [snap(50), snap(300)], 500)).toEqual({ lo: 300, hi: 500 })
  })

  it('handles unsorted input', () => {
    expect(getSnapshotBoundaries(50, [snap(300), snap(50)], 500)).toEqual({ lo: 50, hi: 300 })
  })
})

describe('clampRangeToBoundaries', () => {
  it('passes range through when bounds is null', () => {
    const range = { fromMs: 100, toMs: 200 }
    expect(clampRangeToBoundaries(range, null)).toBe(range)
  })

  it('returns the same reference when range is already inside the bounds', () => {
    const range = { fromMs: 100, toMs: 200 }
    expect(clampRangeToBoundaries(range, { lo: 50, hi: 300 })).toBe(range)
  })

  it('clamps fromMs up to the lower boundary', () => {
    expect(
      clampRangeToBoundaries({ fromMs: 30, toMs: 200 }, { lo: 50, hi: 300 }),
    ).toEqual({ fromMs: 50, toMs: 200 })
  })

  it('clamps toMs down to the upper boundary', () => {
    expect(
      clampRangeToBoundaries({ fromMs: 60, toMs: 400 }, { lo: 50, hi: 300 }),
    ).toEqual({ fromMs: 60, toMs: 300 })
  })

  it('clamps both ends', () => {
    expect(
      clampRangeToBoundaries({ fromMs: 30, toMs: 400 }, { lo: 50, hi: 300 }),
    ).toEqual({ fromMs: 50, toMs: 300 })
  })

  it('collapses a range that falls completely below the boundary onto lo', () => {
    expect(
      clampRangeToBoundaries({ fromMs: 0, toMs: 40 }, { lo: 50, hi: 300 }),
    ).toEqual({ fromMs: 50, toMs: 50 })
  })

  it('collapses a range that falls completely above the boundary onto hi', () => {
    expect(
      clampRangeToBoundaries({ fromMs: 350, toMs: 400 }, { lo: 50, hi: 300 }),
    ).toEqual({ fromMs: 300, toMs: 300 })
  })
})
