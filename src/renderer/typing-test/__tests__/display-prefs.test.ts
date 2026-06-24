// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  clampDisplayLines,
  clampFontSize,
  DEFAULT_DISPLAY_LINES,
  DEFAULT_FONT_SIZE,
  DISPLAY_LINES_MIN,
  DISPLAY_LINES_MAX,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
} from '../types'

describe('clampDisplayLines', () => {
  it('keeps in-range integers', () => {
    expect(clampDisplayLines(4)).toBe(4)
    expect(clampDisplayLines(DEFAULT_DISPLAY_LINES)).toBe(DEFAULT_DISPLAY_LINES)
  })
  it('clamps below/above the range', () => {
    expect(clampDisplayLines(0)).toBe(DISPLAY_LINES_MIN)
    expect(clampDisplayLines(1)).toBe(DISPLAY_LINES_MIN)
    expect(clampDisplayLines(99)).toBe(DISPLAY_LINES_MAX)
  })
  it('rounds fractional values', () => {
    expect(clampDisplayLines(4.6)).toBe(5)
  })
})

describe('clampFontSize', () => {
  it('keeps in-range even sizes', () => {
    expect(clampFontSize(24)).toBe(24)
    expect(clampFontSize(DEFAULT_FONT_SIZE)).toBe(DEFAULT_FONT_SIZE)
  })
  it('snaps odd values to the nearest even step', () => {
    expect(clampFontSize(25)).toBe(26)
    expect(clampFontSize(23)).toBe(24)
  })
  it('clamps below/above the range', () => {
    expect(clampFontSize(2)).toBe(FONT_SIZE_MIN)
    expect(clampFontSize(100)).toBe(FONT_SIZE_MAX)
  })
})
