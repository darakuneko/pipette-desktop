// SPDX-License-Identifier: GPL-2.0-or-later

import { useRef, useState, useCallback } from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HistoryEntryBase {
  layer: number
  oldKeycode: number
  newKeycode: number
  maskPart?: 'inner' | 'outer'
}

export type SingleHistoryEntry =
  | HistoryEntryBase & { kind: 'key'; row: number; col: number }
  | HistoryEntryBase & { kind: 'encoder'; idx: number; dir: 0 | 1 }

export type HistoryEntry =
  | SingleHistoryEntry
  | { kind: 'batch'; entries: SingleHistoryEntry[] }

export interface UseKeymapHistoryReturn {
  /** Push a new entry onto the undo stack. Clears the redo stack. */
  push: (entry: HistoryEntry) => void
  /** Pop the top undo entry. Returns it for the caller to apply the revert. */
  undo: () => HistoryEntry | null
  /** Pop the top redo entry. Returns it for the caller to re-apply. */
  redo: () => HistoryEntry | null
  canUndo: boolean
  canRedo: boolean
  /** Peek at the next undo entry without popping. */
  peekUndo: HistoryEntry | null
  /** Peek at the next redo entry without popping. */
  peekRedo: HistoryEntry | null
  /** Clear both stacks. */
  clear: () => void
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Manages an undo/redo history for keymap edits.
 *
 * Stacks are stored in refs so that `undo()` / `redo()` can return the
 * entry synchronously (needed to feed the keycode back through the guard
 * before the next render). A `version` state counter triggers re-renders
 * for derived values like `canUndo` / `peekUndo`.
 */
export function useKeymapHistory(maxHistory: number): UseKeymapHistoryReturn {
  const undoRef = useRef<HistoryEntry[]>([])
  const redoRef = useRef<HistoryEntry[]>([])
  const [, setVersion] = useState(0)
  const bump = useCallback(() => setVersion((v) => v + 1), [])

  const push = useCallback(
    (entry: HistoryEntry) => {
      const stack = undoRef.current
      stack.push(entry)
      if (stack.length > maxHistory) stack.splice(0, stack.length - maxHistory)
      redoRef.current = []
      bump()
    },
    [maxHistory, bump],
  )

  const undo = useCallback((): HistoryEntry | null => {
    const stack = undoRef.current
    if (stack.length === 0) return null
    const entry = stack.pop()!
    redoRef.current.push(entry)
    bump()
    return entry
  }, [bump])

  const redo = useCallback((): HistoryEntry | null => {
    const stack = redoRef.current
    if (stack.length === 0) return null
    const entry = stack.pop()!
    undoRef.current.push(entry)
    bump()
    return entry
  }, [bump])

  const clear = useCallback(() => {
    if (undoRef.current.length === 0 && redoRef.current.length === 0) return
    undoRef.current = []
    redoRef.current = []
    bump()
  }, [bump])

  return {
    push,
    undo,
    redo,
    canUndo: undoRef.current.length > 0,
    canRedo: redoRef.current.length > 0,
    peekUndo: undoRef.current[undoRef.current.length - 1] ?? null,
    peekRedo: redoRef.current[redoRef.current.length - 1] ?? null,
    clear,
  }
}
