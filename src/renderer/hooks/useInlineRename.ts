// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useRef, useEffect, useCallback } from 'react'

const FLASH_DURATION_MS = 1200

interface InlineRenameState<TId extends string | number> {
  /** The id of the entry currently being edited, or null. */
  editingId: TId | null
  /** The current value in the rename input. */
  editLabel: string
  /** The id of the entry showing the confirm-flash animation, or null. */
  confirmedId: TId | null
  /** The original label before editing started. */
  originalLabel: string
}

interface InlineRenameActions<TId extends string | number> {
  /** Begin editing an entry. */
  startRename: (id: TId, currentLabel: string) => void
  /** Cancel editing without committing (used for Escape). */
  cancelRename: () => void
  /** Update the edit label (used as onChange handler). */
  setEditLabel: (value: string) => void
  /**
   * Commit the current edit and close.
   * Returns the trimmed new label if a rename was committed, or null.
   * Safe to call from onBlur — guarded against double-fire after Enter/Escape.
   */
  commitRename: (id: TId) => string | null
  /**
   * Trigger the confirm-flash animation for a given entry.
   * Useful when the rename is async and the flash should happen after success.
   */
  scheduleFlash: (id: TId) => void
}

export type InlineRename<TId extends string | number> = InlineRenameState<TId> & InlineRenameActions<TId>

/**
 * Encapsulates the inline-rename + confirm-flash pattern used by
 * LayoutStoreContent, FavoriteStoreModal, FavoriteTabContent, and HubPostRow.
 *
 * The caller is responsible for actually performing the rename (sync or async)
 * when `commitRename` returns a non-null trimmed label.
 */
export function useInlineRename<TId extends string | number>(): InlineRename<TId> {
  const [editingId, setEditingId] = useState<TId | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [confirmedId, setConfirmedId] = useState<TId | null>(null)
  const originalLabelRef = useRef('')
  const flashTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const deferTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Guards against blur firing after Enter/Escape already closed the editor.
  const closingRef = useRef(false)

  useEffect(() => () => {
    clearTimeout(flashTimerRef.current)
    clearTimeout(deferTimerRef.current)
  }, [])

  function scheduleFlash(id: TId): void {
    clearTimeout(deferTimerRef.current)
    deferTimerRef.current = setTimeout(() => {
      setConfirmedId(id)
      clearTimeout(flashTimerRef.current)
      flashTimerRef.current = setTimeout(() => setConfirmedId(null), FLASH_DURATION_MS)
    }, 0)
  }

  const startRename = useCallback((id: TId, currentLabel: string) => {
    closingRef.current = false
    setEditingId(id)
    setEditLabel(currentLabel)
    originalLabelRef.current = currentLabel
  }, [])

  const cancelRename = useCallback(() => {
    closingRef.current = true
    setEditingId(null)
  }, [])

  function commitRename(id: TId): string | null {
    if (closingRef.current) {
      closingRef.current = false
      return null
    }
    const trimmed = editLabel.trim()
    const changed = !!(trimmed && trimmed !== originalLabelRef.current)
    closingRef.current = true
    setEditingId(null)
    if (changed) {
      scheduleFlash(id)
      return trimmed
    }
    return null
  }

  return {
    editingId,
    editLabel,
    confirmedId,
    originalLabel: originalLabelRef.current,
    startRename,
    cancelRename,
    commitRename,
    setEditLabel,
    scheduleFlash,
  }
}
