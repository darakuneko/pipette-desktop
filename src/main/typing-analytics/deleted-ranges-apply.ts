// SPDX-License-Identifier: GPL-2.0-or-later
// This device applying the ranges in its own hash's deleted-ranges file
// (deleted-ranges.ts) to its own typing data: the rows in them are marked
// deleted in its day files (markOwnTypingInRangesOnChain,
// typing-analytics-day-delete.ts), which then sync like any other change.
// The ids already applied are kept in a local record
// (`deletedRangesAppliedPath`) so each range is applied once. A range this
// device wrote for its own Delete All goes into the record once that delete
// has removed every day file.

import { readFile, readdir } from 'node:fs/promises'
import { app } from 'electron'
import { writeFileAtomic } from '../utils/write-file-atomic'
import { log } from '../logger'
import { getMachineHash } from './machine-hash'
import { deletedRangesAppliedPath, keyboardsRoot } from './jsonl/paths'
import { readDeletedRanges } from './deleted-ranges-store'
import { clipToUtcDay, type DeletedRangeEntry } from './deleted-ranges'
import type { UtcDay } from './jsonl/utc-day'
import { markOwnTypingInRangesOnChain } from './typing-analytics-day-delete'
import { runOnFlushChain } from './typing-analytics-pipeline'

/** An unreadable record counts as empty: applying a range again appends
 * nothing (only live rows get marks). */
async function readAppliedIds(path: string): Promise<Set<string>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf-8'))
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeAppliedIds(path: string, ids: ReadonlySet<string>): Promise<void> {
  return writeFileAtomic(path, JSON.stringify([...ids].sort()))
}

/** Applies the entries of `uid` not yet in the record, as one flush-chain
 * task, and adds their ids to the record once that task has run without
 * throwing. Returns without doing anything while `shouldSkip()` is true
 * (checked before queuing and again when the task starts); the sync layer
 * passes "a reset holds this keyboard". The record is written into the
 * existing device directory and never creates it, so a reset that removed
 * the directory leaves it removed. */
export async function applyOwnDeletedRanges(
  uid: string,
  entries: readonly DeletedRangeEntry[],
  shouldSkip: () => boolean,
): Promise<void> {
  if (entries.length === 0 || shouldSkip()) return
  await runOnFlushChain(async () => {
    if (shouldSkip()) return
    const path = deletedRangesAppliedPath(app.getPath('userData'), uid, await getMachineHash())
    const applied = await readAppliedIds(path)
    const pending = entries.filter((entry) => !applied.has(entry.id))
    if (pending.length === 0) return
    await markOwnTypingInRangesOnChain(uid, pending)
    if (shouldSkip()) return
    for (const entry of pending) applied.add(entry.id)
    await writeAppliedIds(path, applied)
  })
}

/** Adds `id` to `uid`'s applied record, as one flush-chain task (the
 * task that applies ranges reads and writes the record on the same
 * chain), for a range whose rows this device has already removed itself.
 * Like the apply, it writes into the existing device directory. */
export async function recordOwnDeletedRangeApplied(uid: string, id: string): Promise<void> {
  await runOnFlushChain(async () => {
    const path = deletedRangesAppliedPath(app.getPath('userData'), uid, await getMachineHash())
    const applied = await readAppliedIds(path)
    applied.add(id)
    await writeAppliedIds(path, applied)
  })
}

/** For an import that replaces the day file `ref`, inside its flush-chain
 * task and before the replace: reads the own-hash deleted-ranges file of
 * `ref.uid` (throws when it cannot be read, so the file is left as it is)
 * and returns the step to run after the replace, which marks again the
 * rows of that day inside every range, applied before or not. So an
 * import cannot bring back typing that was deleted. Another device's file
 * gets a step that does nothing. This includes the range of this device's
 * own Delete All, so an export taken after that delete loses, on import,
 * what was typed after the click within the same minute: minute rows
 * cannot tell before and after the click apart. */
export async function prepareOwnDeletedRangesReapply(
  ref: { uid: string; machineHash: string; utcDay: UtcDay },
): Promise<() => Promise<void>> {
  const ownHash = await getMachineHash()
  if (ref.machineHash !== ownHash) return async () => undefined
  const ranges = clipToUtcDay(await readDeletedRanges(app.getPath('userData'), ref.uid, ownHash), ref.utcDay)
  return async () => {
    if (ranges.length > 0) await markOwnTypingInRangesOnChain(ref.uid, ranges)
  }
}

/** Applies the own-hash deleted-ranges file of every keyboard that has one
 * (a missing file has no entries, so nothing is queued for it), at startup
 * and after each sync pass. A keyboard whose file cannot be read is logged
 * and skipped. */
export async function applyOwnDeletedRangesForAllKeyboards(
  userDataDir: string,
  ownHash: string,
  shouldSkip: (uid: string) => boolean,
): Promise<void> {
  let uids: string[]
  try {
    uids = (await readdir(keyboardsRoot(userDataDir), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return
  }
  for (const uid of uids) {
    try {
      const entries = await readDeletedRanges(userDataDir, uid, ownHash)
      await applyOwnDeletedRanges(uid, entries, () => shouldSkip(uid))
    } catch (err) {
      log('warn', `typing-analytics: deleted ranges of ${uid} not applied: ${String(err)}`)
    }
  }
}
