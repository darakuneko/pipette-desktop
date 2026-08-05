// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { qualifyingHoldMs } from '../keystroke-hold'

describe('qualifyingHoldMs', () => {
  it('returns the press-to-release span when releaseMs is observed and the span is positive', () => {
    expect(qualifyingHoldMs(1000, 1080)).toBe(80)
  })

  it('returns undefined when releaseMs was never observed', () => {
    expect(qualifyingHoldMs(1000, undefined)).toBeUndefined()
  })

  it('returns undefined for a zero-duration span', () => {
    expect(qualifyingHoldMs(1000, 1000)).toBeUndefined()
  })

  it('returns undefined for a negative span (defensive — release before press)', () => {
    expect(qualifyingHoldMs(1000, 900)).toBeUndefined()
  })
})
