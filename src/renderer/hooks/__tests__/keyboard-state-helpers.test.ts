// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { parseDefinitionLayout } from '../keyboard-state-helpers'
import type { KeyboardDefinition } from '../../../shared/types/protocol'

function buildDefinition(keymap: unknown[][]): KeyboardDefinition {
  return {
    matrix: { rows: 2, cols: 2 },
    layouts: { keymap },
  }
}

describe('parseDefinitionLayout', () => {
  it('counts one encoder from its CW/CCW label pair', () => {
    const definition = buildDefinition([
      ['0,0', '0,1'],
      [`0,0${'\n'.repeat(9)}e`, `0,1${'\n'.repeat(9)}e`],
    ])

    const { layout, encoderCount } = parseDefinitionLayout(definition)

    expect(layout!.keys).toHaveLength(4)
    expect(encoderCount).toBe(1)
  })

  it('counts zero encoders for a keymap with only normal keys', () => {
    const definition = buildDefinition([
      ['0,0', '0,1'],
      ['1,0', '1,1'],
    ])

    const { layout, encoderCount } = parseDefinitionLayout(definition)

    expect(layout!.keys).toHaveLength(4)
    expect(encoderCount).toBe(0)
  })

  it('counts distinct encoder indices, not raw CW/CCW entries', () => {
    const definition = buildDefinition([
      [
        `0,0${'\n'.repeat(9)}e`,
        `0,1${'\n'.repeat(9)}e`,
        `1,0${'\n'.repeat(9)}e`,
        `1,1${'\n'.repeat(9)}e`,
      ],
    ])

    const { layout, encoderCount } = parseDefinitionLayout(definition)

    expect(layout!.keys).toHaveLength(4)
    expect(encoderCount).toBe(2)
  })

  it('returns a null layout and zero encoders when the keymap is missing', () => {
    // The type marks `keymap` as required, but malformed/legacy definition
    // files can still omit it, so the runtime guard is exercised here.
    const definition = { matrix: { rows: 2, cols: 2 }, layouts: {} } as KeyboardDefinition

    expect(parseDefinitionLayout(definition)).toEqual({ layout: null, encoderCount: 0 })
  })
})
