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
// picked, never force-reset. There is no compose/inverse machinery — a
// Rewrite always applies the target's own table directly against
// whatever the keymap currently holds (the user is warned to save first;
// a mis-timed rewrite is a single Undo away, see the plan's one-revert
// history section). QWERTY is always inert: selecting it only switches
// the display, never touches the keymap or opens a modal, regardless of
// what is currently applied.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useKeyLabelLookup } from './useKeyLabelLookup'
import { buildKeymapRewriteTable, type KeymapRewriteTable, type KeymapRewriteLayoutIds } from '../../shared/keymap/keymap-apply'
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
  /** `PipetteSettings.appliedKeymapLayout` — id of the arrangement last
   *  actually rewritten into the device keymap (or the built-in QWERTY id).
   *  Absent is treated as identity/QWERTY, matching the field's own
   *  "never applied" convention. No longer used to guard or compose a
   *  rewrite table (the table is always the target's own) — its only
   *  remaining role here is undo/redo bookkeeping, recorded as `before`
   *  on the applied batch at Confirm time. */
  appliedKeymapLayout?: string
  onKeyboardLayoutChange?: (layout: KeyboardLayoutId) => void
  /** Bulk-rewrite the live keymap via `KeymapEditorHandle.applyKeymapRewrite`. */
  onApplyKeymapRewrite?: (table: KeymapRewriteTable, layoutIds: KeymapRewriteLayoutIds) => Promise<KeymapApplyResult>
  /** `KeyboardState.keymapRestoreSeq` — bumped by `applyVilFile` on every
   *  successful snapshot/layout-store restore or `.vil` import
   *  (Plan-qwerty-select-no-rewrite §snapshot/.vil 復元時のクリーンアップ).
   *  An increase closes an open confirm modal defensively: the restore
   *  just replaced the whole keymap this modal's pending Apply/Display Only
   *  would otherwise act against. */
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
  appliedKeymapLayout,
  onKeyboardLayoutChange,
  onApplyKeymapRewrite,
  keymapRestoreSeq,
}: UseKeymapApplyPromptOptions): UseKeymapApplyPromptReturn {
  const keyLabelLookup = useKeyLabelLookup()
  const [pendingApply, setPendingApply] = useState<{ id: string; name: string; table: KeymapRewriteTable } | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)

  // Defensive close (Plan-qwerty-select-no-rewrite §snapshot/.vil 復元時の
  // クリーンアップ, D3): only an actual INCREASE means a new restore landed —
  // guards against a stray decrease (e.g. disconnect resetting the counter
  // back to 0 on a fresh KeyboardState) being mistaken for one.
  const keymapRestoreSeqRef = useRef(keymapRestoreSeq)
  useEffect(() => {
    const prev = keymapRestoreSeqRef.current
    keymapRestoreSeqRef.current = keymapRestoreSeq
    if (keymapRestoreSeq === undefined || prev === undefined || keymapRestoreSeq <= prev) return
    setPendingApply(null)
  }, [keymapRestoreSeq])

  // Bumped on every invocation; the async lookups below re-check it after
  // each `await` so a newer selection always wins over a slower older one
  // (selection race — two quick picks where the first's lookups resolve
  // after the second's must never let the first overwrite the second's
  // prompt or fire a stale display-only switch). The QWERTY early return
  // also relies on this bump: it invalidates any in-flight lookup from a
  // prior (non-QWERTY) selection so a slower lookup can never open a
  // modal after the user has already moved on to QWERTY.
  const requestSeqRef = useRef(0)

  const handleKeyboardLayoutChange = useCallback((v: string) => {
    setApplyError(null)
    ++requestSeqRef.current
    const seq = requestSeqRef.current
    // QWERTY is always inert: it only switches the display, never touches
    // the keymap and never opens the confirm modal, regardless of what's
    // currently applied or what's already pending.
    if (v === BUILTIN_QWERTY_LAYOUT_ID) {
      setPendingApply(null)
      onKeyboardLayoutChange?.(v as KeyboardLayoutId)
      return
    }
    if (!keymapEditable || !onApplyKeymapRewrite) {
      onKeyboardLayoutChange?.(v as KeyboardLayoutId)
      return
    }
    // Re-selecting the value already shown in the select is a no-op —
    // display-only, no modal (pattern A2). This is the only guard: unlike
    // `appliedKeymapLayout`, `keyboardLayout` is exactly what the select
    // currently renders, so this is the one case where there is genuinely
    // nothing new to do.
    if (v === keyboardLayout) {
      onKeyboardLayoutChange?.(v as KeyboardLayoutId)
      return
    }
    // Flag + table-build check requires the entry's full payload, which
    // the layout dropdown only has name/id for — fetch (or hit cache)
    // before deciding whether to prompt. Flag-less packs and packs that
    // fail the rewrite-table build fall through to today's direct
    // display-only switch, same as before this feature existed.
    void (async () => {
      const targetTable = await resolveRewriteTable(v, keyLabelLookup)
      if (requestSeqRef.current !== seq) return // superseded by a newer selection
      if (!targetTable) {
        onKeyboardLayoutChange?.(v as KeyboardLayoutId)
        return
      }
      setPendingApply({ id: v, name: keyLabelLookup.getName(v) ?? v, table: targetTable })
    })()
  }, [onKeyboardLayoutChange, keymapEditable, keyboardLayout, onApplyKeymapRewrite, keyLabelLookup])

  const handleApplyCancel = useCallback(() => setPendingApply(null), [])

  const handleApplyDisplayOnly = useCallback(() => {
    if (!pendingApply) return
    onKeyboardLayoutChange?.(pendingApply.id as KeyboardLayoutId)
    setPendingApply(null)
  }, [pendingApply, onKeyboardLayoutChange])

  const handleApplyConfirm = useCallback(() => {
    if (!pendingApply || !onApplyKeymapRewrite) return
    const { id, table } = pendingApply
    // `before` is read at CONFIRM time (not captured at selection time):
    // with a direct target table there is no composed base to keep in
    // sync with, so the freshest `appliedKeymapLayout` is simply the most
    // accurate bookkeeping value to record for undo/redo.
    const before = appliedKeymapLayout ?? BUILTIN_QWERTY_LAYOUT_ID
    void (async () => {
      const result = await onApplyKeymapRewrite(table, { before, after: id })
      setPendingApply(null)
      if (result.error) {
        // Partial failure: the keymap is now a MIXED state (some positions
        // rewritten, some not) — it is neither still `before` nor fully
        // `after`, so the display selection is deliberately left untouched
        // (KeymapEditor.applyKeymapRewrite likewise skips the
        // appliedKeymapLayout bookkeeping for this batch). The errorPartial
        // message already tells the user Undo reverts what was applied.
        setApplyError(result.error)
        return
      }
      // The applied layout stays selected — no forced reset to QWERTY.
      // The footer's legend rendering (not this hook) is responsible for
      // showing the plain/undecorated legend once the select matches the
      // arrangement actually burned into the keymap.
      onKeyboardLayoutChange?.(id as KeyboardLayoutId)
    })()
  }, [pendingApply, appliedKeymapLayout, onApplyKeymapRewrite, onKeyboardLayoutChange])

  return {
    handleKeyboardLayoutChange,
    pendingApply: pendingApply ? { id: pendingApply.id, name: pendingApply.name } : null,
    handleApplyCancel,
    handleApplyDisplayOnly,
    handleApplyConfirm,
    applyError,
  }
}
