// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useRef } from 'react'
import { rewriteNumericKeycode } from '../../../shared/keymap/keymap-apply'
import type { KeymapRewriteTable } from '../../../shared/keymap/keymap-apply'
import type { KeymapApplyResult } from './keymap-editor-types'
import type { SingleHistoryEntry, UseKeymapHistoryReturn } from './useKeymapHistory'

export interface UseKeymapRewriteOptions {
  keymap: Map<string, number>
  encoderLayout: Map<string, number>
  onSetKey: (layer: number, row: number, col: number, keycode: number) => Promise<void>
  onSetEncoder: (layer: number, idx: number, dir: number, keycode: number) => Promise<void>
  history: UseKeymapHistoryReturn
  triggerFlash: (entries: SingleHistoryEntry[]) => void
}

export interface UseKeymapRewriteReturn {
  applyKeymapRewrite: (table: KeymapRewriteTable) => Promise<KeymapApplyResult>
}

// --- Key Label "apply to keymap" bulk rewrite (Plan-key-label-keymap-apply
// Phase 3). Reachable from the footer's layout select via the imperative
// handle in KeymapEditor, so the write lands on this same `history` instance
// instead of a second undo stack. Writes go through `onSetKey` /
// `onSetEncoder` sequentially (not `onSetKeysBulk`) so a mid-way failure
// leaves both the local keymap state and the pushed history entry
// containing only the positions that actually succeeded.
export function useKeymapRewrite({
  keymap, encoderLayout, onSetKey, onSetEncoder, history, triggerFlash,
}: UseKeymapRewriteOptions): UseKeymapRewriteReturn {
  // Same "ref mirrors the latest prop for use inside a stable callback"
  // idiom as `hasActiveSingleSelectionRef` in KeymapEditor: `keymap`/
  // `encoderLayout` are re-read fresh from these refs before every single
  // write below, so a concurrent edit that lands on a position between two
  // `await`s (or during a re-render triggered by one of this function's own
  // writes) is detected instead of silently clobbered.
  const keymapRef = useRef(keymap)
  keymapRef.current = keymap
  const encoderLayoutRef = useRef(encoderLayout)
  encoderLayoutRef.current = encoderLayout
  const isApplyingRewriteRef = useRef(false)
  // Belt-and-braces unmount guard: the editor-footer Analyze button can open
  // AnalyzePage (unmounting this component) while a rewrite's sequential
  // `await`ed device writes are still in flight — the caller-side guard in
  // App.tsx disables that button while a rewrite is running, but this ref
  // is the last line of defense so a rewrite already past that guard still
  // stops cleanly instead of pushing history / firing callbacks / setting
  // state on an unmounted component.
  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => { isMountedRef.current = false }
  }, [])

  const applyKeymapRewrite = useCallback(async (
    table: KeymapRewriteTable,
  ): Promise<KeymapApplyResult> => {
    // Re-entrancy guard: a double Apply click (or any other concurrent
    // caller) must never interleave two rewrite passes against the same
    // undo stack. No-op rather than throwing — the in-flight call already
    // owns the operation.
    if (isApplyingRewriteRef.current) return { appliedCount: 0 }
    isApplyingRewriteRef.current = true

    try {
      const keyChanges: { layer: number; row: number; col: number; oldKeycode: number; newKeycode: number }[] = []
      for (const [posKey, code] of keymap) {
        const newKeycode = rewriteNumericKeycode(code, table)
        if (newKeycode === code) continue
        const [layer, row, col] = posKey.split(',').map(Number)
        keyChanges.push({ layer, row, col, oldKeycode: code, newKeycode })
      }
      const encoderChanges: { layer: number; idx: number; dir: number; oldKeycode: number; newKeycode: number }[] = []
      for (const [posKey, code] of encoderLayout) {
        const newKeycode = rewriteNumericKeycode(code, table)
        if (newKeycode === code) continue
        const [layer, idx, dir] = posKey.split(',').map(Number)
        encoderChanges.push({ layer, idx, dir, oldKeycode: code, newKeycode })
      }

      const applied: SingleHistoryEntry[] = []
      let error: string | undefined
      try {
        for (const c of keyChanges) {
          // Stop immediately once the component has unmounted (e.g. the
          // Analyze button navigated away mid-rewrite) — no further writes.
          if (!isMountedRef.current) break
          // Freshness check: skip this position if a concurrent edit
          // already moved it away from the value this rewrite was
          // computed against, instead of overwriting whatever that edit
          // just wrote.
          const current = keymapRef.current.get(`${c.layer},${c.row},${c.col}`) ?? 0
          if (current !== c.oldKeycode) continue
          await onSetKey(c.layer, c.row, c.col, c.newKeycode)
          applied.push({ kind: 'key', layer: c.layer, row: c.row, col: c.col, oldKeycode: c.oldKeycode, newKeycode: c.newKeycode })
        }
        for (const c of encoderChanges) {
          if (!isMountedRef.current) break
          const current = encoderLayoutRef.current.get(`${c.layer},${c.idx},${c.dir}`) ?? 0
          if (current !== c.oldKeycode) continue
          await onSetEncoder(c.layer, c.idx, c.dir, c.newKeycode)
          applied.push({ kind: 'encoder', layer: c.layer, idx: c.idx, dir: c.dir as 0 | 1, oldKeycode: c.oldKeycode, newKeycode: c.newKeycode })
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }

      // Unmounted mid-rewrite: skip ALL bookkeeping below (history clear,
      // post-apply flash state/timer) — the component is gone, so there is
      // nothing left to flash and no history stack of this instance to
      // touch. The device is left mid-rewrite exactly like a
      // partial-failure apply; the counts are still returned to the caller
      // for its own error surfacing.
      //
      // Rewrite is a destructive one-shot (Plan-qwerty-select-no-rewrite v5
      // 最終仕様), same class of operation as a snapshot/.vil restore: the
      // moment ANY write actually landed, both undo/redo stacks are wiped
      // rather than gaining a revertible batch entry — no history entry is
      // ever pushed for a rewrite, success or partial failure alike.
      // Recovery from a bad or partial rewrite is the user's own
      // .vil/snapshot backup (the confirm modal recommends saving before
      // applying), not Undo. A rewrite that touched nothing (table matched
      // no live keycode, or the very first write itself failed) leaves
      // history untouched — nothing was destroyed, so there's nothing to
      // protect the user from.
      //
      // This clear fires on ANY landed write, including a partial failure —
      // it is unconditional on `error`. The OTHER half of the destructive
      // one-shot contract — resetting the footer's select back to QWERTY —
      // lives one layer up, in `useKeymapApplyPrompt.handleApplyConfirm`,
      // and fires ONLY on a clean (error-free) success; a partial failure
      // leaves the select untouched there. Shared invariant: a rewrite
      // leaves no undo trail; only a clean success returns the select to
      // QWERTY.
      if (applied.length > 0 && isMountedRef.current) {
        history.clear()
        // Flash the rewritten positions (see `useKeyFlash`) — only for a
        // clean, error-free pass. A partial failure leaves the keymap
        // mixed, which isn't the "here's what changed" story this visual
        // is telling.
        if (error === undefined) triggerFlash(applied)
      }
      return { appliedCount: applied.length, error }
    } finally {
      isApplyingRewriteRef.current = false
    }
  }, [keymap, encoderLayout, onSetKey, onSetEncoder, history, triggerFlash])

  return { applyKeymapRewrite }
}
