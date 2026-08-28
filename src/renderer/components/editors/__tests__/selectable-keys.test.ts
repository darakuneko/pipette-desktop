// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { filterSelectableKeys } from '../selectable-keys'
import type { KleKey } from '../../../../shared/kle/types'

const KEY_DEFAULTS: KleKey = {
  x: 0, y: 0,
  width: 1, height: 1,
  x2: 0, y2: 0,
  width2: 1, height2: 1,
  rotation: 0, rotationX: 0, rotationY: 0,
  color: '#cccccc',
  labels: Array(12).fill(null),
  textColor: Array(12).fill(null),
  textSize: Array(12).fill(null),
  row: 0, col: 0,
  encoderIdx: -1, encoderDir: -1,
  layoutIndex: -1, layoutOption: -1,
  decal: false, nub: false, stepped: false, ghost: false,
}

function makeKey(col: number, extra: Partial<KleKey> = {}): KleKey {
  return { ...KEY_DEFAULTS, col, ...extra }
}

describe('filterSelectableKeys', () => {
  it('excludes encoder and decal keys, preserving order', () => {
    const keys = [
      makeKey(0),
      makeKey(0, { encoderIdx: 0, encoderDir: 0 }),
      makeKey(0, { encoderIdx: 0, encoderDir: 1 }),
      makeKey(0, { decal: true }),
      makeKey(1),
    ]

    const result = filterSelectableKeys(keys, new Map())

    expect(result.map((k) => k.col)).toEqual([0, 1])
  })

  it('keeps only option-0 variants when layoutOptions is empty', () => {
    const keys = [
      makeKey(0),
      makeKey(1, { layoutIndex: 0, layoutOption: 0 }),
      makeKey(2, { layoutIndex: 0, layoutOption: 1 }),
    ]

    const result = filterSelectableKeys(keys, new Map())

    expect(result.map((k) => k.col)).toEqual([0, 1])
  })

  it('keeps the explicitly selected layout-option variant', () => {
    const keys = [
      makeKey(1, { layoutIndex: 0, layoutOption: 0 }),
      makeKey(2, { layoutIndex: 0, layoutOption: 1 }),
    ]

    const result = filterSelectableKeys(keys, new Map([[0, 1]]))

    expect(result.map((k) => k.col)).toEqual([2])
  })
})
