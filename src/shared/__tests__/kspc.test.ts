// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { computeKspc, formatKspc } from '../kspc'

describe('computeKspc', () => {
  it('divides total keystrokes by confirmed chars', () => {
    expect(computeKspc(6, 4)).toBe(1.5)
    expect(computeKspc(5, 5)).toBe(1)
  })

  it('returns null on zero confirmed chars (avoids division by zero)', () => {
    expect(computeKspc(5, 0)).toBeNull()
  })

  it('returns null on negative confirmed chars', () => {
    expect(computeKspc(5, -1)).toBeNull()
  })

  it('returns null on negative keystrokes', () => {
    expect(computeKspc(-1, 5)).toBeNull()
  })

  it('returns null on non-finite inputs', () => {
    expect(computeKspc(NaN, 5)).toBeNull()
    expect(computeKspc(5, Infinity)).toBeNull()
  })
})

describe('formatKspc', () => {
  it('formats to 2 decimal places', () => {
    expect(formatKspc(1.5)).toBe('1.50')
    expect(formatKspc(1)).toBe('1.00')
    expect(formatKspc(1.234)).toBe('1.23')
  })
})
