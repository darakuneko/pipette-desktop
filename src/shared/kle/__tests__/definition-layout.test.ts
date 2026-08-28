// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { parseDefinitionLayout } from '../definition-layout'
import { encoderLabel } from './encoder-label'
import type { KeyboardDefinition } from '../../types/protocol'

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
      [encoderLabel(0, 0), encoderLabel(0, 1)],
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
        encoderLabel(0, 0),
        encoderLabel(0, 1),
        encoderLabel(1, 0),
        encoderLabel(1, 1),
      ],
    ])

    const { layout, encoderCount } = parseDefinitionLayout(definition)

    expect(layout!.keys).toHaveLength(4)
    expect(encoderCount).toBe(2)
  })

  it('spans sparse encoder indices with the vial-gui count convention (max + 1)', () => {
    const definition = buildDefinition([
      [
        encoderLabel(0, 0),
        encoderLabel(0, 1),
        encoderLabel(2, 0),
        encoderLabel(2, 1),
      ],
    ])

    const { encoderCount, encoderIdx } = parseDefinitionLayout(definition)

    expect(encoderIdx).toEqual(new Set([0, 2]))
    expect(encoderCount).toBe(3)
  })

  it('returns a null layout and zero encoders when the keymap is missing', () => {
    // The type marks `keymap` as required, but malformed/legacy definition
    // files can still omit it, so the runtime guard is exercised here.
    const definition = { matrix: { rows: 2, cols: 2 }, layouts: {} } as KeyboardDefinition

    expect(parseDefinitionLayout(definition)).toEqual({
      layout: null,
      encoderCount: 0,
      encoderIdx: new Set(),
    })
  })
})
