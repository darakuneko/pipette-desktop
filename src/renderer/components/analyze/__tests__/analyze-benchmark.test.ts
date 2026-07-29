// SPDX-License-Identifier: GPL-2.0-or-later
// Pure-logic coverage for the benchmark z-position classifier. Boundary
// values are pinned exactly since the ≤ rule decides which side of the
// 0.5 / 1.5 cutoffs a value lands on.

import { describe, it, expect } from 'vitest'
import { benchmarkPosition } from '../analyze-benchmark'
import type { BenchmarkStat } from '../../../../shared/typing-benchmarks'

const STAT: BenchmarkStat = { mean: 100, sd: 20 }

describe('benchmarkPosition', () => {
  it('computes z as (value - mean) / sd', () => {
    const result = benchmarkPosition(140, STAT)
    expect(result?.z).toBeCloseTo(2, 10)
  })

  it('labels z = 0 as average', () => {
    expect(benchmarkPosition(100, STAT)?.label).toBe('average')
  })

  it('labels z = +0.5 as average (inner boundary, inclusive)', () => {
    expect(benchmarkPosition(110, STAT)?.label).toBe('average')
  })

  it('labels z = -0.5 as average (inner boundary, inclusive)', () => {
    expect(benchmarkPosition(90, STAT)?.label).toBe('average')
  })

  it('labels z just above +0.5 as above', () => {
    expect(benchmarkPosition(110.01, STAT)?.label).toBe('above')
  })

  it('labels z just below -0.5 as below', () => {
    expect(benchmarkPosition(89.99, STAT)?.label).toBe('below')
  })

  it('labels z = +1.5 as above (outer boundary, inclusive)', () => {
    expect(benchmarkPosition(130, STAT)?.label).toBe('above')
  })

  it('labels z = -1.5 as below (outer boundary, inclusive)', () => {
    expect(benchmarkPosition(70, STAT)?.label).toBe('below')
  })

  it('labels z just above +1.5 as farAbove', () => {
    expect(benchmarkPosition(130.01, STAT)?.label).toBe('farAbove')
  })

  it('labels z just below -1.5 as farBelow', () => {
    expect(benchmarkPosition(69.99, STAT)?.label).toBe('farBelow')
  })

  it('returns null when sd is zero', () => {
    expect(benchmarkPosition(100, { mean: 100, sd: 0 })).toBeNull()
  })

  it('returns null when sd is negative', () => {
    expect(benchmarkPosition(100, { mean: 100, sd: -1 })).toBeNull()
  })

  it('returns null when value is NaN', () => {
    expect(benchmarkPosition(Number.NaN, STAT)).toBeNull()
  })

  it('returns null when value is Infinity', () => {
    expect(benchmarkPosition(Number.POSITIVE_INFINITY, STAT)).toBeNull()
  })

  it('returns null when value is -Infinity', () => {
    expect(benchmarkPosition(Number.NEGATIVE_INFINITY, STAT)).toBeNull()
  })
})
