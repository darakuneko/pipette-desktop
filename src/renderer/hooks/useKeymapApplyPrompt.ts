// SPDX-License-Identifier: GPL-2.0-or-later
//
// Owns the "does this Key Label pack want a keymap rewrite?" decision for
// the simulation tab's Apply button (Plan-qwerty-select-no-rewrite v7 —
// シミュレーションタブ方式): reads `activeRewriteTable` — already resolved
// and validated by `useDevicePrefs` (`keymapApplicable && buildKeymapRewrite
// Table(map).ok`, the same predicate `remapKind === 'simulated'` gates on)
// — before deciding whether to prompt with KeymapApplyConfirmModal.
//
// The footer's Keyboard Layout select never opens this modal itself
// anymore — `handleKeyboardLayoutChange` is a plain display switch for
// EVERY value, including QWERTY (no more per-value branching). Selecting a
// pack that supports a rewrite instead surfaces `KeymapEditor`'s
// simulation/Base tabs (gated by `useDevicePrefs.remapKind ===
// 'simulated'`, the SAME `keymapApplicable && buildKeymapRewriteTable(map)
// .ok` predicate this hook re-derives below) — the Apply button living on
// the simulation tab's layer row is what calls `requestApply()`, the only
// entry point left into this modal.
//
// A Rewrite is still a destructive one-shot: undo/redo history is wiped
// the moment any write lands, and recovery is the user's own .vil/snapshot
// backup (the modal recommends saving first), not Undo. On a clean success
// the select resets to QWERTY, the same clean state a snapshot/.vil
// restore leaves — which also makes the simulation tabs disappear, since
// `remapKind` reverts to 'actual' for QWERTY.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeymapRewriteTable } from '../../shared/keymap/keymap-apply'
import { BUILTIN_QWERTY_LAYOUT_ID } from '../data/keyboard-layouts'
import type { KeyboardLayoutId } from './useKeyboardLayout'
import type { KeymapApplyResult } from '../components/editors/keymap-editor-types'

export interface UseKeymapApplyPromptOptions {
  /** True when the connected device has a loaded keymap to rewrite. Without
   *  it, `requestApply` never opens the modal — there's nothing to write. */
  keymapEditable: boolean
  /** The Keyboard Layout select's current value — `requestApply` reads
   *  `activeRewriteTable`/`activeLayoutName` alongside this id, and the
   *  race-guard effect below watches it to close a stale pending modal the
   *  instant it changes out from under the request that opened it. */
  keyboardLayout: string
  onKeyboardLayoutChange?: (layout: KeyboardLayoutId) => void
  /** Bulk-rewrite the live keymap via `KeymapEditorHandle.applyKeymapRewrite`. */
  onApplyKeymapRewrite?: (table: KeymapRewriteTable) => Promise<KeymapApplyResult>
  /** `KeyboardState.keymapRestoreSeq` — bumped by `applyVilFile` on every
   *  successful snapshot/layout-store restore or `.vil` import
   *  (Plan-qwerty-select-no-rewrite §snapshot/.vil 復元時のクリーンアップ).
   *  An increase closes an open confirm modal defensively: the restore
   *  just replaced the whole keymap this modal's pending Apply would
   *  otherwise act against. */
  keymapRestoreSeq?: number
  /** `useDevicePrefs.activeRewriteTable` — the CURRENT `keyboardLayout`'s
   *  own rewrite table, already resolved and validated by `useDevicePrefs`
   *  (the same `keymapApplicable && buildKeymapRewriteTable(map).ok`
   *  predicate `remapKind === 'simulated'` itself gates on). `requestApply`
   *  reads this synchronously instead of re-deriving it via its own
   *  `useKeyLabelLookup` lookup — by the time the Apply button that calls
   *  `requestApply` is even reachable, `remapKind` already required this
   *  exact table to build. `undefined` means the active pack isn't (or is
   *  no longer) rewrite-eligible — `requestApply` no-ops. */
  activeRewriteTable?: KeymapRewriteTable
  /** `useDevicePrefs.activeLayoutName` — display name for the CURRENT
   *  `keyboardLayout`, shown in the confirm modal's title. */
  activeLayoutName?: string
}

