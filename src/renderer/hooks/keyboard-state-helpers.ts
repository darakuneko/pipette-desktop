// SPDX-License-Identifier: GPL-2.0-or-later

import type { KeyboardDefinition } from '../../shared/types/protocol'
import type { KeyboardLayout } from '../../shared/kle/types'
import { parseKle } from '../../shared/kle/kle-parser'

/**
 * Parse KLE layout from a definition and derive the encoder count.
 * Returns the parsed layout and encoder count, or null layout with 0 encoders
 * if the definition has no keymap.
 */
export function parseDefinitionLayout(definition: KeyboardDefinition): {
  layout: KeyboardLayout | null
  encoderCount: number
} {
  if (!definition.layouts?.keymap) {
    return { layout: null, encoderCount: 0 }
  }
  const layout = parseKle(definition.layouts.keymap)
  const indices = new Set<number>()
  for (const key of layout.keys) {
    if (key.encoderIdx >= 0) indices.add(key.encoderIdx)
  }
  return { layout, encoderCount: indices.size }
}
