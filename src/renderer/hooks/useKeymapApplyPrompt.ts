// SPDX-License-Identifier: GPL-2.0-or-later
//
// Owns the "does this Key Label pack want a keymap rewrite?" decision for
// the footer's Keyboard Layout select (Plan-key-label-keymap-apply Phase 3,
// generalized by the 追加要求 2026-07-18 section): fetches the target's
// (and, when needed, the currently-applied arrangement's) full payload,
// checks `keymapApplicable`, and validates each with
// `buildKeymapRewriteTable` before deciding whether to prompt with
// KeymapApplyConfirmModal or fall through to today's direct display-only
// switch. Extracted out of QuickSettingsSelects so the footer component only
// owns rendering, not this validation/orchestration.
//
// The keymap is not assumed to still be raw QWERTY: the prompt composes the
// currently-applied arrangement's table with the target's
// (`composeRewriteTables`) so a switch away from a previously-rewritten
// keymap (including back to QWERTY itself) produces the correct incremental
// rewrite instead of re-applying the target table against stale keycodes.

import { useCallback, useRef, useState } from 'react'
import { useKeyLabelLookup } from './useKeyLabelLookup'
import { buildKeymapRewriteTable, composeRewriteTables, type KeymapRewriteTable, type KeymapRewriteLayoutIds } from '../../shared/keymap/keymap-apply'
import { BUILTIN_QWERTY_LAYOUT_ID } from '../data/keyboard-layouts'
import type { KeyboardLayoutId } from './useKeyboardLayout'
import type { KeymapApplyResult } from '../components/editors/keymap-editor-types'

