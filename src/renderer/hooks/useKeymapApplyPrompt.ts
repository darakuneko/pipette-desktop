// SPDX-License-Identifier: GPL-2.0-or-later
//
// Owns the "does this Key Label pack want a keymap rewrite?" decision for
// the footer's Keyboard Layout select (Plan-qwerty-select-no-rewrite,
// WYSIWYG select semantics): fetches the target's full payload, checks
// `keymapApplicable`, and validates it with `buildKeymapRewriteTable`
// before deciding whether to prompt with KeymapApplyConfirmModal or fall
// through to today's direct display-only switch. Extracted out of
// QuickSettingsSelects so the footer component only owns rendering, not
// this validation/orchestration.
//
// The select value is WYSIWYG: it is the last thing the user actually
// picked, and a successful Rewrite keeps it there instead of force-
// resetting to QWERTY (Plan-qwerty-select-no-rewrite Phase K) — the select
// stays on the rewritten arrangement, paired with a `keymapWritten` flag
// that gates the keymap surface into raw-legend-plus-changed-key-tint
// rendering (see useDevicePrefs.ts). There is no compose/inverse machinery
// — a Rewrite always applies the target's own table directly against
// whatever the keymap currently holds (the user is warned to save first;
// recovery from a mis-timed rewrite is the user's own .vil/snapshot
// backup, not Undo — the rewrite wipes the undo/redo stacks). QWERTY is
// always inert: selecting it only switches the display, never touches the
// keymap or opens a modal.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useKeyLabelLookup } from './useKeyLabelLookup'
import { buildKeymapRewriteTable, type KeymapRewriteTable } from '../../shared/keymap/keymap-apply'
import { BUILTIN_QWERTY_LAYOUT_ID } from '../data/keyboard-layouts'
import type { KeyboardLayoutId } from './useKeyboardLayout'
import type { KeymapApplyResult } from '../components/editors/keymap-editor-types'

export interface UseKeymapApplyPromptOptions {
  /** True when the connected device has a loaded keymap to rewrite. Without
   *  it, a flagged pack always falls back to today's display-only switch. */
  keymapEditable: boolean
  /** The Keyboard Layout select's current value (same as what the select
   *  renders) — the sole guard for the "nothing to do" case: re-picking
   *  this exact value is always display-only, no modal. */
  keyboardLayout: string
  /** The select's current persisted `keymapWritten` flag (Plan-qwerty-
   *  select-no-rewrite Phase K) — read ONLY by the same-value reselect
   *  guard below, so re-picking the current value passes it straight back
   *  through instead of accidentally clearing it via `onKeyboardLayoutChange`
   *  (nothing actually changed, so nothing should be reset). */
  keymapWritten: boolean
  /** Atomic (layout, written) setter — Phase K. Every call site here passes
   *  `written` explicitly per the transition it represents; see each call
   *  below for which one applies. */
  onKeyboardLayoutChange?: (layout: KeyboardLayoutId, written: boolean) => void
  /** Bulk-rewrite the live keymap via `KeymapEditorHandle.applyKeymapRewrite`. */
  onApplyKeymapRewrite?: (table: KeymapRewriteTable) => Promise<KeymapApplyResult>
  /** `KeyboardState.keymapRestoreSeq` — bumped by `applyVilFile` on every
   *  successful snapshot/layout-store restore or `.vil` import
   *  (Plan-qwerty-select-no-rewrite §snapshot/.vil 復元時のクリーンアップ).
   *  An increase closes an open confirm modal defensively: the restore
   *  just replaced the whole keymap this modal's pending Apply/Display Only
   *  would otherwise act against. It also forces `keymapWritten` back to
   *  false (Phase K): the restore replaced the keymap contents the flag
   *  described, so any "these keys were rewritten" coloring based on it is
   *  no longer trustworthy. The select value itself is untouched — only the
   *  written flag resets. */
  keymapRestoreSeq?: number
}

