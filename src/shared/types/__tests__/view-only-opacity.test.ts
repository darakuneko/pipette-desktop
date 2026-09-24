// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  clampViewOnlyOpacity,
  VIEW_ONLY_OPACITY_DEFAULT,
  VIEW_ONLY_OPACITY_MAX,
  VIEW_ONLY_OPACITY_MIN,
} from '../pipette-settings'

describe('clampViewOnlyOpacity', () => {
  it('passes in-range values through unchanged', () => {
    expect(clampViewOnlyOpacity(0.5)).toBe(0.5)
    expect(clampViewOnlyOpacity(0.75)).toBe(0.75)
    expect(clampViewOnlyOpacity(1)).toBe(1)
  })

  it('clamps values below the minimum and above the maximum', () => {
    expect(clampViewOnlyOpacity(0)).toBe(VIEW_ONLY_OPACITY_MIN)
    expect(clampViewOnlyOpacity(-3)).toBe(VIEW_ONLY_OPACITY_MIN)
    expect(clampViewOnlyOpacity(0.49)).toBe(VIEW_ONLY_OPACITY_MIN)
    expect(clampViewOnlyOpacity(1.01)).toBe(VIEW_ONLY_OPACITY_MAX)
    expect(clampViewOnlyOpacity(80)).toBe(VIEW_ONLY_OPACITY_MAX)
  })

  it('falls back to the default for non-finite numbers', () => {
    expect(clampViewOnlyOpacity(Number.NaN)).toBe(VIEW_ONLY_OPACITY_DEFAULT)
    expect(clampViewOnlyOpacity(Number.POSITIVE_INFINITY)).toBe(VIEW_ONLY_OPACITY_DEFAULT)
    expect(clampViewOnlyOpacity(Number.NEGATIVE_INFINITY)).toBe(VIEW_ONLY_OPACITY_DEFAULT)
  })

  it('falls back to the default for non-number input', () => {
    expect(clampViewOnlyOpacity('0.6')).toBe(VIEW_ONLY_OPACITY_DEFAULT)
    expect(clampViewOnlyOpacity(null)).toBe(VIEW_ONLY_OPACITY_DEFAULT)
    expect(clampViewOnlyOpacity(undefined)).toBe(VIEW_ONLY_OPACITY_DEFAULT)
    expect(clampViewOnlyOpacity({})).toBe(VIEW_ONLY_OPACITY_DEFAULT)
  })
})
