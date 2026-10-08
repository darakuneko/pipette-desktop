// SPDX-License-Identifier: GPL-2.0-or-later
// Body files of the index-based entry stores: the move to names that carry
// the entry id (`idBodyFilename`, `entry-clocks.ts`), so no two ids ever
// share a body file, and the removal of body files no entry names.
//
// The move runs under the store's write lock, on every locked read of the
// index; once every name carries its id it does nothing. Files are copied,
// not renamed: one legacy file can be named by several entries, and each
// of them gets its own copy. A legacy file is deleted only after the index
// naming the new files is written and no entry (tombstones included) names
// it any more. Body clocks do not move — the content is the same.

import { join } from 'node:path'
import { copyFile, readdir, readFile, unlink } from 'node:fs/promises'
import { type BaseEntryMeta, type ClockedEntry, type EntryStore, type StoreMetaMap, STORE_GROUPS, bodyFilenameHasId, idBodyFilename } from './entry-clocks'
import { normalizeEntries } from './entry-write'
import { isEnoent } from '../utils/is-enoent'
import { isSafePathSegment } from '../utils/safe-filename'
import { writeFileAtomic } from '../utils/write-file-atomic'

/** Renames every entry of `entries` (in place) whose body filename lacks
 *  its id, copying the file under `dir` when it exists, then calls
 *  `persist` to write the index and deletes the legacy files nothing
 *  names any more. Returns whether any entry changed (`persist` is not
 *  called otherwise). A copy failure other than a missing source throws
 *  before the index is written; the copies already made are overwritten
 *  by the next attempt. */
export async function migrateBodyFilenames(
  store: EntryStore,
  dir: string,
  entries: BaseEntryMeta[],
  persist: () => Promise<void>,
): Promise<boolean> {
  const moves: { entry: BaseEntryMeta; from: string; to: string }[] = []
  for (const entry of entries) {
    if (typeof entry.filename !== 'string' || !isSafePathSegment(entry.filename)) continue
    if (bodyFilenameHasId(store, entry.id, entry.filename)) continue
    const to = idBodyFilename(store, entry.id, entry.filename)
    if (!isSafePathSegment(to)) continue
    moves.push({ entry, from: entry.filename, to })
  }
  if (moves.length === 0) return false

  for (const move of moves) {
    try {
      await copyFile(join(dir, move.from), join(dir, move.to))
    } catch (err) {
      // No legacy file (a tombstone whose body is gone): only the name changes.
      if (!isEnoent(err)) throw err
    }
  }
  for (const move of moves) move.entry.filename = move.to
  await persist()

  const named = new Set(entries.map((e) => e.filename))
  for (const from of new Set(moves.map((m) => m.from))) {
    if (named.has(from)) continue
    try {
      await unlink(join(dir, from))
    } catch {
      // best-effort: an unnamed leftover file is never read
    }
  }
  return true
}

/** A store's locked read of its index: `read`, then the body filename move
 *  with `write` as the persist step. */
export async function readIndexMigrated<I extends { entries: BaseEntryMeta[] }>(
  store: EntryStore,
  dir: string,
  read: () => Promise<I>,
  write: (index: I) => Promise<void>,
): Promise<I> {
  const index = await read()
  await migrateBodyFilenames(store, dir, index.entries, () => write(index))
  return index
}

/** `{dir}/index.json` as the sync merge and Local Data import see it:
 *  missing, present but unreadable or without an `entries` array, or read
 *  (entries as v2 entries, body filenames moved). */
export type IndexDirRead<S extends EntryStore> =
  | { state: 'missing' }
  | { state: 'corrupt' }
  | { state: 'ok'; index: Record<string, unknown>; entries: ClockedEntry<StoreMetaMap[S]>[] }

/** Reads `{dir}/index.json` for a caller that holds the store's lock and
 *  moves its body filenames; the index is written back (normalized) only
 *  when a name changed. */
export async function readIndexDirMigrated<S extends EntryStore>(store: S, dir: string): Promise<IndexDirRead<S>> {
  let raw: string
  try {
    raw = await readFile(join(dir, 'index.json'), 'utf-8')
  } catch (err) {
    return isEnoent(err) ? { state: 'missing' } : { state: 'corrupt' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: 'corrupt' }
  }
  // Valid JSON without an `entries` array is not an empty index: reading it
  // as one would let the merge overwrite it and remove the bodies it names.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'corrupt' }
  const index = parsed as Record<string, unknown>
  if (!Array.isArray(index.entries)) return { state: 'corrupt' }
  const entries = normalizeEntries(store, index.entries)
  await migrateBodyFilenames(store, dir, entries, () =>
    writeFileAtomic(join(dir, 'index.json'), JSON.stringify({ ...index, entries }, null, 2)),
  )
  return { state: 'ok', index, entries }
}

/** Whether `name` is shaped like one of `store`'s id-carrying body files:
 *  a safe single segment with the body extension and a `_` (every
 *  id-carrying name has one). `index.json`, temp files of an atomic write
 *  and anything else are never body files. */
export function isBodyFileName(store: EntryStore, name: string): boolean {
  return name !== 'index.json' && name.endsWith(STORE_GROUPS[store].bodyExt) && name.includes('_') && isSafePathSegment(name)
}

/** Unlinks the body files under `dir` that no entry names. Returns how
 *  many were removed; failures are skipped. */
export async function unlinkUnreferencedBodyFiles(store: EntryStore, dir: string, referenced: ReadonlySet<string>): Promise<number> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (referenced.has(name) || !isBodyFileName(store, name)) continue
    try {
      await unlink(join(dir, name))
      removed++
    } catch {
      // best-effort
    }
  }
  return removed
}
