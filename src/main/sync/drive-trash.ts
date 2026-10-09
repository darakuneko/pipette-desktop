// SPDX-License-Identifier: GPL-2.0-or-later
// Trash names for Drive data files that sync stops reading. A copy of a
// name that is not the chosen one (drive-canonical.ts) is renamed to
// `{name}.trash.{renamedAtMs}.{preModifiedMs}.{id}` instead of being
// deleted, so it can be renamed back while no other copy of the name is
// left. The name keeps every fact the later steps need, so nothing about
// a trash file is stored anywhere else:
//   - `renamedAtMs`: when it was renamed; its age counts from this.
//   - `preModifiedMs`: its `modifiedTime` before the rename; the newest of
//     these is the one renamed back.
//   - `id`: its own Drive id, which keeps trash names unique.
// Every sync-unit filename pattern ends in `.enc`, so a trash name maps to
// no sync unit (`syncUnitFromFileName`) and sync passes leave it alone.

import {
  isDataFileName,
  renameFile,
  syncUnitFromFileName,
  type DeleteMatchingFilesResult,
  type DriveFile,
} from './google-drive'
import { pLimit } from '../../shared/concurrency'
import { syncRuntime } from './sync-runtime-state'

/** How long a trash file is kept before it may be deleted. */
export const TRASH_QUARANTINE_MS = 30 * 24 * 60 * 60 * 1000

const TRASH_MARK = '.trash.'
const TRASH_NAME_PATTERN = /^(.+\.enc)\.trash\.(\d+)\.(\d+)\.([A-Za-z0-9_-]+)$/
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]+$/
const RENAME_CONCURRENCY = 5

export interface TrashInfo {
  /** The data file name the copy had before it was renamed. */
  originalName: string
  renamedAtMs: number
  preModifiedMs: number
}

/** The trash name for `file` renamed at `renamedAtMs`; null when its id has
 *  characters the trash name cannot carry, so the name would not parse. */
export function trashFileName(file: Pick<DriveFile, 'id' | 'name' | 'modifiedTime'>, renamedAtMs: number): string | null {
  if (!DRIVE_ID_PATTERN.test(file.id)) return null
  const modified = Date.parse(file.modifiedTime)
  const preModifiedMs = Number.isNaN(modified) || modified < 0 ? 0 : modified
  return `${file.name}${TRASH_MARK}${Math.max(0, Math.floor(renamedAtMs))}.${preModifiedMs}.${file.id}`
}

/** What a trash file's name says about it, or null when `file` is not a
 *  trash file: the name does not have the trash form, the id in it is not
 *  the file's own id, or the original name is not a data file with a sync
 *  unit. */
export function parseTrashFile(file: Pick<DriveFile, 'id' | 'name'>): TrashInfo | null {
  const match = TRASH_NAME_PATTERN.exec(file.name)
  if (!match || match[4] !== file.id) return null
  const originalName = match[1]
  const renamedAtMs = Number(match[2])
  const preModifiedMs = Number(match[3])
  if (!Number.isSafeInteger(renamedAtMs) || !Number.isSafeInteger(preModifiedMs)) return null
  if (!isDataFileName(originalName) || syncUnitFromFileName(originalName) === null) return null
  return { originalName, renamedAtMs, preModifiedMs }
}

/** Whether the trash file has been kept for `TRASH_QUARANTINE_MS`. */
export function isTrashExpired(trash: TrashInfo, nowMs: number): boolean {
  return nowMs - trash.renamedAtMs >= TRASH_QUARANTINE_MS
}

/** Renames each of `files` to its trash name, with bounded concurrency. A
 *  file already gone counts as done; a rejected rename does not stop the
 *  others and is logged. An id this process created a file under
 *  (`createdFileIds`) is forgotten, so a later upload of the name does not
 *  write into the trash file. */
export async function moveFilesToTrash(files: readonly DriveFile[], nowMs: number): Promise<DeleteMatchingFilesResult> {
  const limit = pLimit(RENAME_CONCURRENCY)
  const reasons: string[] = []
  let attempted = 0
  await Promise.all(files.map((file) => limit(async () => {
    const name = trashFileName(file, nowMs)
    if (!name) return
    attempted++
    forgetCreatedFileId(file.id)
    try {
      await renameFile(file.id, name)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`[drive-trash] rename of ${file.id} failed: ${reason}`)
      reasons.push(reason)
    }
  })))
  return { attempted, failed: reasons.length, firstError: reasons[0] }
}

function forgetCreatedFileId(id: string): void {
  for (const [name, createdId] of syncRuntime.createdFileIds) {
    if (createdId === id) syncRuntime.createdFileIds.delete(name)
  }
}
