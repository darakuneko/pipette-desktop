// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared drag-to-reorder state machine for the pack modals' Installed
// lists. Ported from `KeyLabelsModal.tsx`'s `dragOrder` /
// `handleDragStart` / `handleDragOver` / `handleDragEnd` trio (Phase 1
// kept those Key-Labels-only; Phase 2 extends drag reorder to
// Language Packs and Theme Packs, so the mechanism moves here).
//
// `ids` is the caller's current *reorderable* id list in baseline
// order (Key Labels: every meta including QWERTY; Language/Theme
// Packs: store metas only — built-ins are never store entries and
// must be filtered out by the caller before this hook sees them).
//
// The returned handlers are plain functions (not `useCallback`), same
// as the original KeyLabelsModal code — they close over the latest
// `dragOrder` / `ids` each render, which is simpler than threading a
// ref through a memoized callback and costs nothing here (drag
// handlers are not a hot re-render path).

import { useRef, useState } from 'react'

export interface UseDragReorderOptions {
  /** Current reorderable ids, in baseline (non-dragging) order. */
  ids: string[]
  reorder: (orderedIds: string[]) => Promise<{ success: boolean; error?: string }>
  /** Called with the raw error string (possibly undefined) on failure;
   *  the caller resolves it to its own translated fallback message. */
  onError: (error: string | undefined) => void
}

export interface UseDragReorderResult {
  /** Live drag order override, or null when no drag is in progress.
   *  Callers apply this via `applyDragOrder` when rendering rows. */
  dragOrder: string[] | null
  onDragStart: (id: string) => void
  onDragOver: (overId: string) => void
  onDragEnd: () => Promise<void>
}

export function useDragReorder({ ids, reorder, onError }: UseDragReorderOptions): UseDragReorderResult {
  const [dragOrder, setDragOrder] = useState<string[] | null>(null)

  // Tracks the dragged id across the drag gesture; a ref (not state)
  // because updating it must not trigger a render.
  const dragIdRef = useRef<string | null>(null)

  const onDragStart = (id: string): void => {
    dragIdRef.current = id
    if (dragOrder === null) setDragOrder(ids.slice())
  }

  const onDragOver = (overId: string): void => {
    const dragId = dragIdRef.current
    if (!dragId || dragId === overId) return
    const baseline = dragOrder ?? ids
    const fromIdx = baseline.indexOf(dragId)
    const toIdx = baseline.indexOf(overId)
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return
    const next = baseline.slice()
    next.splice(fromIdx, 1)
    next.splice(toIdx, 0, dragId)
    setDragOrder(next)
  }

  const onDragEnd = async (): Promise<void> => {
    const order = dragOrder
    dragIdRef.current = null
    if (!order) {
      setDragOrder(null)
      return
    }
    // Keep the optimistic order applied while the reorder IPC +
    // refresh round trip is in flight; otherwise the rows would snap
    // back to the stale pre-drag order before the new index lands.
    const result = await reorder(order)
    setDragOrder(null)
    if (!result.success) onError(result.error)
  }

  return { dragOrder, onDragStart, onDragOver, onDragEnd }
}
