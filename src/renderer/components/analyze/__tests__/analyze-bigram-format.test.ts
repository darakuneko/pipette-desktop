// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { bigramPairLabel, rolloverRatioFromEntry } from '../analyze-bigram-format'

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
    expect(bigramPairLabel('4_11_42_11')).toBe('4_11_42_11')
    expect(bigramPairLabel('4_')).toBe('4_')
    expect(bigramPairLabel('4__42')).toBe('4__42')
  })

  it('falls back to the raw id when any side is non-numeric', () => {
    expect(bigramPairLabel('foo_11')).toBe('foo_11')
    expect(bigramPairLabel('4_bar')).toBe('4_bar')
    expect(bigramPairLabel('4_11_bar')).toBe('4_11_bar')
  })

  it('decodes a trigram id (k1_k2_k3) into prev → mid → curr labels', () => {
    // KC_A = 4, KC_H = 11, KC_BSPC = 42.
    expect(bigramPairLabel('4_11_42')).toBe('A → H → Bksp')
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

describe('rolloverRatioFromEntry', () => {
  it('delegates to the shared rolloverRatio contract (entry adapter only)', () => {
    expect(rolloverRatioFromEntry({ overlapCount: 1, overlapN: 4 })).toBe(0.25)
  })

  it('returns null when overlapN is null, undefined, or 0 (no determined-overlap sample)', () => {
    expect(rolloverRatioFromEntry({ overlapCount: null, overlapN: null })).toBeNull()
    expect(rolloverRatioFromEntry({})).toBeNull()
    expect(rolloverRatioFromEntry({ overlapCount: 0, overlapN: 0 })).toBeNull()
  })

  it('returns a real 0 when overlapCount is 0 but overlapN is positive', () => {
    expect(rolloverRatioFromEntry({ overlapCount: 0, overlapN: 5 })).toBe(0)
  })

  it('returns null (not a fabricated 0) when overlapCount is missing but overlapN is positive', () => {
    // A malformed/mismatched entry — `overlapCount ?? 0` would silently
    // manufacture a fake 0% here; the local `== null` guard rejects it
    // instead of relying on `rolloverRatio`'s `on` check to catch it.
    expect(rolloverRatioFromEntry({ overlapCount: null, overlapN: 5 })).toBeNull()
    expect(rolloverRatioFromEntry({ overlapN: 5 })).toBeNull()
  })
})
