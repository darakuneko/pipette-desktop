// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
// `keycodes.ts` must be the first module to touch this dependency pair —
// it pulls in keycodes-utils.ts at its own tail to run one-time init.
// Importing keycodes-utils.ts first would re-enter it mid-evaluation via
// that tail import and trip a TDZ error on its module-level `let` state.
import { setProtocolValue } from '../../shared/keycodes/keycodes'
import { resolve } from '../../shared/keycodes/keycodes-utils'
import { decompressLzma } from '../lzma'
import {
  LAYERS,
  ROWS,
  COLS,
  MACRO_BUFFER_SIZE,
  VIALRGB_SUPPORTED_EFFECTS,
  buildDefaultKeymap,
  buildDefaultMacroBuffer,
  getCompressedDefinition,
} from '../virtual-device/gpk60-63r'

describe('buildDefaultKeymap', () => {
  it('has length LAYERS * ROWS * COLS', () => {
    const keymap = buildDefaultKeymap()
    expect(keymap.length).toBe(LAYERS * ROWS * COLS)
  })

  it('sets (layer 0, row 0, col 0) to Escape', () => {
    setProtocolValue(6)
    const keymap = buildDefaultKeymap()
    const index = (0 * ROWS + 0) * COLS + 0
    expect(keymap[index]).toBe(resolve('KC_ESCAPE'))
  })

  it('sets LT(1, KC_SPACE) at (layer 0, row 4, col 4)', () => {
    setProtocolValue(6)
    const keymap = buildDefaultKeymap()
    const index = (0 * ROWS + 4) * COLS + 4
    const expected = resolve('QK_LAYER_TAP') | ((1 & 0x0f) << 8) | (resolve('KC_SPACE') & 0xff)
    expect(keymap[index]).toBe(expected)
  })

  it('sets USER00 on layer 2 at row 2 col 0', () => {
    setProtocolValue(6)
    const keymap = buildDefaultKeymap()
    const index = (2 * ROWS + 2) * COLS + 0
    expect(keymap[index]).toBe(resolve('USER00'))
  })

  it('leaves physically-unused positions as KC_NO', () => {
    const keymap = buildDefaultKeymap()
    const unused: [number, number][] = [
      [2, 13],
      [3, 12],
      [3, 13],
      [4, 3],
      [4, 5],
      [4, 12],
      [4, 13],
    ]
    for (const [row, col] of unused) {
      for (let layer = 0; layer < LAYERS; layer++) {
        const index = (layer * ROWS + row) * COLS + col
        expect(keymap[index]).toBe(0)
      }
    }
  })

  it('layer 3 is entirely KC_NO', () => {
    const keymap = buildDefaultKeymap()
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const index = (3 * ROWS + row) * COLS + col
        expect(keymap[index]).toBe(0)
      }
    }
  })
})

describe('buildDefaultMacroBuffer', () => {
  it('is exactly MACRO_BUFFER_SIZE bytes', () => {
    const buffer = buildDefaultMacroBuffer()
    expect(buffer.length).toBe(MACRO_BUFFER_SIZE)
  })

  it('starts with the "Hello" text macro terminated by NUL', () => {
    const buffer = buildDefaultMacroBuffer()
    const text = Array.from(buffer.subarray(0, 5)).map((b) => String.fromCharCode(b)).join('')
    expect(text).toBe('Hello')
    expect(buffer[5]).toBe(0x00)
  })
})

describe('VIALRGB_SUPPORTED_EFFECTS', () => {
  it('is ascending, starts at 0, and excludes DIRECT (1)', () => {
    expect(VIALRGB_SUPPORTED_EFFECTS[0]).toBe(0)
    expect(VIALRGB_SUPPORTED_EFFECTS).not.toContain(1)
    for (let i = 1; i < VIALRGB_SUPPORTED_EFFECTS.length; i++) {
      expect(VIALRGB_SUPPORTED_EFFECTS[i]).toBeGreaterThan(VIALRGB_SUPPORTED_EFFECTS[i - 1])
    }
    expect(VIALRGB_SUPPORTED_EFFECTS.length).toBeGreaterThanOrEqual(20)
  })
})

describe('getCompressedDefinition', () => {
  it('round-trips through LZMA decompression to the virtual definition JSON', async () => {
    const compressed = await getCompressedDefinition()
    const jsonStr = await decompressLzma(Array.from(compressed))
    expect(jsonStr).not.toBeNull()
    const parsed = JSON.parse(jsonStr!) as { name: string; matrix: { rows: number; cols: number } }
    expect(parsed.name).toBe('GPK60-63R Virtual')
    expect(parsed.matrix.rows).toBe(5)
    expect(parsed.matrix.cols).toBe(14)
  })

  it('caches the result across calls', async () => {
    const first = await getCompressedDefinition()
    const second = await getCompressedDefinition()
    expect(second).toBe(first)
  })
})
