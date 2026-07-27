// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useMemo, useEffect, useRef } from 'react'
import type { BulkKeyEntry } from '../../hooks/useKeyboard'
import type { PopoverState } from './keymap-editor-types'
import type { UseKeymapHistoryReturn, SingleHistoryEntry, HistoryEntry } from './useKeymapHistory'

/** Match a history entry against the current popover position, returning the keycode if matched. */
function matchPopoverEntry(
  popoverState: PopoverState | null,
  entry: HistoryEntry | null,
  currentLayer: number,
  field: 'oldKeycode' | 'newKeycode',
): number | undefined {
  if (!popoverState || !entry || entry.kind === 'batch') return undefined
  if (popoverState.kind === 'key' && entry.kind === 'key' && entry.layer === currentLayer && entry.row === popoverState.row && entry.col === popoverState.col) return entry[field]
  if (popoverState.kind === 'encoder' && entry.kind === 'encoder' && entry.layer === currentLayer && entry.idx === popoverState.idx && entry.dir === popoverState.dir) return entry[field]
  return undefined
}

export interface UseKeymapHistoryActionsOptions {
  history: UseKeymapHistoryReturn
  popoverState: PopoverState | null
  currentLayer: number
  onSetKey: (layer: number, row: number, col: number, keycode: number) => Promise<void>
  onSetKeysBulk: (entries: BulkKeyEntry[]) => Promise<void>
  onSetEncoder: (layer: number, idx: number, dir: number, keycode: number) => Promise<void>
  /** Fires the "flash" visual (see `useKeyFlash`) for the positions an
   *  undo/redo just touched. Contract: called only after ALL of that
   *  entry's device writes have succeeded AND the history stack has been
   *  committed (`history.undo()` / `history.redo()`) — never on a failed
   *  apply, and never before the commit. An exception thrown by this
   *  callback must not retroactively mark the undo/redo as failed, so it
   *  is invoked after `handleUndo`/`handleRedo`'s own try/finally has
   *  already run to completion. Receives the normalized entry list
   *  (`entry.kind === 'batch' ? entry.entries : [entry]`). */
  onHistoryApplied?: (entries: SingleHistoryEntry[]) => void
  /** Reads the current popover-advance epoch (see
   *  `useKeymapSelectionHandlers`'s `popoverAdvanceEpochRef`) without
   *  incrementing it — this hook only ever needs to snapshot it, never
   *  bump it, so the ref itself is deliberately not handed over here. */
  getPopoverEpoch: () => number
  /** Closes the popover only if `epoch` still matches the current epoch —
   *  a no-op otherwise (a newer selection/write already took over in the
   *  meantime). Bumping the epoch on close is the state owner's job, not
   *  this hook's — see the controller comment above. */
  closePopoverIfEpochMatches: (epoch: number) => void
}

