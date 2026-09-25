// SPDX-License-Identifier: GPL-2.0-or-later
//
// Pure helpers for the key picker's tab order (`PipetteSettings.keycodeTabOrder`).
// The saved value is the "full order": every tab id the saving client knew,
// including tabs the current keyboard hides and ids from a newer client.
// The tab bar shows a projection of it onto the tabs that are visible now.

import { KEYCODE_CATEGORIES } from './categories'

/** Id of the "Keyboard" tab `TabbedKeycodes` adds after the categories. */
export const KEYBOARD_TAB_ID = 'keyboard'

export function defaultTabOrder(): string[] {
  return [...KEYCODE_CATEGORIES.map((c) => c.id), KEYBOARD_TAB_ID]
}

/** The saved order with repeats removed, followed by every default id it
 *  lacks (in default order). Unknown ids stay where they are. */
export function resolveFullOrder(saved: readonly string[] | undefined): string[] {
  const ids = new Set(saved ?? [])
  for (const id of defaultTabOrder()) ids.add(id)
  return [...ids]
}

/** Sorts `visibleIds` by their place in `full`. Ids `full` does not hold
 *  (the LM modifier tab) keep their relative order after the others. */
export function projectVisible(visibleIds: readonly string[], full: readonly string[]): string[] {
  const rank = new Map(full.map((id, i) => [id, i]))
  return visibleIds
    .map((id, i) => ({ id, rank: rank.get(id) ?? full.length + i }))
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.id)
}

/** Moves `fromId` to `toIndex` within the visible projection and writes the
 *  result back into `full`: the slots of `full` that hold visible ids are
 *  refilled in the new visible order, so hidden and unknown ids keep their
 *  slots. Returns `full` unchanged (as a copy) for a no-op move. */
export function moveVisible(
  full: readonly string[],
  visible: readonly string[],
  fromId: string,
  toIndex: number,
): string[] {
  const fromIndex = visible.indexOf(fromId)
  if (fromIndex < 0 || fromIndex === toIndex || toIndex < 0 || toIndex >= visible.length) return full.slice()
  if (!full.includes(fromId)) return full.slice()
  const next = visible.slice()
  next.splice(fromIndex, 1)
  next.splice(toIndex, 0, fromId)
  const fullSet = new Set(full)
  const queue = next.filter((id) => fullSet.has(id))
  const visibleSet = new Set(queue)
  let q = 0
  return full.map((id) => (visibleSet.has(id) ? queue[q++] : id))
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}
