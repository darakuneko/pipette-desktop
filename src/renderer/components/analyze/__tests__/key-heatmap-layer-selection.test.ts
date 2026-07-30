// SPDX-License-Identifier: GPL-2.0-or-later
// Coverage for the pure layer-selection / bonding transforms extracted
// from KeyHeatmapChart.tsx (toggleLayerSelection, resolveKeyboardClick)
// — a behavior-preserving extraction, so these tests pin the same
// interaction rules the inline version had.

import { describe, it, expect } from 'vitest'
import { resolveKeyboardClick, toggleLayerSelection } from '../key-heatmap-helpers'

describe('toggleLayerSelection', () => {
  it('adds a new layer as its own singleton group', () => {
    const result = toggleLayerSelection([0], [[0]], 1, 4)
    expect(result).toEqual({
      patch: { selectedLayers: [0, 1], groups: [[0], [1]] },
      clearMergeCandidate: false,
    })
  })

  it('keeps selectedLayers sorted ascending regardless of click order', () => {
    const result = toggleLayerSelection([2], [[2]], 0, 4)
    expect(result?.patch.selectedLayers).toEqual([0, 2])
  })

  it('refuses to add past maxLayers', () => {
    expect(toggleLayerSelection([0, 1, 2, 3], [[0], [1], [2], [3]], 4, 4)).toBeNull()
  })

  it('removes a selected layer and drops it from its group', () => {
    const result = toggleLayerSelection([0, 1], [[0, 1]], 1, 4)
    expect(result).toEqual({
      patch: { selectedLayers: [0], groups: [[0]] },
      clearMergeCandidate: true,
    })
  })

  it('drops a group entirely once it becomes empty', () => {
    const result = toggleLayerSelection([0, 1], [[0], [1]], 1, 4)
    expect(result?.patch.groups).toEqual([[0]])
  })

  it('refuses to remove the last remaining layer', () => {
    expect(toggleLayerSelection([0], [[0]], 0, 4)).toBeNull()
  })
})

describe('resolveKeyboardClick', () => {
  it('clears the merge candidate when clicking it again (cancel)', () => {
    const result = resolveKeyboardClick([[0], [1]], 0, 0)
    expect(result).toEqual({ mergeCandidate: null })
  })

  it('bonds two standalone groups when a merge candidate is armed', () => {
    const result = resolveKeyboardClick([[0], [1]], 1, 0)
    expect(result).toEqual({ patch: { groups: [[0, 1]] }, mergeCandidate: null })
  })

  it('preserves other groups untouched when merging two of several', () => {
    const result = resolveKeyboardClick([[0], [1], [2]], 1, 0)
    expect(result?.patch?.groups).toEqual([[0, 1], [2]])
  })

  it('clears the candidate without a patch when the candidate/target share a group already', () => {
    const result = resolveKeyboardClick([[0, 1]], 1, 0)
    expect(result).toEqual({ mergeCandidate: null })
  })

  it('splits a bonded layer back out to its own group on direct click', () => {
    const result = resolveKeyboardClick([[0, 1]], 1, null)
    expect(result).toEqual({ patch: { groups: [[0], [1]] }, mergeCandidate: null })
  })

  it('auto-merges a standalone click into the single existing bonded group', () => {
    const result = resolveKeyboardClick([[0, 1], [2]], 2, null)
    expect(result).toEqual({ patch: { groups: [[0, 1, 2]] }, mergeCandidate: null })
  })

  it('does not auto-merge when multiple bonded groups already exist (ambiguous target)', () => {
    const result = resolveKeyboardClick([[0, 1], [2, 3], [4]], 4, null)
    expect(result).toEqual({ mergeCandidate: 4 })
  })

  it('arms the merge candidate on a standalone click with no bonded group at all', () => {
    const result = resolveKeyboardClick([[0], [1]], 1, null)
    expect(result).toEqual({ mergeCandidate: 1 })
  })
})