export function useKeymapHistoryActions({
  history,
  popoverState,
  currentLayer,
  onSetKey,
  onSetKeysBulk,
  onSetEncoder,
  onHistoryApplied,
  getPopoverEpoch,
  closePopoverIfEpochMatches,
}: UseKeymapHistoryActionsOptions) {
  // --- History-derived popover undo ---
  const popoverUndoKeycode = useMemo(
    () => matchPopoverEntry(popoverState, history.peekUndo, currentLayer, 'oldKeycode'),
    [popoverState, currentLayer, history.peekUndo],
  )

  // --- Undo / redo ---
  const applyHistoryEntry = useCallback(async (entry: HistoryEntry, isUndo: boolean) => {
    if (entry.kind === 'batch') {
      const items = isUndo ? [...entry.entries].reverse() : entry.entries
      const keyEntries: BulkKeyEntry[] = []
      const encoderOps: { layer: number; idx: number; dir: number; code: number }[] = []
      for (const e of items) {
        const code = isUndo ? e.oldKeycode : e.newKeycode
        if (e.kind === 'key') keyEntries.push({ layer: e.layer, row: e.row, col: e.col, keycode: code })
        else encoderOps.push({ layer: e.layer, idx: e.idx, dir: e.dir, code })
      }
      if (keyEntries.length > 0) await onSetKeysBulk(keyEntries)
      for (const op of encoderOps) await onSetEncoder(op.layer, op.idx, op.dir, op.code)
    } else {
      const code = isUndo ? entry.oldKeycode : entry.newKeycode
      if (entry.kind === 'key') await onSetKey(entry.layer, entry.row, entry.col, code)
      else await onSetEncoder(entry.layer, entry.idx, entry.dir, code)
    }
  }, [onSetKey, onSetKeysBulk, onSetEncoder])

  // In-flight guard to prevent concurrent undo/redo
  const undoRedoInFlightRef = useRef(false)

  // Undo and redo differ only in direction (which stack to peek/commit,
  // and which side of the entry `applyHistoryEntry` restores) — shared here
  // instead of duplicating the guard/apply/commit/notify sequence twice.
  const runHistoryStep = useCallback(async (isUndo: boolean) => {
    if (undoRedoInFlightRef.current) return
    const entry = isUndo ? history.peekUndo : history.peekRedo
    if (!entry) return
    undoRedoInFlightRef.current = true
    // Snapshot the epoch before the device writes below — which, for a
    // batch entry, run as a sequence of awaited HID calls and can take
    // long enough for the user to open a different popover in the
    // meantime. `undoRedoInFlightRef` only blocks a second concurrent
    // undo/redo; it does nothing to stop that other popover from opening.
    // Re-checking the epoch here before closing the popover keeps this
    // consistent with the other popover write handlers, which all live in
    // useKeymapSelectionHandlers.ts (`resolvePopoverConfirm`,
    // `tryAdvancePopover`, `applySelectionChange`): a stale completion
    // must never clobber something newer.
    const epoch = getPopoverEpoch()
    try {
      await applyHistoryEntry(entry, isUndo)
      // Commit only after successful apply.
      if (isUndo) history.undo()
      else history.redo()
    } finally { undoRedoInFlightRef.current = false }
    closePopoverIfEpochMatches(epoch)
    // Fire outside the try/finally above: a throw from `applyHistoryEntry`
    // or the commit call propagates out of the `try` (after `finally`
    // resets the in-flight guard) and skips everything below, so reaching
    // this line already guarantees the apply + commit succeeded — no flag
    // needed to gate it. Placement after the commit is what guarantees
    // `onHistoryApplied` can no longer un-commit the undo/redo or leave the
    // in-flight guard stuck. The flash it triggers is purely cosmetic, so a
    // throw from the callback itself is swallowed here rather than
    // rejecting `runHistoryStep`'s promise — the undo/redo already
    // succeeded and must not be reported as failed just because the flash
    // visual couldn't be shown.
    try {
      onHistoryApplied?.(entry.kind === 'batch' ? entry.entries : [entry])
    } catch {
      // Intentionally ignored — see comment above.
    }
  }, [history, applyHistoryEntry, onHistoryApplied, getPopoverEpoch, closePopoverIfEpochMatches])

  const handleUndo = useCallback(() => runHistoryStep(true), [runHistoryStep])
  const handleRedo = useCallback(() => runHistoryStep(false), [runHistoryStep])

  const handlePopoverUndo = useCallback(() => {
    if (popoverUndoKeycode == null) return
    void handleUndo()
  }, [popoverUndoKeycode, handleUndo])

  // --- History-derived popover redo (top-only) ---
  const popoverRedoKeycode = useMemo(
    () => matchPopoverEntry(popoverState, history.peekRedo, currentLayer, 'newKeycode'),
    [popoverState, currentLayer, history.peekRedo],
  )

  const handlePopoverRedo = useCallback(() => {
    if (popoverRedoKeycode == null) return
    void handleRedo()
  }, [popoverRedoKeycode, handleRedo])

  // --- Keyboard shortcuts for undo/redo ---
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as Element | null
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      if (target?.closest?.('[contenteditable]')) return
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); void handleUndo(); return }
      if (key === 'z' && e.shiftKey) { e.preventDefault(); void handleRedo(); return }
      if (key === 'y' && !e.shiftKey) { e.preventDefault(); void handleRedo(); return }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleUndo, handleRedo])

  return {
    popoverUndoKeycode,
    handlePopoverUndo,
    popoverRedoKeycode,
    handlePopoverRedo,
    handleUndo,
    handleRedo,
  }
}
