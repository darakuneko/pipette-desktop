// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { shouldInvertText } from '../fill-luminance'

describe('shouldInvertText — registered fills', () => {
  it('returns false for null/undefined/empty', () => {
    expect(shouldInvertText(null, 'light')).toBe(false)
    expect(shouldInvertText(undefined, 'light')).toBe(false)
    expect(shouldInvertText('', 'light')).toBe(false)
  })

  it('keeps the default label on neutral surfaces', () => {
    for (const theme of ['light', 'dark'] as const) {
      expect(shouldInvertText('var(--key-bg)', theme)).toBe(false)
      expect(shouldInvertText('var(--key-bg-hover)', theme)).toBe(false)
      expect(shouldInvertText('var(--key-mask-bg)', theme)).toBe(false)
      expect(shouldInvertText('var(--key-bg-multi-selected)', theme)).toBe(false)
    }
  })

  it('inverts on strong interactive accents in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      expect(shouldInvertText('var(--key-bg-active)', theme)).toBe(true)
      expect(shouldInvertText('var(--accent-alt)', theme)).toBe(true)
    }
  })

  it('flips pressed green only in dark theme (light label washes out)', () => {
    expect(shouldInvertText('var(--success)', 'light')).toBe(false)
    expect(shouldInvertText('var(--success)', 'dark')).toBe(true)
  })

  it('flips ever-pressed #ccffcc only in dark theme', () => {
    expect(shouldInvertText('#ccffcc', 'light')).toBe(false)
    expect(shouldInvertText('#ccffcc', 'dark')).toBe(true)
  })
})

describe('shouldInvertText — heatmap HSL fills', () => {
  it('keeps the default label on the cool end of the light ramp', () => {
    // Light ramp starts at L=72% (blue/cyan) — comfortably lit, dark
    // label reads fine.
    expect(shouldInvertText('hsl(209, 60%, 70.9%)', 'light')).toBe(false)
    expect(shouldInvertText('hsl(165, 60%, 66.5%)', 'light')).toBe(false)
  })

  it('inverts the warm end of the light ramp where the dark label fades', () => {
    // Light ramp ends at L=50% (red) — dark label fights the fill so
    // swap to the inverse label.
    expect(shouldInvertText('hsl(0, 60%, 50%)', 'light')).toBe(true)
    expect(shouldInvertText('hsl(22, 60%, 52.2%)', 'light')).toBe(true)
  })

  it('keeps the default label on the cool end of the dark ramp', () => {
    // Dark ramp starts at L=32% (deep blue) — light label reads fine.
    expect(shouldInvertText('hsl(209, 65%, 32.8%)', 'dark')).toBe(false)
    expect(shouldInvertText('hsl(165, 65%, 36%)', 'dark')).toBe(false)
  })

  it('inverts the warm end of the dark ramp where light label fades', () => {
    // Dark ramp ends at L=48% — light label loses contrast on the red
    // so flip to the inverse.
    expect(shouldInvertText('hsl(0, 65%, 48%)', 'dark')).toBe(true)
    expect(shouldInvertText('hsl(22, 65%, 46.4%)', 'dark')).toBe(true)
  })
})

describe('shouldInvertText — unregistered fills', () => {
  it('leaves unknown literal colours alone (rule: only vetted fills)', () => {
    // Caller must register the fill in FILL_INVERT_TABLE to opt in.
    expect(shouldInvertText('#123456', 'light')).toBe(false)
    expect(shouldInvertText('#123456', 'dark')).toBe(false)
    expect(shouldInvertText('rgb(200, 100, 50)', 'light')).toBe(false)
    expect(shouldInvertText('transparent', 'dark')).toBe(false)
  })

  it('ignores malformed HSL strings rather than guessing', () => {
    expect(shouldInvertText('hsl(not, a, triple)', 'light')).toBe(false)
    expect(shouldInvertText('hsl(0, 50%)', 'light')).toBe(false)
  })
})
