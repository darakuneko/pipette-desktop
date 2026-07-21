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

/**
 * Batch variant of `computeSortedInsertOrder` for a multi-file import:
 * positions every entry in `newEntries` into its sorted slot among
 * `existingEntries` AND each other, in one pure pass over the two input
 * arrays. This is deliberately NOT "call `computeSortedInsertOrder` once
 * per new entry, feeding each result back into `existingEntries`" done by
 * the *caller* across separate async steps — see `placeMany` in
 * `useImportPlacement.ts` for why a real caller can't safely do that
 * (the "existing" list a later step would read may not yet reflect an
 * earlier step's insert, or may already reflect it from an unrelated
 * background refresh, either of which corrupts the merge). Here the
 * fold happens synchronously across `newEntries` with no I/O and no
 * React state in between, so it can't observe anything but its own
 * arguments.
 *
 * `newEntries` must not overlap `existingEntries`' ids (same "genuinely
 * new, not overwrite" contract as `computeSortedInsertOrder`) and must
 * not contain duplicate ids itself — callers dedupe a batch's results
 * before calling this. Returns `null` when `direction` is 'free' or
 * there is nothing to insert.
 */
export function computeSortedInsertOrderMany(
  existingEntries: NameSortEntry[],
  newEntries: NameSortEntry[],
  direction: SortDirection,
): string[] | null {
  if (direction === 'free' || newEntries.length === 0) return null
  let current: NameSortEntry[] = existingEntries
  for (const entry of newEntries) {
    // `direction` is never 'free' here, so `computeSortedInsertOrder`
    // always returns a real list — the fallback only exists to satisfy
    // the compiler's `string[] | null` return type.
    const ids = computeSortedInsertOrder(current, entry, direction) ?? [...current.map((e) => e.id), entry.id]
    const byId = new Map(current.map((e) => [e.id, e] as const))
    byId.set(entry.id, entry)
    current = ids.map((id) => byId.get(id) as NameSortEntry)
  }
  return current.map((e) => e.id)
}
