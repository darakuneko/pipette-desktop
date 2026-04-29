// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  BIGRAM_BUCKET_UPPER_BOUNDS_MS,
  bucketizeIki,
} from '../bigram-bucket'
import { BIGRAM_HIST_BUCKETS } from '../jsonl/jsonl-row'

describe('bucketizeIki', () => {
  it('returns an all-zero histogram for an empty array', () => {
    const hist = bucketizeIki([])
    expect(hist).toHaveLength(BIGRAM_HIST_BUCKETS)
    expect(hist.every((n) => n === 0)).toBe(true)
  })

  it('places values strictly below the first boundary into bucket 0', () => {
    expect(bucketizeIki([0, 1, 30, 59])).toEqual([4, 0, 0, 0, 0, 0, 0, 0])
  })

  it('places boundary values into the bucket whose lower edge they sit on', () => {
    // Each upper bound is exclusive — the boundary value belongs to the
    // next bucket. 60 → bucket 1, 100 → bucket 2, etc.
    expect(bucketizeIki([60])).toEqual([0, 1, 0, 0, 0, 0, 0, 0])
    expect(bucketizeIki([100])).toEqual([0, 0, 1, 0, 0, 0, 0, 0])
    expect(bucketizeIki([150])).toEqual([0, 0, 0, 1, 0, 0, 0, 0])
    expect(bucketizeIki([200])).toEqual([0, 0, 0, 0, 1, 0, 0, 0])
    expect(bucketizeIki([300])).toEqual([0, 0, 0, 0, 0, 1, 0, 0])
    expect(bucketizeIki([500])).toEqual([0, 0, 0, 0, 0, 0, 1, 0])
    expect(bucketizeIki([1000])).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
  })

  it('places values above the last boundary into the final bucket', () => {
    expect(bucketizeIki([1500, 60_000, 299_999])).toEqual([0, 0, 0, 0, 0, 0, 0, 3])
  })

  it('counts duplicates per bucket', () => {
    // 50 → b0, 80 → b1, 80 → b1, 250 → b4, 250 → b4, 250 → b4
    expect(bucketizeIki([50, 80, 80, 250, 250, 250])).toEqual([1, 2, 0, 0, 3, 0, 0, 0])
  })

  it('exports boundary array of expected length and shape', () => {
    expect(BIGRAM_BUCKET_UPPER_BOUNDS_MS).toHaveLength(BIGRAM_HIST_BUCKETS)
    // Final bucket has open upper bound — sentinel is positive infinity.
    expect(BIGRAM_BUCKET_UPPER_BOUNDS_MS[BIGRAM_HIST_BUCKETS - 1]).toBe(Number.POSITIVE_INFINITY)
    // Boundaries must be strictly ascending so bucketIndex's first-match
    // scan returns the correct bucket.
    for (let i = 1; i < BIGRAM_BUCKET_UPPER_BOUNDS_MS.length; i += 1) {
      expect(BIGRAM_BUCKET_UPPER_BOUNDS_MS[i]).toBeGreaterThan(BIGRAM_BUCKET_UPPER_BOUNDS_MS[i - 1])
    }
  })
})
