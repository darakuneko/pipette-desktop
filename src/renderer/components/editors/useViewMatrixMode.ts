// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef } from 'react'
import { posKey } from '../../../shared/kle/pos-key'
import type { ViewMatrixKeyRef } from './view-matrix'

export interface UseViewMatrixModeReturn {
  /** True while the keymap is in View Matrix mode — the primary pane
   *  renders blank R/C legends and every keymap-editing interaction
   *  (layer switching, key assignment, the key popover, keycode palette
   *  selection, matrix-test toggles) is gated off at the KeymapEditor
   *  call sites that consume this flag. */
  active: boolean
  enter: () => void
  exit: () => void
  /** Toggles `active` — this is the same "Edit" / "Done" button in the
   *  Keycodes overlay panel driving both directions. */
  toggle: () => void
  /** Physical positions ("row,col") of the keys currently selected for
   *  View Matrix editing — the panel's Row/Col selects act on this set.
   *  Empty when nothing is selected. */
  selectedKeys: Set<string>
  /** Plain click: selects exactly this key, replacing any prior selection. */
  selectKey: (row: number, col: number) => void
  /** Ctrl/Cmd-click: toggles this key in/out of the current selection. */
  toggleKeySelection: (row: number, col: number) => void
  /** Shift-click: extends the selection as a contiguous range from the
   *  last-selected key to this one, using `keyOrder` for range membership
   *  (mirrors the normal-mode keymap multi-select's shift-range behavior). */
  extendSelection: (row: number, col: number, keyOrder: readonly ViewMatrixKeyRef[]) => void
  clearSelection: () => void
}

/**
 * Owns the View Matrix mode's UI state — whether the mode is active and
 * which keys (if any) are selected for editing via the panel's Row/Col
 * selects. Deliberately holds no reference to `viewMatrix` data or
 * `setViewMatrix` itself: those are plain props threaded through
 * KeymapEditor, kept separate so this hook stays a pure UI-state concern
 * (no vial-gui reference — this is a Pipette-original feature, see issue
 * #257).
 */
export function useViewMatrixMode(): UseViewMatrixModeReturn {
  const [active, setActive] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  // Anchor for Shift-range selection — mirrors useKeymapMultiSelect's
  // selectionAnchor, but kept local since View Matrix mode's selection is
  // its own concern (see the hook's top-level doc comment).
  const anchorRef = useRef<{ row: number; col: number } | null>(null)

  const enter = useCallback(() => setActive(true), [])

  const clearSelection = useCallback(() => {
    setSelectedKeys((prev) => prev.size === 0 ? prev : new Set())
    anchorRef.current = null
  }, [])

  const exit = useCallback(() => {
    setActive(false)
    setSelectedKeys((prev) => prev.size === 0 ? prev : new Set())
    anchorRef.current = null
  }, [])

  const toggle = useCallback(() => {
    if (active) exit()
    else enter()
  }, [active, enter, exit])

  const selectKey = useCallback((row: number, col: number) => {
    setSelectedKeys(new Set([posKey(row, col)]))
    anchorRef.current = { row, col }
  }, [])

  const toggleKeySelection = useCallback((row: number, col: number) => {
    const key = posKey(row, col)
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    anchorRef.current = { row, col }
  }, [])

  const extendSelection = useCallback((row: number, col: number, keyOrder: readonly ViewMatrixKeyRef[]) => {
    const anchor = anchorRef.current
    if (!anchor) { selectKey(row, col); return }
    const anchorIdx = keyOrder.findIndex((k) => k.row === anchor.row && k.col === anchor.col)
    const currentIdx = keyOrder.findIndex((k) => k.row === row && k.col === col)
    if (anchorIdx < 0 || currentIdx < 0) { selectKey(row, col); return }
    const start = Math.min(anchorIdx, currentIdx)
    const end = Math.max(anchorIdx, currentIdx)
    const next = new Set<string>()
    for (let i = start; i <= end; i++) next.add(posKey(keyOrder[i].row, keyOrder[i].col))
    setSelectedKeys(next)
  }, [selectKey])

  return { active, enter, exit, toggle, selectedKeys, selectKey, toggleKeySelection, extendSelection, clearSelection }
}
