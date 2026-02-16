// SPDX-License-Identifier: GPL-2.0-or-later
// Test fixture: valid KeyboardDefinition for sideload JSON tests

import type { KeyboardDefinition } from '../../../../shared/types/protocol'

export const VALID_DEFINITION: KeyboardDefinition = {
  name: 'Test Keyboard',
  matrix: { rows: 2, cols: 3 },
  layouts: { keymap: [[{ x: 0, y: 0 }, { x: 1, y: 0 }]] },
}
