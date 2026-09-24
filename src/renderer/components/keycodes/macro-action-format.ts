// SPDX-License-Identifier: GPL-2.0-or-later
//
// One-line text for a macro action, shared by the Macro tab tiles
// (`TileGrids.tsx`) and the macro hover bubble (`MacroHoverBubble.tsx`) so
// both show the same prefix and label for the same action.

import { codeToLabel } from '../../../shared/keycodes/keycodes'
import type { MacroAction } from '../../../preload/macro'

export const MACRO_PREFIX: Record<MacroAction['type'], string> = {
  tap: 'T',
  down: 'D',
  up: 'U',
  text: 'Tx',
  delay: 'W',
}

/** The full label; callers that need it shorter cut it with CSS. */
export function macroActionLabel(action: MacroAction): string {
  switch (action.type) {
    case 'text': return action.text
    case 'delay': return `${action.delay}ms`
    default: return action.keycodes.map(codeToLabel).join(' ')
  }
}
