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
  /** Cancel editing (used as onBlur handler). */
  cancelRename: () => void
  /** Update the edit label (used as onChange handler). */
  setEditLabel: (value: string) => void
  /**
   * Commit the rename on Enter, cancel on Escape.
   * Returns the trimmed new label if a rename was committed, or null.
   */
  handleKeyDown: (e: React.KeyboardEvent, id: TId) => string | null
  /**
   * Prevent blur when clicking non-interactive areas of the editing card.
   * Attach as onMouseDown on the card container.
   */
  handleCardMouseDown: (e: React.MouseEvent, id: TId) => void
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
 * when `handleKeyDown` returns a non-null trimmed label.
 */
export function useInlineRename<TId extends string | number>(): InlineRename<TId> {
  const [editingId, setEditingId] = useState<TId | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [confirmedId, setConfirmedId] = useState<TId | null>(null)
  const originalLabelRef = useRef('')
  const flashTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const deferTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

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
    setEditingId(id)
    setEditLabel(currentLabel)
    originalLabelRef.current = currentLabel
  }, [])

  const cancelRename = useCallback(() => {
    setEditingId(null)
  }, [])

  function handleKeyDown(e: React.KeyboardEvent, id: TId): string | null {
    if (e.key === 'Enter') {
      const trimmed = editLabel.trim()
      const changed = !!(trimmed && trimmed !== originalLabelRef.current)
      setEditingId(null)
      if (changed) {
        scheduleFlash(id)
        return trimmed
      }
      return null
    }
    if (e.key === 'Escape') {
      e.stopPropagation()
      setEditingId(null)
      return null
    }
    return null
  }

  function handleCardMouseDown(e: React.MouseEvent, id: TId): void {
    if (editingId === id && !(e.target as HTMLElement).closest('button, input')) {
      e.preventDefault()
    }
  }

  return {
    editingId,
    editLabel,
    confirmedId,
    originalLabel: originalLabelRef.current,
    startRename,
    cancelRename,
    setEditLabel,
    handleKeyDown,
    handleCardMouseDown,
    scheduleFlash,
  }
}
