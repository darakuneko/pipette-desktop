// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { bigramPairLabel } from '../analyze-bigram-format'

describe('bigramPairLabel', () => {
  it('decodes a numeric pair id into prev → curr labels', () => {
    // KC_A = 4, KC_H = 11.
    expect(bigramPairLabel('4_11')).toBe('A → H')
  })

  it('survives same-key repeats (e.g. backspace held)', () => {
    // KC_BSPC = 0x2A = 42.
    expect(bigramPairLabel('42_42')).toBe('Bksp → Bksp')
  })

  it('falls back to the raw id when the format is malformed', () => {
    expect(bigramPairLabel('not-a-bigram')).toBe('not-a-bigram')
    expect(bigramPairLabel('4_11_22')).toBe('4_11_22')
    expect(bigramPairLabel('4_')).toBe('4_')
  })

  it('falls back to the raw id when either side is non-numeric', () => {
    expect(bigramPairLabel('foo_11')).toBe('foo_11')
    expect(bigramPairLabel('4_bar')).toBe('4_bar')
  })

  it('decodes layer-tap mask codes via the static template fallback', () => {
    // 16684 = 0x412C = LT1(KC_SPACE). Even when the keyboard's layer-
    // count-driven Keycode objects haven't been built yet (analyze
    // rendered before keymap load), the protocol's mask-template
    // reverse map should still produce a meaningful label rather than
    // bare hex.
    const label = bigramPairLabel('16684_4')
    expect(label.startsWith('0x')).toBe(false)
    expect(label).toContain('LT1')
    expect(label).toContain(' → ')
    // Right-hand side is KC_A, which is always populated.
    expect(label.endsWith('A')).toBe(true)
  })
})
