// SPDX-License-Identifier: GPL-2.0-or-later
//
// Where a freshly-imported / Hub-downloaded entry should land in the
// persisted order, matching the Name sort button's current state.
//
// Callers determine "new vs. overwrite" themselves (an id already
// present in the pre-operation entries list is an overwrite — the
// store reused the existing entry's id and position; only a truly new
// id needs placing) and only call this for the "new" case.

import type { SortDirection, NameSortEntry } from './useNameSort'
import { compareNames } from './useNameSort'

/**
 * Returns the full ordered id list to persist via `reorder`, with
 * `newEntry` spliced into its sorted position among `existingEntries`
 * (which must NOT already include it — this is only for genuinely new
 * entries, not overwrites). Returns `null` when no reorder call is
 * needed: `direction` is 'free', so today's append-at-bottom behavior
 * (the store appends new entries to the end on its own) is exactly
 * right and there is nothing to persist here.
 */
export function computeSortedInsertOrder(
  existingEntries: NameSortEntry[],
  newEntry: NameSortEntry,
  direction: SortDirection,
): string[] | null {
  if (direction === 'free') return null
  const sign = direction === 'asc' ? 1 : -1
  const ids = existingEntries.map((entry) => entry.id)
  let insertAt = ids.length
  for (let i = 0; i < existingEntries.length; i++) {
    if (sign * compareNames(newEntry.name, existingEntries[i].name) < 0) {
      insertAt = i
      break
    }
  }
  ids.splice(insertAt, 0, newEntry.id)
  return ids
}
