// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback } from 'react'

/** Physical Vial matrix position of the key currently open in the View
 *  Matrix edit modal. */
export interface ViewMatrixEditingKey {
  row: number
  col: number
}

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
  /** Physical position of the key currently open in the edit modal, or
   *  `null` when no modal is open. */
  editingKey: ViewMatrixEditingKey | null
  openEditor: (row: number, col: number) => void
  closeEditor: () => void
}

/**
 * Owns the View Matrix mode's UI state — whether the mode is active and
 * which key's edit modal (if any) is open. Deliberately holds no reference
 * to `viewMatrix` data or `setViewMatrix` itself: those are plain props
 * threaded through KeymapEditor, kept separate so this hook stays a pure
 * UI-state concern (no vial-gui reference — this is a Pipette-original
 * feature, see issue #257).
 */
export function useViewMatrixMode(): UseViewMatrixModeReturn {
  const [active, setActive] = useState(false)
  const [editingKey, setEditingKey] = useState<ViewMatrixEditingKey | null>(null)

  const enter = useCallback(() => setActive(true), [])

  const exit = useCallback(() => {
    setActive(false)
    setEditingKey(null)
  }, [])

  const toggle = useCallback(() => {
    if (active) exit()
    else enter()
  }, [active, enter, exit])

  const openEditor = useCallback((row: number, col: number) => {
    setEditingKey({ row, col })
  }, [])

  const closeEditor = useCallback(() => setEditingKey(null), [])

  return { active, enter, exit, toggle, editingKey, openEditor, closeEditor }
}
