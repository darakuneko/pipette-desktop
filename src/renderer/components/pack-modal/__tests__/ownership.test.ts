// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { isOwnPack } from '../ownership'

describe('isOwnPack', () => {
  it('is trivially own when there is no hub post at all', () => {
    expect(isOwnPack(null, '', null)).toBe(true)
    expect(isOwnPack(undefined, '', 'someone')).toBe(true)
  })

  it('is own when the cached owner name matches the current display name', () => {
    expect(isOwnPack('hub-1', 'me', 'me')).toBe(true)
  })

  it('is not own when the cached owner name differs from the current display name', () => {
    expect(isOwnPack('hub-1', 'someone-else', 'me')).toBe(false)
  })

  it('is not own when signed out (currentDisplayName is null) but the row has a hub post', () => {
    expect(isOwnPack('hub-1', 'me', null)).toBe(false)
  })
})