export interface UseKeymapApplyPromptReturn {
  /** Pass straight through as the Keyboard Layout select's `onChange` — a
   *  plain display switch for every value now, never a lookup/modal. */
  handleKeyboardLayoutChange: (v: string) => void
  /** Check whether the current selection wants a Rewrite and, if so, open
   *  the confirm modal. Called by the simulation tab's Apply button — see
   *  `KeymapEditor`'s `onRequestKeymapApply`. */
  requestApply: () => void
  /** Non-null while the confirm modal should be open. */
  pendingApply: { id: string; name: string } | null
  handleApplyCancel: () => void
  handleApplyConfirm: () => void
  /** Set after a partial-failure apply; cleared on the next request. */
  applyError: string | null
  /** True from the moment `handleApplyConfirm` starts its (awaited)
   *  `onApplyKeymapRewrite` call until it settles. Drives the modal's
   *  buttons disabled — a double-click on Apply must never fire a second
   *  rewrite: `KeymapEditor.applyKeymapRewrite`'s own re-entrancy guard
   *  would answer the second call with `{ appliedCount: 0 }` and NO error,
   *  which this hook would otherwise read as a clean success and reset the
   *  select to QWERTY even if the real (first) apply later ends in a
   *  partial failure whose contract is "select untouched". */
  isApplying: boolean
}

