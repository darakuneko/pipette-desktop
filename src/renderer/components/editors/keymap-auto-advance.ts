// SPDX-License-Identifier: GPL-2.0-or-later

import type { ViewMatrixKeyRef } from './view-matrix'

/**
 * Given the Auto Move walk order (already layout-option/decal/encoder
 * filtered and view-matrix sorted — see `advancableKeys` in
 * `useKeymapSelectionHandlers.ts`) and a starting position, returns the
 * next key in the walk, or `null` when `from` isn't in the list at all or
 * is already last. Pure — callers (both the left-panel picker and the
 * popover follow-along) gate `autoAdvance` themselves before calling this.
 */
export function nextAdvanceKey<K extends ViewMatrixKeyRef>(
  advancableKeys: readonly K[],
  from: { row: number; col: number },
): { row: number; col: number } | null {
  const idx = advancableKeys.findIndex((k) => k.row === from.row && k.col === from.col)
  if (idx < 0 || idx >= advancableKeys.length - 1) return null
  const next = advancableKeys[idx + 1]
  return { row: next.row, col: next.col }
}

/**
 * Finds the on-screen rect for the key at physical `(row, col)`, scoped to
 * `container` — never `document`. The Keyboard tab's hidden layout picker
 * renders its own elements with the same `data-key-pos` attribute
 * (`KeyWidget.tsx`), so an unscoped lookup can resolve to the wrong pane's
 * key; `container` must be the primary keymap pane's own content ref.
 *
 * Scrolls the element into view first — `behavior: 'instant'` is required
 * (not the default 'auto') so a key currently scrolled out of view is
 * measured at its final position instead of mid smooth-scroll animation.
 * Returns `null` when no matching element exists (e.g. a key hidden by the
 * current layout option, or the container isn't mounted) — callers must
 * not advance the popover in that case.
 */
export function getKeyAnchorRect(container: HTMLElement | null, row: number, col: number): DOMRect | null {
  if (!container) return null
  const el = container.querySelector(`[data-key-pos="${row},${col}"]`)
  if (!el) return null
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
  return el.getBoundingClientRect()
}
