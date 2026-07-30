// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { sdFromSums } from '../stat-sums'

describe('sdFromSums', () => {
  it('returns null for fewer than 2 samples', () => {
    expect(sdFromSums(90, 8_100, 1)).toBeNull()
    expect(sdFromSums(0, 0, 0)).toBeNull()
  })

  it('computes the population SD from sum/sumSq/count', () => {
    // Values [80, 120]: mean=100, variance=((80-100)^2+(120-100)^2)/2=400, sd=20
    const sum = 80 + 120
    const sumSq = 80 * 80 + 120 * 120
    expect(sdFromSums(sum, sumSq, 2)).toBeCloseTo(20, 10)
  })

  it('clips a tiny negative variance from floating-point rounding to 0', () => {
    // Equal values -> true variance is exactly 0; rounding could nudge
    // sumSq/n - mean^2 very slightly negative without the Math.max clamp.
    expect(sdFromSums(200, 20_000, 2)).toBe(0)
  })
})