export function useKeymapApplyPrompt({
  keymapEditable,
  keyboardLayout,
  onKeyboardLayoutChange,
  onApplyKeymapRewrite,
  keymapRestoreSeq,
  activeRewriteTable,
  activeLayoutName,
}: UseKeymapApplyPromptOptions): UseKeymapApplyPromptReturn {
  const [pendingApply, setPendingApply] = useState<{ id: string; name: string; table: KeymapRewriteTable } | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)

  // In-flight latch for the Confirm apply, checked synchronously (a ref,
  // not just the mirrored `isApplying` state below) so a double-click that
  // lands before React re-renders the modal's now-disabled buttons still
  // can't slip a second `onApplyKeymapRewrite` call through. Only the FIRST
  // invocation's result may drive the select reset / error state; the
  // second click is a plain no-op rather than a call KeymapEditor's own
  // re-entrancy guard would answer with a misleading "clean" result.
  const applyInFlightRef = useRef(false)
  const [isApplying, setIsApplying] = useState(false)

  // Bumped on every `requestApply`/`handleKeyboardLayoutChange` call and on
  // every observed `keyboardLayout` change (see the watch effect below —
  // the sibling `keymapRestoreSeq` watcher further down only needs to close
  // the modal, not bump this, see its own comment). `handleApplyConfirm`
  // snapshots it at Confirm time and re-checks it after `onApplyKeymapRewrite`
  // settles, so a layout change mid-apply (the user picks a DIFFERENT pack,
  // or QWERTY, before the stale apply resolves) discards that apply's
  // result instead of clobbering the new selection back to QWERTY.
  // `requestApply` itself resolves synchronously off `activeRewriteTable`
  // now (no lookup to supersede), but still bumps this on every call — see
  // its own comment.
  const requestSeqRef = useRef(0)

  // RACE (Plan-qwerty-select-no-rewrite v7, new/mandatory): the select no
  // longer routes through this hook's own onChange-time lookup — a value
  // change can now land at any time, including while the confirm modal for
  // a DIFFERENT pack is already open (e.g. open Colemak's warning, then
  // pick Dvorak from the select before confirming — the pending modal
  // would otherwise go on to rewrite Colemak's table against a keymap the
  // user has already moved away from). Watching the value itself — rather
  // than only closing the modal inline inside `handleKeyboardLayoutChange`
  // — catches every path that can change it, not just this hook's own
  // setter call.
  const keyboardLayoutRef = useRef(keyboardLayout)
  useEffect(() => {
    const prev = keyboardLayoutRef.current
    keyboardLayoutRef.current = keyboardLayout
    if (keyboardLayout === prev) return
    ++requestSeqRef.current
    setPendingApply(null)
  }, [keyboardLayout])

  // Defensive close (Plan-qwerty-select-no-rewrite §snapshot/.vil 復元時の
  // クリーンアップ, D3): the counter is monotonic for the session (disconnect
  // carries it forward rather than zeroing it, see keyboard-types.ts), so
  // any change here means a new restore landed.
  //
  // Deliberately does NOT touch `applyInFlightRef`/`isApplying`: if a
  // restore lands while a Confirm apply is still awaiting
  // `onApplyKeymapRewrite` (unusual — the button is disabled — but not
  // impossible via a stray call), this just closes the modal early; the
  // in-flight apply's own `try/finally` in `handleApplyConfirm` is what
  // guarantees the latch clears once it settles, regardless of whether
  // `pendingApply` was already nulled out from under it. That same in-
  // flight apply independently discards its own result against a fresh
  // restore-seq snapshot taken at Confirm time (see `handleApplyConfirm`'s
  // own `keymapRestoreSeqRef` comparison) — a dedicated check, not routed
  // through `requestSeqRef` — so this effect only needs to close the modal,
  // nothing more.
  const keymapRestoreSeqRef = useRef(keymapRestoreSeq)
  useEffect(() => {
    const prev = keymapRestoreSeqRef.current
    keymapRestoreSeqRef.current = keymapRestoreSeq
    if (keymapRestoreSeq === undefined || prev === undefined || keymapRestoreSeq === prev) return
    setPendingApply(null)
  }, [keymapRestoreSeq])

  // Plain display switch for every value — QWERTY included, no more
  // per-value branching. The layout-watch effect above independently
  // closes any pending modal once `keyboardLayout` actually changes as a
  // result of this call; the explicit reset here is belt-and-braces so the
  // modal never flashes open for a single tick between this call and that
  // effect's next run.
  const handleKeyboardLayoutChange = useCallback((v: string) => {
    setApplyError(null)
    ++requestSeqRef.current
    setPendingApply(null)
    onKeyboardLayoutChange?.(v as KeyboardLayoutId)
  }, [onKeyboardLayoutChange])

  // Entry point for the simulation tab's Apply button. Resolves
  // synchronously off `activeRewriteTable` — `useDevicePrefs` already built
  // and validated it for this exact `keyboardLayout` as part of deriving
  // `remapKind === 'simulated'`, which is the only state in which
  // `KeymapEditor` renders the tabs/button that calls this at all — so
  // there is nothing left to look up here. Stays defensive (falls through
  // to a no-op) so a stray call against QWERTY, an ineligible pack, or a
  // pack whose table hasn't resolved yet can't open a bogus modal. Still
  // bumps `requestSeqRef` on every call (even though there's no longer an
  // async gap for it to guard within THIS function): if a Confirm for a
  // PRIOR request is somehow still in flight when this fires (the visible
  // Apply button is disabled for that whole window, so not normally
  // user-reachable), the bump makes that stale Confirm's eventual
  // resolution skip the QWERTY-reset / error-surfacing branch instead of
  // clobbering whatever this fresh request leads to — though its own
  // unconditional `setPendingApply(null)` can still close a modal this
  // fresh request opened in that same narrow window; see
  // `handleApplyConfirm`'s resolution order below.
  const requestApply = useCallback(() => {
    setApplyError(null)
    const v = keyboardLayout
    if (v === BUILTIN_QWERTY_LAYOUT_ID || !keymapEditable || !onApplyKeymapRewrite || !activeRewriteTable) return
    ++requestSeqRef.current
    setPendingApply({ id: v, name: activeLayoutName ?? v, table: activeRewriteTable })
  }, [keyboardLayout, keymapEditable, onApplyKeymapRewrite, activeRewriteTable, activeLayoutName])

  // Cancel is a no-op while an apply is in flight — the modal disables its
  // button (via `isApplying`) as the primary defense, but this ref check is
  // the actual guard: Escape (`useEscapeClose`) and the backdrop click both
  // route through `onCancel` regardless of button `disabled` state, so it
  // must be safe to call at any time.
  const handleApplyCancel = useCallback(() => {
    if (applyInFlightRef.current) return
    setPendingApply(null)
  }, [])

  const handleApplyConfirm = useCallback(() => {
    if (!pendingApply || !onApplyKeymapRewrite) return
    // Re-entrancy guard: a double-clicked Apply (or any other concurrent
    // caller) must never fire a second `onApplyKeymapRewrite` while the
    // first is still in flight — see the ref's own doc comment above.
    if (applyInFlightRef.current) return
    applyInFlightRef.current = true
    setIsApplying(true)
    const { table } = pendingApply
    // Restore race: snapshot the restore counter now. If a snapshot/.vil
    // restore lands while this apply is in flight (replacing the keymap
    // this apply is still writing against), the restore's own cleanup —
    // closing the modal — must win. Comparing the ref again after the
    // await below is what detects that and discards this call's result
    // entirely, rather than resetting the select on top of a keymap the
    // restore already replaced.
    const restoreSeqAtStart = keymapRestoreSeqRef.current
    // Layout race (external review finding): the select is no longer
    // locked while this apply is in flight — the user can pick a
    // DIFFERENT pack (or QWERTY) before this Confirm's own
    // `onApplyKeymapRewrite` settles. `requestSeqRef` is bumped by the
    // layout-watch effect on every OBSERVED `keyboardLayout` change (and
    // by the restore effect too, so this single snapshot doubles as a
    // second, redundant-but-harmless restore-race check) — comparing it
    // after the await is what stops a stale apply for the OLD pack from
    // clobbering the NEW selection back to QWERTY on a clean success.
    const requestSeqAtStart = requestSeqRef.current
    void (async () => {
      try {
        const result = await onApplyKeymapRewrite(table)
        const supersededByRestore = keymapRestoreSeqRef.current !== restoreSeqAtStart
        const supersededByLayoutChange = requestSeqRef.current !== requestSeqAtStart
        setPendingApply(null)
        if (supersededByRestore || supersededByLayoutChange) return
        if (result.error) {
          // Partial failure: the keymap is now a MIXED state (some positions
          // rewritten, some not) — it is neither still QWERTY nor fully the
          // target arrangement, so the display selection is deliberately
          // left untouched. The errorPartial message tells the user to
          // restore from a previously saved .vil/snapshot if needed — the
          // rewrite already wiped the undo/redo stacks for whatever DID land
          // (`KeymapEditor.applyKeymapRewrite`'s `history.clear()` fires on
          // ANY landed write, unconditional on `error` — see its own comment).
          setApplyError(result.error)
          return
        }
        // Clean success (and a zero-count success alike — Plan-kaw-v7-tabs
        // point 6: an appliedCount of 0 means the keymap already matched the
        // target arrangement, so the Apply intent is already satisfied):
        // Rewrite is a destructive one-shot (v5 最終仕様) — the select resets
        // to QWERTY, the same clean state a snapshot/.vil restore leaves.
        // `useDevicePrefs.remapKind` reverts to 'actual' for QWERTY, so the
        // simulation/Base tabs disappear along with it.
        onKeyboardLayoutChange?.(BUILTIN_QWERTY_LAYOUT_ID as KeyboardLayoutId)
      } finally {
        // Always clears, even if a restore landed mid-apply and already
        // nulled `pendingApply` out from under this closure (the `table`
        // captured above is independent of that state) — the latch must
        // never wedge `isApplying`/the modal's buttons in the disabled state.
        applyInFlightRef.current = false
        setIsApplying(false)
      }
    })()
  }, [pendingApply, onApplyKeymapRewrite, onKeyboardLayoutChange])

  return {
    handleKeyboardLayoutChange,
    requestApply,
    pendingApply: pendingApply ? { id: pendingApply.id, name: pendingApply.name } : null,
    handleApplyCancel,
    handleApplyConfirm,
    applyError,
    isApplying,
  }
}
