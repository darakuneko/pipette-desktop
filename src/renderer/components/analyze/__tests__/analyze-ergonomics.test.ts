// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { parseKle } from '../../../../shared/kle/kle-parser'
import type { KleKey } from '../../../../shared/kle/types'
import type { TypingHeatmapCell } from '../../../../shared/types/typing-analytics'
import { aggregateErgonomics } from '../analyze-ergonomics'

function buildAnsi60(): KleKey[] {
  return parseKle([
    [
      '0,0', '0,1', '0,2', '0,3', '0,4', '0,5', '0,6',
      '0,7', '0,8', '0,9', '0,10', '0,11', '0,12',
      { w: 2 }, '0,13',
    ],
    [
      { w: 1.5 }, '1,0',
      '1,1', '1,2', '1,3', '1,4', '1,5', '1,6', '1,7',
      '1,8', '1,9', '1,10', '1,11', '1,12',
      { w: 1.5 }, '1,13',
    ],
    [
      { w: 1.75 }, '2,0',
      '2,1', '2,2', '2,3', '2,4', '2,5', '2,6',
      '2,7', '2,8', '2,9', '2,10', '2,11',
      { w: 2.25 }, '2,12',
    ],
    [
      { w: 2.25 }, '3,0',
      '3,1', '3,2', '3,3', '3,4', '3,5',
      '3,6', '3,7', '3,8', '3,9', '3,10',
      { w: 2.75 }, '3,11',
    ],
    [
      { w: 1.25 }, '4,0',
      { w: 1.25 }, '4,1',
      { w: 1.25 }, '4,2',
      { w: 6.25 }, '4,3',
      { w: 1.25 }, '4,4',
      { w: 1.25 }, '4,5',
      { w: 1.25 }, '4,6',
      { w: 1.25 }, '4,7',
    ],
  ]).keys
}

function cell(total: number, tap = total, hold = 0): TypingHeatmapCell {
  return { total, tap, hold }
}

describe('aggregateErgonomics', () => {
  const keys = buildAnsi60()

  it('returns all-zero aggregation for an empty heatmap', () => {
    const result = aggregateErgonomics(new Map(), keys)
    expect(result.total).toBe(0)
    expect(result.unmappedFinger).toBe(0)
    expect(result.hand.left).toBe(0)
    expect(result.hand.right).toBe(0)
    expect(result.finger['left-pinky']).toBe(0)
  })

  it('returns all-zero aggregation when allKeys is empty', () => {
    const heat = new Map([['0,0', cell(5)]])
    const result = aggregateErgonomics(heat, [])
    expect(result.total).toBe(0)
  })

  it('routes a single top-row key into left-pinky / left / top', () => {
    const heat = new Map([['1,1', cell(5)]])  // Q
    const result = aggregateErgonomics(heat, keys)
    expect(result.total).toBe(5)
    expect(result.finger['left-pinky']).toBe(5)
    expect(result.hand.left).toBe(5)
    expect(result.hand.right).toBe(0)
    expect(result.row.top).toBe(5)
  })

  it('sums homogeneous presses into the same bucket', () => {
    const heat = new Map([
      ['1,1', cell(3)],  // Q -> left-pinky / top
      ['2,1', cell(2)],  // A -> left-pinky / home
    ])
    const result = aggregateErgonomics(heat, keys)
    expect(result.total).toBe(5)
    expect(result.finger['left-pinky']).toBe(5)
    expect(result.hand.left).toBe(5)
    expect(result.row.top).toBe(3)
    expect(result.row.home).toBe(2)
  })

  it('splits both hands for a pair of top-row keys', () => {
    const heat = new Map([
      ['1,1', cell(4)],  // Q
      ['1,6', cell(6)],  // Y
    ])
    const result = aggregateErgonomics(heat, keys)
    expect(result.hand.left).toBe(4)
    expect(result.hand.right).toBe(6)
    expect(result.finger['left-pinky']).toBe(4)
    expect(result.finger['right-index']).toBe(6)
  })

  it('puts the bottom-row space into right-thumb / thumb', () => {
    const heat = new Map([['4,3', cell(10)]])  // Space
    const result = aggregateErgonomics(heat, keys)
    expect(result.finger['right-thumb']).toBe(10)
    expect(result.row.thumb).toBe(10)
    expect(result.hand.right).toBe(10)
  })

  it('skips heatmap cells whose row,col is missing from allKeys', () => {
    const heat = new Map([
      ['1,1', cell(5)],
      ['99,99', cell(100)],
    ])
    const result = aggregateErgonomics(heat, keys)
    expect(result.total).toBe(5)
    expect(result.finger['left-pinky']).toBe(5)
  })

  it('ignores cells with zero or negative totals', () => {
    const heat = new Map([
      ['1,1', cell(0)],
      ['1,2', cell(-1, 0, 0)],
      ['1,3', cell(4)],  // E -> left-middle
    ])
    const result = aggregateErgonomics(heat, keys)
    expect(result.total).toBe(4)
    expect(result.finger['left-middle']).toBe(4)
    expect(result.finger['left-pinky']).toBe(0)
  })

  it('honours fingerOverrides and re-derives hand from the override', () => {
    // Y (1,6) normally maps to right-index / right. Override to left-index.
    const heat = new Map([['1,6', cell(8)]])
    const result = aggregateErgonomics(heat, keys, { '1,6': 'left-index' })
    expect(result.finger['left-index']).toBe(8)
    expect(result.finger['right-index']).toBe(0)
    expect(result.hand.left).toBe(8)
    expect(result.hand.right).toBe(0)
    // Row category is a physical property, overrides should not affect it.
    expect(result.row.top).toBe(8)
  })

  it('leaves non-overridden cells on the geometry estimate', () => {
    const heat = new Map([
      ['1,1', cell(3)],  // Q → left-pinky (estimate, no override)
      ['1,6', cell(5)],  // Y → override to left-index
    ])
    const result = aggregateErgonomics(heat, keys, { '1,6': 'left-index' })
    expect(result.finger['left-pinky']).toBe(3)
    expect(result.finger['left-index']).toBe(5)
    expect(result.hand.left).toBe(8)
    expect(result.hand.right).toBe(0)
  })

  it('aggregates a full QWERTY home row as 6 left + 7 right on home', () => {
    const heat = new Map([
      ['2,0', cell(1)],  // Caps
      ['2,1', cell(1)],  // A
      ['2,2', cell(1)],  // S
      ['2,3', cell(1)],  // D
      ['2,4', cell(1)],  // F
      ['2,5', cell(1)],  // G
      ['2,6', cell(1)],  // H
      ['2,7', cell(1)],  // J
      ['2,8', cell(1)],  // K
      ['2,9', cell(1)],  // L
      ['2,10', cell(1)], // ;
      ['2,11', cell(1)], // '
      ['2,12', cell(1)], // Enter
    ])
    const result = aggregateErgonomics(heat, keys)
    expect(result.total).toBe(13)
    expect(result.hand.left).toBe(6)
    expect(result.hand.right).toBe(7)
    expect(result.row.home).toBe(13)
  })
})
