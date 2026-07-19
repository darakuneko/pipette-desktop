// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KEY_FLASH_DURATION_MS } from '../keyboard/key-flash'
import type { KeyFlashState } from '../keyboard/key-flash'
import { posKey, encoderPosKey } from '../../../shared/kle/pos-key'
import type { SingleHistoryEntry } from './useKeymapHistory'

export interface UseKeyFlashReturn {
  /** Positions to flash on the current layer, or `undefined` when no flash
   *  is in-window (or nothing landed on this layer — see the re-slice
   *  memo below). Threaded straight through to `KeyboardPane`. */
  flash: KeyFlashState | undefined
  /** Start (or restart) a flash window over `entries`. Called after a Key
   *  Label "apply to keymap" bulk rewrite AND after a successful undo/redo
   *  (see `useKeymapSelectionHandlers`'s `onHistoryApplied`). No-op for an
   *  empty array (nothing to flash) and for calls that arrive after the
   *  owning component has unmounted. */
  triggerFlash: (entries: SingleHistoryEntry[]) => void
}

/**
 * Shared "flash" visual state for the Key Label "apply to keymap" bulk
 * rewrite and for undo/redo: briefly paints the just-changed positions in
 * the selection colour (KeyWidget's `flashed`, a `key-flash` CSS keyframe
 * overlay — see style.css).
 *
 * Holds the raw triggered batch (not yet layer-filtered) so the derived
 * `flash` memo below can re-slice it if the user switches layers during
 * the window. `generation` bumps on every trigger so `KeyWidget` remounts
 * (and thus restarts) the overlay on a re-trigger instead of reusing a DOM
 * node whose animation may already be finished; `startedAt` is the
 * wall-clock trigger time so `KeyWidget` can compute a negative
 * `animation-delay` for overlays that mount late (e.g. a layer switch
 * mid-window), keeping them on the same timeline instead of restarting
 * their own fade. `flashTimeoutRef` is the single in-flight clear timer; a
 * second trigger (or unmount) always clears it before scheduling/leaving
 * so two flash windows never race. `KEY_FLASH_DURATION_MS` matches
 * `key-flash`'s total animation length exactly, so the overlay is never
 * unmounted mid-fade.
 */
export function useKeyFlash(currentLayer: number): UseKeyFlashReturn {
  const [flashBatch, setFlashBatch] = useState<{ entries: SingleHistoryEntry[]; generation: number; startedAt: number } | null>(null)
  const flashGenerationRef = useRef(0)
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Unmount guard: undo/redo fires `triggerFlash` only after its awaited
  // device writes resolve, which can land after the owning component
  // (KeymapEditor) has already unmounted mid-navigation. A late trigger
  // must be a no-op rather than scheduling a state update / timer that
  // nobody will ever clear.
  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current)
    }
  }, [])

  const triggerFlash = useCallback((entries: SingleHistoryEntry[]) => {
    if (!isMountedRef.current) return
    // Nothing to flash — don't open a window for an empty batch.
    if (entries.length === 0) return
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current)
    setFlashBatch({ entries, generation: ++flashGenerationRef.current, startedAt: Date.now() })
    flashTimeoutRef.current = setTimeout(() => {
      setFlashBatch(null)
      flashTimeoutRef.current = null
    }, KEY_FLASH_DURATION_MS)
  }, [])

  // Re-slice the raw flash batch down to the current layer's key/encoder
  // positions on every layer change — switching layers during the window
  // is intended to flash whatever the newly-visible layer had changed,
  // rather than freezing the set at trigger time. `generation`/`startedAt`
  // pass through unchanged from the batch — they describe the trigger
  // event itself, not the per-layer position set.
  const flash = useMemo<KeyFlashState | undefined>(() => {
    if (!flashBatch) return undefined
    const positions = new Set<string>()
    const encoderPositions = new Set<string>()
    for (const entry of flashBatch.entries) {
      if (entry.layer !== currentLayer) continue
      if (entry.kind === 'key') positions.add(posKey(entry.row, entry.col))
      else encoderPositions.add(encoderPosKey(entry.idx, entry.dir))
    }
    // Either set alone is enough to open a flash window — an encoder-only
    // undo/redo or rewrite must still flash even though `keys` is empty.
    if (positions.size === 0 && encoderPositions.size === 0) return undefined
    return { keys: positions, encoders: encoderPositions, generation: flashBatch.generation, startedAt: flashBatch.startedAt }
  }, [flashBatch, currentLayer])

  return { flash, triggerFlash }
}
