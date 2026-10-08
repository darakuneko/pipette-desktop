// SPDX-License-Identifier: GPL-2.0-or-later
// Write-side helpers for the entry stores: reading an index's entries as
// v2 entries and building the clocks of a created / overwritten entry, on
// top of the clock writers in `entry-clocks.ts`. Every helper returns a
// new object whose `updatedAt` is `derivedUpdatedAt` of its clocks.

import {
  type BaseEntryMeta,
  type ClockedEntry,
  type EntryGroup,
  type EntryStore,
  type MetaGroup,
  type StoreMetaMap,
  EPOCH_ISO,
  META_GROUPS,
  STORE_GROUPS,
  canonicalJson,
  derivedUpdatedAt,
  groupValues,
  newClocks,
  markDeleted,
  normalizeEntry,
  reviveEntry,
  touchClock,
} from './entry-clocks'

/** The entries of an index read from disk, as v2 entries. Anything that is
 *  not an object with a string `id` is dropped. Nothing is written back
 *  here: the next write of the index stores the normalized form. */
export function normalizeEntries<S extends EntryStore>(store: S, entries: unknown): ClockedEntry<StoreMetaMap[S]>[] {
  if (!Array.isArray(entries)) return []
  const out: ClockedEntry<StoreMetaMap[S]>[] = []
  for (const e of entries) {
    if (e === null || typeof e !== 'object' || typeof (e as { id?: unknown }).id !== 'string') continue
    out.push(normalizeEntry(store, e as StoreMetaMap[S]))
  }
  return out
}

/** `fields` as a brand-new entry: every group the store has starts at
 *  `now`. Any `deletedAt` in `fields` is dropped. */
export function createEntry<T extends BaseEntryMeta>(store: EntryStore, fields: T, now: Date): ClockedEntry<T> {
  const clocks = newClocks(store, now)
  const out = { ...fields, clocks, updatedAt: derivedUpdatedAt(clocks, undefined) }
  delete out.deletedAt
  return out
}

/** A built-in entry (QWERTY key label, English pack): every clock, and
 *  `updatedAt`, is the epoch, so every device creates the identical entry
 *  and none of them wins over a user change. */
export function builtinEntry<T extends BaseEntryMeta>(store: EntryStore, fields: T): ClockedEntry<T> {
  const out = createEntry(store, fields, new Date(0))
  out.updatedAt = EPOCH_ISO
  return out
}

export interface OverwriteOptions {
  /** The body file was written. */
  body: boolean
  /** The user asked for this write (a Hub download, an import over an
   *  entry of the same name, an UPDATE). It brings a tombstoned entry
   *  back and raises `created` on a live one, so it also wins over a
   *  delete made on another device that this one has not seen yet. An
   *  unattended write (the Hub startup auto-update) passes false: it
   *  never revives anything. */
  explicit: boolean
}

/** `next` written over `existing` (same id), or created when `existing` is
 *  undefined. Groups move as follows:
 *  - a revival (`existing` deleted, `explicit`): `created` and every other
 *    group the store has move to `now`, so no older value of the deleted
 *    entry wins over what was just written.
 *  - otherwise: `created` moves when `explicit`, `body` when
 *    `options.body`, and a meta group (name / hub / enabled) only when its
 *    values differ from `existing`'s, so a save that keeps the name leaves
 *    the name clock alone.
 *  Throws for a non-explicit write over a deleted entry: callers refuse
 *  those before writing anything. */
export function overwriteEntry<T extends BaseEntryMeta>(
  store: EntryStore,
  existing: ClockedEntry<T> | undefined,
  next: T,
  now: Date,
  options: OverwriteOptions,
): ClockedEntry<T> {
  if (!existing) return createEntry(store, next, now)
  const def = STORE_GROUPS[store]
  const base = { ...next, clocks: existing.clocks, updatedAt: existing.updatedAt } as ClockedEntry<T>
  if (existing.deletedAt !== undefined) {
    if (!options.explicit) throw new Error('An unattended write cannot bring back a deleted entry')
    base.deletedAt = existing.deletedAt
    let out = reviveEntry(base, now)
    out = touchClock(out, 'body', now)
    for (const g of META_GROUPS) if (def[g]) out = touchClock(out, g, now)
    return out
  }
  delete base.deletedAt
  const groups: EntryGroup[] = []
  if (options.explicit) groups.push('created')
  if (options.body) groups.push('body')
  for (const g of META_GROUPS) {
    if (!def[g]) continue
    if (canonicalJson(groupValues(def, existing, g)) !== canonicalJson(groupValues(def, next, g))) groups.push(g)
  }
  return touchGroups(base, groups, now)
}

/** Moves every clock in `groups` (see `touchClock`). */
function touchGroups<T extends BaseEntryMeta>(entry: ClockedEntry<T>, groups: readonly EntryGroup[], now: Date): ClockedEntry<T> {
  let out = { ...entry, updatedAt: derivedUpdatedAt(entry.clocks, entry.deletedAt) }
  for (const g of groups) out = touchClock(out, g, now)
  return out
}

/** A meta-only change of the entry `id` in `entries` (in place): `mutate`
 *  edits a copy, then `group`'s clock moves (`touchClock`), or the entry is
 *  tombstoned for `'delete'` (`markDeleted`). Returns the new entry, or
 *  undefined when `entries` has no `id`. */
export function applyEntryMutation<T extends BaseEntryMeta>(
  entries: ClockedEntry<T>[],
  id: string,
  group: MetaGroup | 'delete',
  now: Date,
  mutate: (entry: ClockedEntry<T>) => void = () => {},
): ClockedEntry<T> | undefined {
  const at = entries.findIndex((e) => e.id === id)
  if (at < 0) return undefined
  const entry = { ...entries[at] }
  mutate(entry)
  entries[at] = group === 'delete' ? markDeleted(entry, now) : touchClock(entry, group, now)
  return entries[at]
}
