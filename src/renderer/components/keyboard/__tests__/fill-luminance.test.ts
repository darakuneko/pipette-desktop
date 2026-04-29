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
  it('keeps the default dark label on the cool / mid hues of the light ramp', () => {
    // Light theme uses `--key-label` (#1f2937 dark text) on most
    // steps of the wide-hue palette so the heatmap reads with black
    // labels — the only exception is the saturated red tail (see
    // below).
    expect(shouldInvertText('hsl(209, 60%, 70.9%)', 'light')).toBe(false)
    expect(shouldInvertText('hsl(165, 60%, 66.5%)', 'light')).toBe(false)
    expect(shouldInvertText('hsl(60, 60%, 60%)', 'light')).toBe(false)
  })

  it('flips to the white inverse label on the red tail of the light ramp', () => {
    // Hues within ±30° of pure red trip the white-on-red exception so
    // the saturated end has the higher contrast it needs.
    expect(shouldInvertText('hsl(0, 60%, 50%)', 'light')).toBe(true)
    expect(shouldInvertText('hsl(22, 60%, 52.2%)', 'light')).toBe(true)
    expect(shouldInvertText('hsl(345, 60%, 50%)', 'light')).toBe(true)
  })

  it('flips to the near-black inverse label on the cool / mid hues of the dark ramp', () => {
    // Dark theme uses `--content-inverse` (#0f1117 near-black) by
    // default on the palette so the label reads as black across the
    // ramp, mirroring the light theme's default.
    expect(shouldInvertText('hsl(209, 65%, 65%)', 'dark')).toBe(true)
    expect(shouldInvertText('hsl(165, 65%, 60%)', 'dark')).toBe(true)
    expect(shouldInvertText('hsl(60, 65%, 55%)', 'dark')).toBe(true)
  })

  it('keeps the default light label on the red tail of the dark ramp', () => {
    // The same red exception holds in dark theme: the default light
    // `--key-label` reads better on saturated red than the near-black
    // inverse would.
    expect(shouldInvertText('hsl(0, 65%, 50%)', 'dark')).toBe(false)
    expect(shouldInvertText('hsl(22, 65%, 52.2%)', 'dark')).toBe(false)
    expect(shouldInvertText('hsl(345, 65%, 50%)', 'dark')).toBe(false)
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
