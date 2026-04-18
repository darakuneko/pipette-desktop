// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TAPPING_TERM_MS,
  QSID_TAPPING_TERM,
  resolveTappingTermMs,
} from '../qmk-settings-tapping-term'

describe('resolveTappingTermMs', () => {
  it('returns the default when the keyboard has no QMK settings', () => {
    expect(resolveTappingTermMs(undefined)).toBe(DEFAULT_TAPPING_TERM_MS)
  })

  it('returns the default when TAPPING_TERM is missing from the blob', () => {
    expect(resolveTappingTermMs({})).toBe(DEFAULT_TAPPING_TERM_MS)
  })

  it('returns the default when the stored bytes are truncated', () => {
    expect(resolveTappingTermMs({ [String(QSID_TAPPING_TERM)]: [0xC8] })).toBe(
      DEFAULT_TAPPING_TERM_MS,
    )
  })

  it('returns the default when TAPPING_TERM is zero (treated as unset)', () => {
    expect(resolveTappingTermMs({ [String(QSID_TAPPING_TERM)]: [0x00, 0x00] })).toBe(
      DEFAULT_TAPPING_TERM_MS,
    )
  })

  it('decodes the configured TAPPING_TERM as little-endian u16', () => {
    // 0xC8 0x00 = 200
    expect(resolveTappingTermMs({ [String(QSID_TAPPING_TERM)]: [0xC8, 0x00] })).toBe(200)
    // 0x2C 0x01 = 300
    expect(resolveTappingTermMs({ [String(QSID_TAPPING_TERM)]: [0x2C, 0x01] })).toBe(300)
    // 0x10 0x27 = 10000
    expect(resolveTappingTermMs({ [String(QSID_TAPPING_TERM)]: [0x10, 0x27] })).toBe(10000)
  })
})
