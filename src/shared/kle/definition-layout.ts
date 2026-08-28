// SPDX-License-Identifier: GPL-2.0-or-later

import type { KeyboardDefinition } from '../types/protocol'
import type { KeyboardLayout } from './types'
import { parseKle } from './kle-parser'

/** Collect the distinct encoder indices present in a parsed KLE layout. */
export function encoderIndices(layout: KeyboardLayout): Set<number> {
  const indices = new Set<number>()
  for (const key of layout.keys) {
    if (key.encoderIdx >= 0) indices.add(key.encoderIdx)
  }
  return indices
}

/**
 * Parse KLE layout from a definition and derive the encoder indices.
 * Returns the parsed layout, its distinct encoder indices, and the encoder
 * count, or a null layout with an empty index set if the definition has no
 * keymap. `encoderCount` follows the vial-gui convention (highest index + 1)
 * so dense 0..count-1 consumers cover sparse index sets the same way the
 * reference implementation does; `encoderIdx` carries the exact set.
 */
export function parseDefinitionLayout(definition: KeyboardDefinition): {
  layout: KeyboardLayout | null
  encoderCount: number
  encoderIdx: Set<number>
} {
  if (!definition.layouts?.keymap) {
    return { layout: null, encoderCount: 0, encoderIdx: new Set() }
  }
  const layout = parseKle(definition.layouts.keymap)
  const encoderIdx = encoderIndices(layout)
  const encoderCount = encoderIdx.size === 0 ? 0 : Math.max(...encoderIdx) + 1
  return { layout, encoderCount, encoderIdx }
}
