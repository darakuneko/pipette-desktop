// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { DURATION_BUCKET_CENTERS_MS, DURATION_BUCKET_UPPER_BOUNDS_MS } from '../duration-buckets'

describe('DURATION_BUCKET_UPPER_BOUNDS_MS', () => {
  it('has 8 buckets with a positive-infinity tail', () => {
    expect(DURATION_BUCKET_UPPER_BOUNDS_MS).toHaveLength(8)
    expect(DURATION_BUCKET_UPPER_BOUNDS_MS[7]).toBe(Number.POSITIVE_INFINITY)
  })

  it('is strictly ascending so the bucket scan is well-defined', () => {
    for (let i = 1; i < DURATION_BUCKET_UPPER_BOUNDS_MS.length; i += 1) {
      expect(DURATION_BUCKET_UPPER_BOUNDS_MS[i]).toBeGreaterThan(DURATION_BUCKET_UPPER_BOUNDS_MS[i - 1])
    }
  })
})

describe('DURATION_BUCKET_CENTERS_MS', () => {
  it('has one center per bucket', () => {
    expect(DURATION_BUCKET_CENTERS_MS).toHaveLength(DURATION_BUCKET_UPPER_BOUNDS_MS.length)
  })

  it('places each center strictly inside its bucket\'s span', () => {
    let lower = 0
    for (let i = 0; i < DURATION_BUCKET_CENTERS_MS.length - 1; i += 1) {
      const upper = DURATION_BUCKET_UPPER_BOUNDS_MS[i]
      expect(DURATION_BUCKET_CENTERS_MS[i]).toBeGreaterThanOrEqual(lower)
      expect(DURATION_BUCKET_CENTERS_MS[i]).toBeLessThan(upper)
      lower = upper
    }
    // Final bucket is open-ended — its center is a synthetic estimate
    // beyond the last finite bound, not inside a closed span.
    const lastCenter = DURATION_BUCKET_CENTERS_MS[DURATION_BUCKET_CENTERS_MS.length - 1]
    const lastFiniteBound = DURATION_BUCKET_UPPER_BOUNDS_MS[DURATION_BUCKET_UPPER_BOUNDS_MS.length - 2]
    expect(lastCenter).toBeGreaterThan(lastFiniteBound)
  })
})
