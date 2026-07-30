// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TAPPING_TERM_MS,
  QSID_TAPPING_TERM,
  resolveConnectedTappingTerm,
  resolveTappingTerm,
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

describe('resolveTappingTerm', () => {
  it('reports false and the default when the keyboard has no QMK settings', () => {
    expect(resolveTappingTerm(undefined)).toEqual({ termMs: DEFAULT_TAPPING_TERM_MS, reported: false })
  })

  it('reports false when TAPPING_TERM is missing from the blob', () => {
    expect(resolveTappingTerm({})).toEqual({ termMs: DEFAULT_TAPPING_TERM_MS, reported: false })
  })

  it('reports false — not true — for a malformed (truncated) payload, even though the key is present', () => {
    // The key exists in the blob, but a naive "is the key present" check
    // would wrongly report `true` here — `reported` must track the same
    // validity rule the ms decoding falls back under, not mere presence.
    expect(resolveTappingTerm({ [String(QSID_TAPPING_TERM)]: [0xC8] })).toEqual({
      termMs: DEFAULT_TAPPING_TERM_MS,
      reported: false,
    })
  })

  it('reports false for a legal-but-unusable zero payload', () => {
    expect(resolveTappingTerm({ [String(QSID_TAPPING_TERM)]: [0x00, 0x00] })).toEqual({
      termMs: DEFAULT_TAPPING_TERM_MS,
      reported: false,
    })
  })

  it('reports true with the decoded value for a well-formed, non-zero payload', () => {
    expect(resolveTappingTerm({ [String(QSID_TAPPING_TERM)]: [0xC8, 0x00] })).toEqual({
      termMs: 200,
      reported: true,
    })
  })
})

describe('resolveConnectedTappingTerm', () => {
  const term = { termMs: 200, reported: true }

  it('returns null when there is no live connection (e.g. after an auto-disconnect)', () => {
    // `uid` still reads as a real keyboard here — mirroring the actual
    // bug: `keyboard.uid` lags behind a disconnect, so `hasConnectedDevice`
    // (from `device.connectedDevice`, which does clear synchronously)
    // has to be what gates this, not the uid alone.
    expect(resolveConnectedTappingTerm(false, false, '0xAABB', term)).toBeNull()
  })

  it('returns null for a file-backed device even though it otherwise "looks" connected', () => {
    expect(resolveConnectedTappingTerm(true, true, '0xAABB', term)).toBeNull()
  })

  it('returns null when the uid is missing or still the empty sentinel', () => {
    expect(resolveConnectedTappingTerm(true, false, undefined, term)).toBeNull()
    expect(resolveConnectedTappingTerm(true, false, '0x0', term)).toBeNull()
  })

  it('returns {uid, ...tappingTerm} for a genuinely connected, non-file-backed keyboard', () => {
    expect(resolveConnectedTappingTerm(true, false, '0xAABB', term)).toEqual({
      uid: '0xAABB',
      termMs: 200,
      reported: true,
    })
  })
})