export interface UseKeymapApplyPromptOptions {
  /** True when the connected device has a loaded keymap to rewrite. Without
   *  it, a flagged pack always falls back to today's display-only switch. */
  keymapEditable: boolean
  /** `PipetteSettings.appliedKeymapLayout` — id of the arrangement last
   *  actually rewritten into the device keymap (or the built-in QWERTY id).
   *  Absent is treated as identity/QWERTY, matching the field's own
   *  "never applied" convention. Independent of `keyboardLayout`
   *  (the display-only selection), which never updates this. */
  appliedKeymapLayout?: string
  onKeyboardLayoutChange?: (layout: KeyboardLayoutId) => void
  /** Bulk-rewrite the live keymap via `KeymapEditorHandle.applyKeymapRewrite`. */
  onApplyKeymapRewrite?: (table: KeymapRewriteTable, layoutIds: KeymapRewriteLayoutIds) => Promise<KeymapApplyResult>
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

/** Resolve `id`'s rewrite table: identity (empty map) for the built-in
 *  QWERTY entry, otherwise the entry's own table when it's flagged
 *  `keymapApplicable` and its map actually builds. Returns `null` when
 *  `id` isn't rewrite-eligible at all (flag-less pack, failed build, or a
 *  pack that's missing/not yet loaded locally). */
async function resolveRewriteTable(
  id: string,
  keyLabelLookup: ReturnType<typeof useKeyLabelLookup>,
): Promise<KeymapRewriteTable | null> {
  if (id === BUILTIN_QWERTY_LAYOUT_ID) return new Map()
  await keyLabelLookup.ensure(id)
  const map = keyLabelLookup.getMap(id)
  if (!map || !keyLabelLookup.getKeymapApplicable(id)) return null
  const result = buildKeymapRewriteTable(map)
  return result.ok ? result.table : null
}

export function useKeymapApplyPrompt({
  keymapEditable,
  appliedKeymapLayout,
  onKeyboardLayoutChange,
  onApplyKeymapRewrite,
}: UseKeymapApplyPromptOptions): UseKeymapApplyPromptReturn {
  const keyLabelLookup = useKeyLabelLookup()
  // `before` is captured at SELECTION time (the appliedId the composed
  // `table` was actually built from) and carried inside pendingApply so
  // Confirm always uses the base it composed against — not whatever
  // `appliedKeymapLayout` happens to be when the user clicks Apply. Without
  // this, appliedKeymapLayout changing while the modal is open (e.g. an
  // undo/redo of an unrelated rewrite batch) would record a mismatched
  // {before, after} pair on the new batch.
  const [pendingApply, setPendingApply] = useState<{ id: string; name: string; table: KeymapRewriteTable; before: string } | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  // Bumped on every invocation; the async lookups below re-check it after
  // each `await` so a newer selection always wins over a slower older one
  // (selection race — two quick picks where the first's lookups resolve
  // after the second's must never let the first overwrite the second's
  // prompt or fire a stale display-only switch).
  const requestSeqRef = useRef(0)

  const handleKeyboardLayoutChange = useCallback((v: string) => {
    setApplyError(null)
    const seq = ++requestSeqRef.current
    if (!keymapEditable || !onApplyKeymapRewrite) {
      onKeyboardLayoutChange?.(v as KeyboardLayoutId)
      return
    }
    const appliedId = appliedKeymapLayout ?? BUILTIN_QWERTY_LAYOUT_ID
    // Re-selecting the arrangement that's already burned into the keymap
    // has nothing left to rewrite (composing a table with itself is always
    // empty) — switch display only. This is also the documented case where
    // choosing that same pack's display label re-introduces the
    // double-translated look, since the keymap already holds its keycodes.
    if (appliedId === v) {
      onKeyboardLayoutChange?.(v as KeyboardLayoutId)
      return
    }
    // Flag + table-build check requires each entry's full payload, which
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
      const appliedTable = await resolveRewriteTable(appliedId, keyLabelLookup)
      if (requestSeqRef.current !== seq) return // superseded by a newer selection
      if (!appliedTable) {
        // The pack actually burned into the keymap is no longer installed
        // (or no longer builds — e.g. re-imported without the flag) —
        // composing from it would be a guess about the keymap's real
        // state, so fall back to a plain display-only switch instead.
        console.warn(`useKeymapApplyPrompt: applied layout "${appliedId}" is no longer rewrite-eligible, skipping the composed rewrite prompt`)
        onKeyboardLayoutChange?.(v as KeyboardLayoutId)
        return
      }
      const composed = composeRewriteTables(appliedTable, targetTable)
      if (composed.size === 0) {
        onKeyboardLayoutChange?.(v as KeyboardLayoutId)
        return
      }
      setPendingApply({ id: v, name: keyLabelLookup.getName(v) ?? v, table: composed, before: appliedId })
    })()
  }, [onKeyboardLayoutChange, keymapEditable, onApplyKeymapRewrite, keyLabelLookup, appliedKeymapLayout])

  const handleApplyCancel = useCallback(() => setPendingApply(null), [])

  const handleApplyDisplayOnly = useCallback(() => {
    if (!pendingApply) return
    onKeyboardLayoutChange?.(pendingApply.id as KeyboardLayoutId)
    setPendingApply(null)
  }, [pendingApply, onKeyboardLayoutChange])

  const handleApplyConfirm = useCallback(() => {
    if (!pendingApply || !onApplyKeymapRewrite) return
    const { id, table, before } = pendingApply
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
      // Display double-remap fix (2026-07-18 real-hardware finding): the
      // keymap now physically holds the target arrangement's keycodes, so
      // the display must stay on QWERTY labels — switching display to the
      // target would re-translate already-rewritten keycodes through its
      // own label map, looking "double applied" for a genuinely correct
      // single rewrite. Display Only (handleApplyDisplayOnly above) is
      // unaffected and still switches to the target as before.
      onKeyboardLayoutChange?.(BUILTIN_QWERTY_LAYOUT_ID as KeyboardLayoutId)
    })()
  }, [pendingApply, onApplyKeymapRewrite, onKeyboardLayoutChange])

  return {
    handleKeyboardLayoutChange,
    pendingApply: pendingApply ? { id: pendingApply.id, name: pendingApply.name } : null,
    handleApplyCancel,
    handleApplyDisplayOnly,
    handleApplyConfirm,
    applyError,
  }
}
