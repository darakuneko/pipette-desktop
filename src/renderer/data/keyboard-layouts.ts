// SPDX-License-Identifier: GPL-2.0-or-later
// Built-in keyboard layout list. Now contains only QWERTY; other
// language layouts are loaded on demand from the Key Label store
// (`sync/key-labels/`) and downloaded from Pipette Hub via the Key
// Labels modal in Settings → Tools.

import type { LayoutComparisonInputLayout } from '../../shared/types/typing-analytics'

export interface KeyboardLayoutDef {
  id: string
  name: string
  map: Record<string, string>
  /**
   * Optional override for composite keycodes such as `LALT(KC_L)` → "Cmd L".
   *
   * Looked up before `map` in `remapLabel` (see `useKeyboardLayout.ts`).
   * Lets contributors attach OS × language specific labels to individual
   * composite qmkIds without disturbing basic-key remap behavior.
   *
   * Pipette ships no defaults here — contributor PRs add layout-specific
   * entries. Reviewers must check that the same label is not assigned to
   * different composite qmkIds within one layout (label collision).
   */
  compositeLabels?: Record<string, string>
}

export type KeyboardLayoutId = string

/** Canonical id of the built-in QWERTY entry — the identity arrangement
 *  every Key Label rewrite table is expressed relative to. Reference this
 *  instead of a bare `'qwerty'` string literal so callers never have to
 *  string-match the (localizable) display name to detect "no relabeling".
 *  Defined independently of `KEYBOARD_LAYOUTS`' entry order (below) so
 *  reordering that list can never silently repoint the identity baseline. */
export const BUILTIN_QWERTY_LAYOUT_ID: KeyboardLayoutId = 'qwerty'

/**
 * Built-in QWERTY entry. The display name is shown in the layout
 * dropdown; the empty `map` lets `remapLabel` fall through to the
 * default qmkId-derived label.
 */
export const KEYBOARD_LAYOUTS: KeyboardLayoutDef[] = [
  { id: BUILTIN_QWERTY_LAYOUT_ID, name: 'QWERTY', map: {} },
]

/** Pre-built index for O(1) layout lookup by id */
export const LAYOUT_BY_ID = new Map(KEYBOARD_LAYOUTS.map((l) => [l.id, l]))

/** Set for O(1) membership checks on layout IDs */
export const LAYOUT_ID_SET: ReadonlySet<string> = new Set(KEYBOARD_LAYOUTS.map((l) => l.id))

/** Project the {id, map} subset Layout Comparison / Layout Comparison
 * IPC payloads carry. Returns `null` when the id is unknown so the
 * caller can short-circuit a malformed request before crossing IPC.
 *
 * After the Key Labels migration, only `qwerty` is built in. Custom
 * layouts loaded from the Key Label store can be projected by callers
 * that already hold the entry (see `useKeyLabels`). */
export function pickLayoutComparisonInput(id: string): LayoutComparisonInputLayout | null {
  const def = LAYOUT_BY_ID.get(id)
  if (!def) return null
  return { id: def.id, map: def.map }
}
