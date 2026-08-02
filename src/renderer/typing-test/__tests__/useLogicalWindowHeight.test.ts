// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { logicalWindowHeight } from '../useLogicalWindowHeight'

describe('logicalWindowHeight', () => {
  it('falls back to minHeight outright when unmeasured (empty rowBottoms)', () => {
    expect(logicalWindowHeight([], 4, 144)).toBe(144)
  })

  it('uses the bottom of the displayLines-th row when there are more rows than displayLines', () => {
    // 5 rows of 24px each; displayLines=4 should stop at row index 3 (96),
    // well above the (deliberately low) minHeight floor.
    expect(logicalWindowHeight([24, 48, 72, 96, 120], 4, 10)).toBe(96)
  })

  it('uses the bottom of the last row when there are fewer rows than displayLines, if that exceeds minHeight', () => {
    // Only 2 rows (say each a tall wrapped logical line), summing past minHeight.
    expect(logicalWindowHeight([90, 200], 4, 144)).toBe(200)
  })

  it('never shrinks below minHeight for a short text with fewer/shorter rows than displayLines', () => {
    // 2 short rows only reach 48px total — the blank-window minimum (144) wins.
    expect(logicalWindowHeight([24, 48], 4, 144)).toBe(48 > 144 ? 48 : 144)
    expect(logicalWindowHeight([24, 48], 4, 144)).toBe(144)
  })

  it('handles displayLines === 1 (single-row window)', () => {
    expect(logicalWindowHeight([30, 60, 90], 1, 20)).toBe(30)
  })

  it('handles exactly displayLines rows (boundary — no extra row to spill into)', () => {
    expect(logicalWindowHeight([24, 48, 72, 96], 4, 10)).toBe(96)
  })

  it('handles a single measured row', () => {
    expect(logicalWindowHeight([40], 4, 10)).toBe(40)
  })

  it('clamps to the last row when displayLines exceeds rowBottoms.length by a lot', () => {
    expect(logicalWindowHeight([24, 48], 100, 10)).toBe(48)
  })
})
