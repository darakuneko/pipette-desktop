// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { computeUnlockKeyView } from '../unlock-dialog-keys'
import type { KleKey } from '../../../../shared/kle/types'
import { makeKey } from '../../keyboard/__tests__/kle-test-keys'

const at = (row: number, col: number, o: Partial<KleKey> = {}) => makeKey({ row, col, x: col, y: row, ...o })
const opt = (row: number, col: number, layoutIndex: number, layoutOption: number) =>
  at(row, col, { layoutIndex, layoutOption })

describe('computeUnlockKeyView', () => {
  it('highlights every unlock position', () => {
    const view = computeUnlockKeyView([at(0, 0)], [[0, 0], [0, 13]], undefined)
    expect([...view.highlightedKeys]).toEqual(['0,0', '0,13'])
  })

  it('lists missing positions in unlock-key order', () => {
    const view = computeUnlockKeyView([at(0, 0)], [[2, 5], [0, 0], [0, 13]], undefined)
    expect(view.missing).toEqual([[2, 5], [0, 13]])
  })

  it('treats a position held only by an encoder as missing', () => {
    // Encoders keep row/col 0,0 in the KLE parser (parseKeyLabels in kle-parser.ts)
    const view = computeUnlockKeyView([at(0, 0, { encoderIdx: 0, encoderDir: 0 }), at(0, 1)], [[0, 0], [0, 1]], undefined)
    expect(view.missing).toEqual([[0, 0]])
  })

  it('treats a position held only by a decal as missing', () => {
    const view = computeUnlockKeyView([at(0, 0, { decal: true }), at(0, 1)], [[0, 0], [0, 1]], undefined)
    expect(view.missing).toEqual([[0, 0]])
  })

  it('does not report missing positions before keys are loaded', () => {
    expect(computeUnlockKeyView([], [[0, 13]], undefined).missing).toEqual([])
  })

  it('returns the input options object when every unlock key is visible', () => {
    const opts = new Map([[0, 0]])
    const view = computeUnlockKeyView([at(0, 0), opt(1, 0, 0, 0), opt(1, 1, 0, 1)], [[0, 0], [1, 0]], opts)
    expect(view.displayOptions).toBe(opts)
    expect(view.missing).toEqual([])
  })

  it('does not override when layout options are empty (all keys shown)', () => {
    const opts = new Map<number, number>()
    const view = computeUnlockKeyView([opt(1, 0, 0, 0), opt(1, 1, 0, 1)], [[1, 1]], opts)
    expect(view.displayOptions).toBe(opts)
  })

  it('treats undefined layout options like empty ones', () => {
    const view = computeUnlockKeyView([opt(1, 0, 0, 0), opt(1, 1, 0, 1)], [[1, 1]], undefined)
    expect(view.displayOptions).toBeUndefined()
  })

  it('overrides on a copy and leaves the input untouched', () => {
    const opts = new Map([[0, 0], [1, 2]])
    const view = computeUnlockKeyView([opt(1, 0, 0, 0), opt(1, 1, 0, 1)], [[1, 1]], opts)
    expect(view.displayOptions).not.toBe(opts)
    expect([...(view.displayOptions ?? [])]).toEqual([[0, 1], [1, 2]])
    expect([...opts]).toEqual([[0, 0], [1, 2]])
  })

  it('does not override when a visible key already covers the position', () => {
    // ISO / ANSI style: both options carry a key at (1,0)
    const opts = new Map([[0, 0]])
    const view = computeUnlockKeyView([opt(1, 0, 0, 0), opt(1, 0, 0, 1)], [[1, 0]], opts)
    expect(view.displayOptions).toBe(opts)
  })

  it('overrides a group with no selection (option 0) to show a non-zero option', () => {
    const keys = [opt(1, 0, 0, 0), opt(2, 0, 1, 0), opt(2, 1, 1, 2)]
    const view = computeUnlockKeyView(keys, [[2, 1]], new Map([[0, 0]]))
    expect([...(view.displayOptions ?? [])]).toEqual([[0, 0], [1, 2]])
  })

  it('does not override a group whose selected option shows an unlock key', () => {
    const opts = new Map([[0, 0]])
    const view = computeUnlockKeyView([opt(1, 0, 0, 0), opt(1, 1, 0, 1)], [[1, 0], [1, 1]], opts)
    expect(view.displayOptions).toBe(opts)
    expect(view.missing).toEqual([])
  })

  it('keeps the first hidden unlock key when a group is contested', () => {
    const keys = [opt(1, 0, 0, 0), opt(1, 1, 0, 1), opt(1, 2, 0, 2)]
    const view = computeUnlockKeyView(keys, [[1, 2], [1, 1]], new Map([[0, 0]]))
    expect(view.displayOptions?.get(0)).toBe(2)
    expect(view.missing).toEqual([])
  })
})
