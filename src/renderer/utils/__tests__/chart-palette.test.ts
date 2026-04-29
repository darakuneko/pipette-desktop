// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { chartSeriesColor, paletteColorFromIntensity } from '../chart-palette'

describe('paletteColorFromIntensity', () => {
  it('returns null below the visibility floor (sqrt(t) < 0.05)', () => {
    // 0.0024 after sqrt is ~0.049 — still below the floor.
    expect(paletteColorFromIntensity(0, 'light')).toBeNull()
    expect(paletteColorFromIntensity(0.0024, 'light')).toBeNull()
    expect(paletteColorFromIntensity(0, 'dark')).toBeNull()
    expect(paletteColorFromIntensity(0.0024, 'dark')).toBeNull()
  })

  it('starts at the cool (blue) end just above the floor', () => {
    // sqrt(0.01) = 0.1 → hue = 220 - 220*0.1 = 198°, saturation follows
    // the theme knob (60% light / 65% dark).
    expect(paletteColorFromIntensity(0.01, 'light')).toMatch(/^hsl\(198, 60%, /)
    expect(paletteColorFromIntensity(0.01, 'dark')).toMatch(/^hsl\(198, 65%, /)
  })

  it('ends at the warm (red) end at intensity 1', () => {
    expect(paletteColorFromIntensity(1, 'light')).toBe('hsl(0, 60%, 50%)')
    expect(paletteColorFromIntensity(1, 'dark')).toBe('hsl(0, 65%, 50%)')
  })

  it('rides a lighter lightness in light theme than in dark', () => {
    // Light theme keeps the ramp lighter than dark theme — both ramps
    // were tuned to keep a near-black label legible across every step.
    const light = paletteColorFromIntensity(0.5, 'light') ?? ''
    const dark = paletteColorFromIntensity(0.5, 'dark') ?? ''
    const lightL = Number.parseFloat(light.split(',')[2])
    const darkL = Number.parseFloat(dark.split(',')[2])
    expect(lightL).toBeGreaterThan(darkL)
  })

  it('clamps intensities above 1 to the red end', () => {
    expect(paletteColorFromIntensity(5, 'light')).toBe(paletteColorFromIntensity(1, 'light'))
    expect(paletteColorFromIntensity(5, 'dark')).toBe(paletteColorFromIntensity(1, 'dark'))
  })

  it('returns null for negative or non-finite input', () => {
    expect(paletteColorFromIntensity(-0.5, 'light')).toBeNull()
    expect(paletteColorFromIntensity(Number.NaN, 'light')).toBeNull()
    expect(paletteColorFromIntensity(Number.POSITIVE_INFINITY, 'light')).toBeNull()
  })
})

describe('chartSeriesColor', () => {
  it('places series 0 at the cool (blue) end and series N-1 at the warm (red) end', () => {
    expect(chartSeriesColor(0, 2, 'light')).toBe('hsl(220, 60%, 72%)')
    expect(chartSeriesColor(1, 2, 'light')).toBe('hsl(0, 60%, 50%)')
    expect(chartSeriesColor(0, 2, 'dark')).toBe('hsl(220, 65%, 65%)')
    expect(chartSeriesColor(1, 2, 'dark')).toBe('hsl(0, 65%, 50%)')
  })

  it('returns the cool end alone when total === 1', () => {
    expect(chartSeriesColor(0, 1, 'light')).toBe('hsl(220, 60%, 72%)')
    expect(chartSeriesColor(0, 1, 'dark')).toBe('hsl(220, 65%, 65%)')
  })

  it('clamps out-of-range index to the last series', () => {
    expect(chartSeriesColor(5, 2, 'light')).toBe(chartSeriesColor(1, 2, 'light'))
    expect(chartSeriesColor(-1, 2, 'light')).toBe(chartSeriesColor(0, 2, 'light'))
  })

  it('falls back to the cool end through the shared formula on invalid totals', () => {
    // The fallback flows through `hslFromRampT(0, theme)` so a future
    // palette retune carries to garbage-input callers automatically.
    expect(chartSeriesColor(0, 0, 'light')).toBe('hsl(220, 60%, 72%)')
    expect(chartSeriesColor(0, 0, 'dark')).toBe('hsl(220, 65%, 65%)')
    expect(chartSeriesColor(0, -1, 'light')).toBe('hsl(220, 60%, 72%)')
    expect(chartSeriesColor(Number.NaN, 1, 'light')).toBe('hsl(220, 60%, 72%)')
    // `total = NaN` must not slip past the guard and produce
    // `hsl(NaN, ...)`, which would render as a broken CSS string.
    expect(chartSeriesColor(0, Number.NaN, 'light')).toBe('hsl(220, 60%, 72%)')
    expect(chartSeriesColor(0, Number.POSITIVE_INFINITY, 'dark')).toBe('hsl(220, 65%, 65%)')
  })
})
