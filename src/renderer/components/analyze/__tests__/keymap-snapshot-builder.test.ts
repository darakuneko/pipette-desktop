// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest'
import { emptyState } from '../../../hooks/keyboard-types'
import type { KeyboardState } from '../../../hooks/keyboard-types'
import { buildKeymapSnapshot } from '../keymap-snapshot-builder'

function makeState(overrides: Partial<KeyboardState>): KeyboardState {
  return { ...emptyState(), ...overrides }
}

describe('buildKeymapSnapshot', () => {
  it('returns null for the empty-UID placeholder', () => {
    expect(buildKeymapSnapshot(makeState({}))).toBeNull()
  })

  it('returns null when layout is missing', () => {
    const kb = makeState({ uid: '0xAABB', layers: 1, rows: 1, cols: 1 })
    expect(buildKeymapSnapshot(kb)).toBeNull()
  })

  it('packs the keymap Map into layer/row/col arrays', () => {
    const keymap = new Map<string, number>([
      ['0,0,0', 10],
      ['0,0,1', 11],
      ['0,1,0', 12],
      ['0,1,1', 13],
      ['1,0,0', 20],
    ])
    const kb = makeState({
      uid: '0xAABB',
      layers: 2,
      rows: 2,
      cols: 2,
      layout: { rows: 2, cols: 2 } as unknown as KeyboardState['layout'],
      keymap,
    })
    const out = buildKeymapSnapshot(kb, 1_000)
    expect(out).not.toBeNull()
    expect(out).toMatchObject({
      uid: '0xAABB',
      savedAt: 1_000,
      layers: 2,
      matrix: { rows: 2, cols: 2 },
      keymap: [
        [[10, 11], [12, 13]],
        [[20, 0], [0, 0]],
      ],
    })
  })
})
