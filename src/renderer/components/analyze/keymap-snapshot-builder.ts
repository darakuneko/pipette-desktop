// SPDX-License-Identifier: GPL-2.0-or-later
// Pure helper: materialise a `TypingKeymapSnapshot` (minus machineHash,
// which the main process fills in) from the active `KeyboardState`.
// Used by the record-start flow so the Analyze key-heatmap tab has a
// layout+keymap anchor for every recorded session.

import type { KeyboardState } from '../../hooks/keyboard-types'
import { EMPTY_UID } from '../../../shared/constants/protocol'
import { serialize as serializeKeycode } from '../../../shared/keycodes/keycodes'
import type { TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'

export function buildKeymapSnapshot(
  kb: KeyboardState,
  now: number = Date.now(),
): Omit<TypingKeymapSnapshot, 'machineHash'> | null {
  if (!kb.layout || kb.uid === EMPTY_UID) return null
  if (kb.layers <= 0 || kb.rows <= 0 || kb.cols <= 0) return null

  const keymap: string[][][] = []
  for (let layer = 0; layer < kb.layers; layer += 1) {
    const rows: string[][] = []
    for (let row = 0; row < kb.rows; row += 1) {
      const cols: string[] = []
      for (let col = 0; col < kb.cols; col += 1) {
        const kc = kb.keymap.get(`${layer},${row},${col}`) ?? 0
        // Serialize at record-start time — the renderer holds the
        // right vial-protocol context right now (LT range, custom
        // keycodes, etc), and later Analyze reads happen without a
        // live keyboard. Stashing the QMK id avoids the resolver
        // having to re-acquire that context.
        cols.push(serializeKeycode(kc))
      }
      rows.push(cols)
    }
    keymap.push(rows)
  }

  return {
    uid: kb.uid,
    productName: kb.definition?.name ?? '',
    savedAt: now,
    layers: kb.layers,
    matrix: { rows: kb.rows, cols: kb.cols },
    keymap,
    layout: kb.layout,
  }
}
