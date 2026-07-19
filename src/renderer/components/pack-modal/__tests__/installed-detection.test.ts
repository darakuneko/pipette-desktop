// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { isHubItemInstalled } from '../installed-detection'

describe('isHubItemInstalled', () => {
  it('matches by hubPostId first', () => {
    const installed = [{ hubPostId: 'hub-1', name: 'Renamed Locally' }]
    expect(isHubItemInstalled({ id: 'hub-1', name: 'Original Name' }, installed)).toBe(true)
  })

  it('falls back to a case-insensitive name match when no hubPostId matches', () => {
    const installed = [{ name: 'French' }]
    expect(isHubItemInstalled({ id: 'hub-2', name: 'FRENCH' }, installed)).toBe(true)
  })

  it('returns false when neither hubPostId nor name matches', () => {
    const installed = [{ hubPostId: 'hub-9', name: 'Something Else' }]
    expect(isHubItemInstalled({ id: 'hub-2', name: 'French' }, installed)).toBe(false)
  })

  it('does not match on a hubPostId belonging to a different local entry even if ids collide by coincidence', () => {
    const installed = [{ hubPostId: 'hub-9', name: 'French' }]
    // Different remote id, same name as a *different* hub post locally — still matches via name fallback.
    expect(isHubItemInstalled({ id: 'hub-2', name: 'French' }, installed)).toBe(true)
  })

  it('ignores entries with no hubPostId when matching by id', () => {
    const installed = [{ name: 'Local Only' }]
    expect(isHubItemInstalled({ id: 'hub-3', name: 'Different' }, installed)).toBe(false)
  })

  it('trims whitespace before comparing names', () => {
    const installed = [{ name: '  Padded  ' }]
    expect(isHubItemInstalled({ id: 'hub-4', name: 'Padded' }, installed)).toBe(true)
  })
})
