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
 * Effective (override ?? physical) view position of the key at physical
 * `(row, col)` — the single fallback rule every View Matrix consumer
 * (ordering, bulk edit, duplicate detection, panel display) shares.
 */
export function effectiveViewPos(
  viewMatrix: Record<string, ViewMatrixCell> | undefined,
  row: number,
  col: number,
): ViewMatrixCell {
  const override = viewMatrix?.[posKey(row, col)]
  return { row: override?.row ?? row, col: override?.col ?? col }
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
      const effective = effectiveViewPos(viewMatrix, key.row, key.col)
      return { key, index, effective }
    })
    .sort((a, b) => {
      if (a.effective.row !== b.effective.row) return a.effective.row - b.effective.row
      if (a.effective.col !== b.effective.col) return a.effective.col - b.effective.col
      if (a.key.row !== b.key.row) return a.key.row - b.key.row
      if (a.key.col !== b.key.col) return a.key.col - b.key.col
      return a.index - b.index
    })
    .map((entry) => entry.key)
}

/** Writes one key's view position into a mutable map draft, deleting the
 *  entry instead when the position equals the key's own physical position —
 *  the sparse "absent means physical" contract shared by every writer. */
function writeOverride(
  draft: Record<string, ViewMatrixCell>,
  physRow: number,
  physCol: number,
  row: number,
  col: number,
): void {
  const key = posKey(physRow, physCol)
  if (row === physRow && col === physCol) delete draft[key]
  else draft[key] = { row, col }
}

/**
 * Computes the next `viewMatrix` map after saving a view position for the
 * key at physical `(physRow, physCol)`.
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
  const next = { ...current }
  writeOverride(next, physRow, physCol, row, col)
  return Object.keys(next).length > 0 ? next : undefined
}

/**
 * Bulk-applies a single value across one axis (row or col) to every key in
 * `selection`, in one pass — each key keeps its own value on the other
 * axis. Used by the View Matrix panel's Row/Col selects when 2+ keys are
 * selected, so the whole selection is folded into one next map and the
 * caller issues a single `setViewMatrix` write instead of one per key.
 */
export function applyViewMatrixAxisToSelection<K extends ViewMatrixKeyRef>(
  current: Record<string, ViewMatrixCell> | undefined,
  selection: readonly K[],
  axis: 'row' | 'col',
  value: number,
): Record<string, ViewMatrixCell> | undefined {
  if (selection.length === 0) return current
  const next = { ...current }
  for (const { row, col } of selection) {
    const effective = effectiveViewPos(next, row, col)
    writeOverride(next, row, col, axis === 'row' ? value : effective.row, axis === 'col' ? value : effective.col)
  }
  return Object.keys(next).length > 0 ? next : undefined
}

/**
 * Counts keys whose effective (override ?? physical) position collides
 * with at least one other key's effective position. Returns the total
 * number of keys involved in a collision (0 when every key resolves to a
 * distinct position) — used by the View Matrix panel to show a persistent
 * duplicate-position warning, since a collision makes the Auto Move order
 * between those keys ambiguous.
 */
export function countViewMatrixDuplicates<K extends ViewMatrixKeyRef>(
  keys: readonly K[],
  viewMatrix: Record<string, ViewMatrixCell> | undefined,
): number {
  const groupSizes = new Map<string, number>()
  for (const key of keys) {
    const effective = effectiveViewPos(viewMatrix, key.row, key.col)
    const pos = posKey(effective.row, effective.col)
    groupSizes.set(pos, (groupSizes.get(pos) ?? 0) + 1)
  }
  let count = 0
  for (const size of groupSizes.values()) if (size > 1) count += size
  return count
}
