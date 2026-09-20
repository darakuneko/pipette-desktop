// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { padMacroBuffer } from '../pad-macro-buffer'

describe('padMacroBuffer', () => {
  it('zero-pads a shorter buffer up to size', () => {
    expect(padMacroBuffer([1, 2, 3], 6)).toEqual([1, 2, 3, 0, 0, 0])
  })

  it('returns the buffer unchanged (as a copy) when it already matches size', () => {
    const input = [1, 2, 3]
    const result = padMacroBuffer(input, 3)
    expect(result).toEqual([1, 2, 3])
    expect(result).not.toBe(input)
  })

  it('truncates a longer buffer to size, forcing the final byte to 0', () => {
    expect(padMacroBuffer([1, 2, 3, 4, 5], 3)).toEqual([1, 2, 0])
  })

  it('truncating a non-empty buffer to size 0 returns an empty buffer', () => {
    expect(padMacroBuffer([1, 2, 3], 0)).toEqual([])
  })

  it('an already-empty buffer padded to 0 stays empty', () => {
    expect(padMacroBuffer([], 0)).toEqual([])
  })
})
