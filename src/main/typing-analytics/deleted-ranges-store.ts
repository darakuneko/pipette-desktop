// SPDX-License-Identifier: GPL-2.0-or-later
// Reads and writes the deleted-ranges file of one (keyboard uid,
// machineHash) (deleted-ranges.ts). Every read-modify-write and every read
// for a sync bundle runs under the lock keyed by the file's sync-unit name,
// which is the key `storeLockKey` (sync-bundle.ts) returns for that unit.
// `withWriteLock` is not reentrant, so nothing here may be called from a
// task that already holds that lock.

import { mkdir, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { withWriteLock } from '../per-uid-write-lock'
import { writeFileAtomic } from '../utils/write-file-atomic'
import { isEnoent } from '../utils/is-enoent'
import { log } from '../logger'
import { deletedRangesPath } from './jsonl/paths'
import { typingDeletedRangesSyncUnit } from './sync'
import {
  parseDeletedRangesFile,
  serializeDeletedRanges,
  type DeletedRangeEntry,
  type DeletedRangesUnion,
} from './deleted-ranges'

function parseRaw(raw: string, path: string): DeletedRangeEntry[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`deleted-ranges: unreadable file ${path}`)
  }
  const entries = parseDeletedRangesFile(value)
  if (entries === null) throw new Error(`deleted-ranges: unreadable file ${path}`)
  return entries
}

async function readEntries(path: string): Promise<DeletedRangeEntry[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if (isEnoent(err)) return []
    throw err
  }
  return parseRaw(raw, path)
}

/** The valid entries; none for a missing file. Throws when the file
 * exists but cannot be read or parsed. */
export function readDeletedRanges(userDataDir: string, uid: string, machineHash: string): Promise<DeletedRangeEntry[]> {
  return readEntries(deletedRangesPath(userDataDir, uid, machineHash))
}

/** Synchronous read for a caller that must read the ranges and use them in
 * the same synchronous step (a cache replay). An unreadable file counts as
 * no entries, logged, so one bad file does not stop the replay. */
export function readDeletedRangesSync(userDataDir: string, uid: string, machineHash: string): DeletedRangeEntry[] {
  const path = deletedRangesPath(userDataDir, uid, machineHash)
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    if (!isEnoent(err)) log('warn', `deleted-ranges: cannot read ${path}: ${String(err)}`)
    return []
  }
  try {
    return parseRaw(raw, path)
  } catch (err) {
    log('warn', String(err))
    return []
  }
}

/** Under the file's lock: reads the local entries, passes them to
 * `combine` and writes the result when `localChanged`. An unreadable local
 * file throws before `combine` runs and is left as it is. */
export function updateDeletedRanges(
  userDataDir: string,
  uid: string,
  machineHash: string,
  combine: (local: DeletedRangeEntry[]) => DeletedRangesUnion,
): Promise<DeletedRangesUnion> {
  const path = deletedRangesPath(userDataDir, uid, machineHash)
  return withWriteLock(typingDeletedRangesSyncUnit(uid, machineHash), async () => {
    const result = combine(await readEntries(path))
    if (result.localChanged) {
      await mkdir(dirname(path), { recursive: true })
      await writeFileAtomic(path, serializeDeletedRanges(result.entries))
    }
    return result
  })
}

/** Under the file's lock: the file content to upload, rebuilt from its valid
 * entries. Null when the file is missing or unreadable. */
export function bundleDeletedRanges(userDataDir: string, uid: string, machineHash: string): Promise<string | null> {
  const path = deletedRangesPath(userDataDir, uid, machineHash)
  return withWriteLock(typingDeletedRangesSyncUnit(uid, machineHash), async () => {
    try {
      return serializeDeletedRanges(parseRaw(await readFile(path, 'utf-8'), path))
    } catch (err) {
      if (!isEnoent(err)) log('warn', `deleted-ranges: not bundled: ${String(err)}`)
      return null
    }
  })
}
