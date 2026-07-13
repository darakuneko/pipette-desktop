// SPDX-License-Identifier: GPL-2.0-or-later

import type { ViewMatrixCell } from '../../../shared/types/pipette-settings'
import { posKey } from '../../../shared/kle/pos-key'

/** Minimal shape needed to place a key in the View Matrix ordering — a
 *  key's physical Vial matrix position. */
export interface ViewMatrixKeyRef {
  row: number
  col: number
}

/**
 * Orders `keys` for the keymap editor's Auto Move (auto-advance) walk.
 *
 * This replaces the old definition-order walk (no vial-gui reference — this
 * is a Pipette-original feature, see issue #257). Each key's effective
 * position is its `viewMatrix` override (looked up by its physical
 * `"row,col"`) when present, else its own physical position. Keys are
 * sorted ascending by (effective row, effective col); ties break on
 * (physical row, physical col), then on original array index, so the sort
 * is total and deterministic even when two keys share the same effective —
 * or physical — position.
 *
 * With no overrides at all, this is exactly physical matrix order
 * (row-major), which already fixes Auto Move on keyboards whose keymap
 * definition order doesn't match their physical layout.
 */
export function sortKeysByViewMatrix<K extends ViewMatrixKeyRef>(
  keys: readonly K[],
  viewMatrix: Record<string, ViewMatrixCell> | undefined,
): K[] {
  return keys
    .map((key, index) => {
      const override = viewMatrix?.[posKey(key.row, key.col)]
      return {
        key,
        index,
        effectiveRow: override?.row ?? key.row,
        effectiveCol: override?.col ?? key.col,
      }
    })
    .sort((a, b) => {
      if (a.effectiveRow !== b.effectiveRow) return a.effectiveRow - b.effectiveRow
      if (a.effectiveCol !== b.effectiveCol) return a.effectiveCol - b.effectiveCol
      if (a.key.row !== b.key.row) return a.key.row - b.key.row
      if (a.key.col !== b.key.col) return a.key.col - b.key.col
      return a.index - b.index
    })
    .map((entry) => entry.key)
}

/**
 * Computes the next `viewMatrix` map after the View Matrix edit modal saves
 * a position for the key at physical `(physRow, physCol)`.
 *
 * When the entered `(row, col)` equals the key's own physical position, the
 * override entry is deleted instead of written — this keeps the map sparse,
 * matching the "absent means physical" contract `sortKeysByViewMatrix` and
 * the main-process validator both rely on. When the resulting map would be
 * empty, `undefined` is returned instead of `{}` so callers can pass the
 * result straight to `setViewMatrix` and fully clear the persisted field.
 */
export function applyViewMatrixOverride(
  current: Record<string, ViewMatrixCell> | undefined,
  physRow: number,
  physCol: number,
  row: number,
  col: number,
): Record<string, ViewMatrixCell> | undefined {
  const key = posKey(physRow, physCol)
  const next = { ...current }
  if (row === physRow && col === physCol) {
    delete next[key]
  } else {
    next[key] = { row, col }
  }
  return Object.keys(next).length > 0 ? next : undefined
}
