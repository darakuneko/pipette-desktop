// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { groupByOffsetTop } from '../useVisualLines'

describe('groupByOffsetTop', () => {
  it('returns no rows for an empty word list', () => {
    expect(groupByOffsetTop([])).toEqual([])
  })

  it('groups every index into one row when all measured offsets match', () => {
    expect(groupByOffsetTop([0, 0, 0])).toEqual([[0, 1, 2]])
  })

  it('handles a single word (one row, one entry)', () => {
    expect(groupByOffsetTop([0])).toEqual([[0]])
  })

  it('starts a new row whenever the measured offset changes', () => {
    // Words 0-2 wrap onto the first visual row, 3-4 onto the second.
    expect(groupByOffsetTop([0, 0, 0, 24, 24])).toEqual([[0, 1, 2], [3, 4]])
  })

  it('handles three or more rows', () => {
    expect(groupByOffsetTop([0, 0, 24, 48, 48, 48])).toEqual([[0, 1], [2], [3, 4, 5]])
  })

  it('never merges rows even if an earlier offset value recurs later', () => {
    // Row boundaries are driven purely by adjacency, not by offset value
    // identity — a later row must never merge back into an earlier one
    // sharing the same numeric offsetTop (defensive: shouldn't happen with
    // real flex-wrap layout, but the grouping must not silently misbehave).
    expect(groupByOffsetTop([0, 0, 24, 0])).toEqual([[0, 1], [2], [3]])
  })
})
