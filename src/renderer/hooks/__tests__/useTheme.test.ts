// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach } from 'vitest'
import { applyPackColors, clearPackColors } from '../useTheme'
import { THEME_COLOR_KEYS, type ThemePackColors } from '../../../shared/types/theme-store'
import { DEFAULT_SIMULATED_COLOR } from '../../utils/simulated-color'

function baseColors(overrides: Partial<ThemePackColors> = {}): ThemePackColors {
  const colors = {} as ThemePackColors
  for (const key of THEME_COLOR_KEYS) {
    colors[key] = '#123456'
  }
  colors['key-label-remap'] = '#0000ff'
  return { ...colors, ...overrides }
}

describe('applyPackColors / clearPackColors', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style')
  })

  it('sets every required color token as a CSS custom property', () => {
    applyPackColors(baseColors(), 'dark')
    const root = document.documentElement
    for (const key of THEME_COLOR_KEYS) {
      const expected = key === 'key-label-remap' ? '#0000ff' : '#123456'
      expect(root.style.getPropertyValue(`--${key}`)).toBe(expected)
    }
    expect(root.style.getPropertyValue('color-scheme')).toBe('dark')
  })

  it('uses the pack-defined key-label-simulated value when present', () => {
    applyPackColors(baseColors({ 'key-label-simulated': '#ff00ff' }), 'dark')
    expect(document.documentElement.style.getPropertyValue('--key-label-simulated')).toBe('#ff00ff')
  })

  it('derives key-label-simulated from key-label-remap when absent (light mode)', () => {
    // #0000ff (blue) rotated 180 -> yellow, light clamp min(l,50) is a
    // no-op here since blue is already at l=50.
    applyPackColors(baseColors(), 'light')
    expect(document.documentElement.style.getPropertyValue('--key-label-simulated')).toBe('#ffff00')
  })

  it('falls back to the built-in default when key-label-remap is achromatic', () => {
    applyPackColors(baseColors({ 'key-label-remap': '#808080' }), 'dark')
    expect(document.documentElement.style.getPropertyValue('--key-label-simulated')).toBe(DEFAULT_SIMULATED_COLOR.dark)
  })

  it('clearPackColors removes every required token, key-label-simulated, and color-scheme', () => {
    applyPackColors(baseColors({ 'key-label-simulated': '#ff00ff' }), 'dark')
    clearPackColors()
    const root = document.documentElement
    for (const key of THEME_COLOR_KEYS) {
      expect(root.style.getPropertyValue(`--${key}`)).toBe('')
    }
    expect(root.style.getPropertyValue('--key-label-simulated')).toBe('')
    expect(root.style.getPropertyValue('color-scheme')).toBe('')
  })

  it('leaves wire-row unset (falls through to the stylesheet accent default) and derives wire-col when the pack omits both', () => {
    // baseColors() sets every required key (including accent) to
    // '#123456'. wire-row is left unset inline so style.css's own
    // `var(--accent)` default applies via the cascade; wire-col should be
    // deriveSimulatedColor('#123456', 'dark', DEFAULT_WIRE_COL_COLOR), not
    // a literal re-derivation here (that would just duplicate the
    // implementation).
    applyPackColors(baseColors(), 'dark')
    const root = document.documentElement
    expect(root.style.getPropertyValue('--wire-row')).toBe('')
    expect(root.style.getPropertyValue('--wire-col')).not.toBe('')
    expect(root.style.getPropertyValue('--wire-col')).not.toBe('#123456')
  })

  it('uses the pack-defined wire-row/wire-col values verbatim when present', () => {
    applyPackColors(baseColors({ 'wire-row': '#111111', 'wire-col': '#222222' }), 'light')
    const root = document.documentElement
    expect(root.style.getPropertyValue('--wire-row')).toBe('#111111')
    expect(root.style.getPropertyValue('--wire-col')).toBe('#222222')
  })

  it('clearPackColors removes wire-row and wire-col', () => {
    applyPackColors(baseColors({ 'wire-row': '#111111', 'wire-col': '#222222' }), 'light')
    clearPackColors()
    const root = document.documentElement
    expect(root.style.getPropertyValue('--wire-row')).toBe('')
    expect(root.style.getPropertyValue('--wire-col')).toBe('')
  })
})