export interface UseKeymapApplyPromptReturn {
  /** Pass straight through as the Keyboard Layout select's `onChange`. */
  handleKeyboardLayoutChange: (v: string) => void
  /** Non-null while the confirm modal should be open. */
  pendingApply: { id: string; name: string } | null
  handleApplyCancel: () => void
  handleApplyDisplayOnly: () => void
  handleApplyConfirm: () => void
  /** Set after a partial-failure apply; cleared on the next selection. */
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

/** Resolve `id`'s own rewrite table when it's flagged `keymapApplicable`
 *  and its map actually builds. Returns `null` when `id` isn't
 *  rewrite-eligible at all (flag-less pack, failed build, or a pack
 *  that's missing/not yet loaded locally). QWERTY is never passed in here
 *  — it's handled as an early return in `handleKeyboardLayoutChange`
 *  before any lookup happens. */
async function resolveRewriteTable(
  id: string,
  keyLabelLookup: ReturnType<typeof useKeyLabelLookup>,
): Promise<KeymapRewriteTable | null> {
  await keyLabelLookup.ensure(id)
  const map = keyLabelLookup.getMap(id)
  if (!map || !keyLabelLookup.getKeymapApplicable(id)) return null
  const result = buildKeymapRewriteTable(map)
  return result.ok ? result.table : null
}

export function useKeymapApplyPrompt({
  keymapEditable,
  keyboardLayout,
  keymapWritten,
  onKeyboardLayoutChange,
  onApplyKeymapRewrite,
  keymapRestoreSeq,
}: UseKeymapApplyPromptOptions): UseKeymapApplyPromptReturn {
  const keyLabelLookup = useKeyLabelLookup()
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

  // Bumped on every invocation; the async lookups below re-check it after
  // each `await` so a newer selection always wins over a slower older one
  // (selection race — two quick picks where the first's lookups resolve
  // after the second's must never let the first overwrite the second's
  // prompt or fire a stale display-only switch). The QWERTY early return
  // also relies on this bump: it invalidates any in-flight lookup from a
  // prior (non-QWERTY) selection so a slower lookup can never open a
  // modal after the user has already moved on to QWERTY.
  const requestSeqRef = useRef(0)

  // Mirrors kept purely so the restore-seq effect below can read the
  // LATEST layout id / setter without listing them in its own dependency
  // array (that array must stay keyed on `keymapRestoreSeq` alone — see its
  // comment). Same pattern as `keymapRestoreSeqRef` itself.
  const keyboardLayoutRef = useRef(keyboardLayout)
  useEffect(() => { keyboardLayoutRef.current = keyboardLayout }, [keyboardLayout])
  const onKeyboardLayoutChangeRef = useRef(onKeyboardLayoutChange)
  useEffect(() => { onKeyboardLayoutChangeRef.current = onKeyboardLayoutChange }, [onKeyboardLayoutChange])

  // Defensive close (Plan-qwerty-select-no-rewrite §snapshot/.vil 復元時の
  // クリーンアップ, D3): the counter is monotonic for the session (disconnect
  // carries it forward rather than zeroing it, see keyboard-types.ts), so
  // any change here means a new restore landed. Also bump `requestSeqRef`
  // so a pack lookup already in flight from BEFORE the restore (started on
  // a selection, still awaiting `resolveRewriteTable`) fails its own
  // `requestSeqRef.current !== seq` check when it resolves — otherwise it
  // would re-open the modal via `setPendingApply` against the keymap the
  // restore just replaced (restore race).
  //
  // Deliberately does NOT touch `applyInFlightRef`/`isApplying`: if a
  // restore lands while a Confirm apply is still awaiting
  // `onApplyKeymapRewrite` (unusual — the button is disabled — but not
  // impossible via a stray call), this just closes the modal early; the
  // in-flight apply's own `try/finally` in `handleApplyConfirm` is what
  // guarantees the latch clears once it settles, regardless of whether
  // `pendingApply` was already nulled out from under it. That same in-
  // flight apply independently discards its own result against a fresh
  // restore-seq snapshot taken at Confirm time (see `handleApplyConfirm`),
  // so this effect does not need to coordinate with it beyond the modal
  // close.
  //
  // Phase K: also forces `keymapWritten` back to false — the restore just
  // replaced the keymap contents the flag described, so any "these keys
  // were rewritten" coloring based on it is stale. The select VALUE itself
  // is untouched (D4 — restore doesn't change which arrangement is
  // selected), only the written flag resets.
  const keymapRestoreSeqRef = useRef(keymapRestoreSeq)
  useEffect(() => {
    const prev = keymapRestoreSeqRef.current
    keymapRestoreSeqRef.current = keymapRestoreSeq
    if (keymapRestoreSeq === undefined || prev === undefined || keymapRestoreSeq === prev) return
    ++requestSeqRef.current
    setPendingApply(null)
    onKeyboardLayoutChangeRef.current?.(keyboardLayoutRef.current as KeyboardLayoutId, false)
  }, [keymapRestoreSeq])

  const handleKeyboardLayoutChange = useCallback((v: string) => {
    setApplyError(null)
    const seq = ++requestSeqRef.current
    // QWERTY is always inert: it only switches the display, never touches
    // the keymap and never opens the confirm modal, regardless of what's
    // currently applied or what's already pending. It is also never
    // "written" — QWERTY has nothing rewritten onto it.
    if (v === BUILTIN_QWERTY_LAYOUT_ID) {
      setPendingApply(null)
      onKeyboardLayoutChange?.(v as KeyboardLayoutId, false)
      return
    }
    if (!keymapEditable || !onApplyKeymapRewrite) {
      onKeyboardLayoutChange?.(v as KeyboardLayoutId, false)
      return
    }
    // Re-selecting the value already shown in the select is a no-op —
    // display-only, no modal (pattern A2). This is the only guard:
    // `keyboardLayout` is exactly what the select currently renders, so
    // this is the one case where there is genuinely nothing new to do.
    // `keymapWritten` is passed straight back through (not forced false):
    // nothing actually changed, so the persisted written flag must survive
    // this no-op untouched.
    if (v === keyboardLayout) {
      onKeyboardLayoutChange?.(v as KeyboardLayoutId, keymapWritten)
      return
    }
    // Flag + table-build check requires the entry's full payload, which
    // the layout dropdown only has name/id for — fetch (or hit cache)
    // before deciding whether to prompt. Flag-less packs and packs that
    // fail the rewrite-table build fall through to today's direct
    // display-only switch (never written — nothing was rewritten), same as
    // before this feature existed.
    void (async () => {
      const targetTable = await resolveRewriteTable(v, keyLabelLookup)
      if (requestSeqRef.current !== seq) return // superseded by a newer selection
      if (!targetTable) {
        onKeyboardLayoutChange?.(v as KeyboardLayoutId, false)
        return
      }
      setPendingApply({ id: v, name: keyLabelLookup.getName(v) ?? v, table: targetTable })
    })()
  }, [onKeyboardLayoutChange, keymapEditable, keyboardLayout, keymapWritten, onApplyKeymapRewrite, keyLabelLookup])

  // Cancel/Display Only are no-ops while an apply is in flight — the modal
  // disables their buttons (via `isApplying`) as the primary defense, but
  // this ref check is the actual guard: Escape (`useEscapeClose`) and the
  // backdrop click both route through `onCancel` regardless of button
  // `disabled` state, so it must be safe to call at any time.
  const handleApplyCancel = useCallback(() => {
    if (applyInFlightRef.current) return
    setPendingApply(null)
  }, [])

  const handleApplyDisplayOnly = useCallback(() => {
    if (applyInFlightRef.current) return
    if (!pendingApply) return
    // Never written — Display Only touches nothing on the keymap.
    onKeyboardLayoutChange?.(pendingApply.id as KeyboardLayoutId, false)
    setPendingApply(null)
  }, [pendingApply, onKeyboardLayoutChange])

  const handleApplyConfirm = useCallback(() => {
    if (!pendingApply || !onApplyKeymapRewrite) return
    // Re-entrancy guard: a double-clicked Apply (or any other concurrent
    // caller) must never fire a second `onApplyKeymapRewrite` while the
    // first is still in flight — see the ref's own doc comment above.
    if (applyInFlightRef.current) return
    applyInFlightRef.current = true
    setIsApplying(true)
    const { table, id } = pendingApply
    // Restore race (Plan-qwerty-select-no-rewrite Phase K): snapshot the
    // restore counter now. If a snapshot/.vil restore lands while this
    // apply is in flight (replacing the keymap this apply is still writing
    // against), the restore's own cleanup — closing the modal and forcing
    // `keymapWritten` false — must win. Comparing the ref again after the
    // await below is what detects that and discards this call's result
    // entirely, rather than layering a stale (id, true/false) save on top
    // of what the restore just established.
    const restoreSeqAtStart = keymapRestoreSeqRef.current
    void (async () => {
      try {
        const result = await onApplyKeymapRewrite(table)
        const supersededByRestore = keymapRestoreSeqRef.current !== restoreSeqAtStart
        setPendingApply(null)
        if (supersededByRestore) return
        if (result.error) {
          // Partial failure: the keymap is now a MIXED state (some positions
          // rewritten, some not) — it is neither still QWERTY nor fully the
          // target arrangement, so the display selection (and written flag)
          // is deliberately left untouched. The errorPartial message tells
          // the user to restore from a previously saved .vil/snapshot if
          // needed — the rewrite already wiped the undo/redo stacks for
          // whatever DID land (`KeymapEditor.applyKeymapRewrite`'s
          // `history.clear()` fires on ANY landed write, unconditional on
          // `error` — see its own comment).
          setApplyError(result.error)
          return
        }
        // Clean success: Rewrite is a destructive one-shot (Phase K) — the
        // select STAYS on the rewritten arrangement (no QWERTY reset) and
        // `keymapWritten` flips true only when something actually landed
        // (`appliedCount > 0`). A landed-but-empty result (e.g. the
        // re-entrancy guard above, or an already-identity table) has
        // nothing for `keymapWritten`'s coloring to point at, so it is
        // treated as a plain display-only switch instead of falsely
        // claiming the keymap embodies the target arrangement.
        onKeyboardLayoutChange?.(id as KeyboardLayoutId, result.appliedCount > 0)
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
    pendingApply: pendingApply ? { id: pendingApply.id, name: pendingApply.name } : null,
    handleApplyCancel,
    handleApplyDisplayOnly,
    handleApplyConfirm,
    applyError,
    isApplying,
  }
}
