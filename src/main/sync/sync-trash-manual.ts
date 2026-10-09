// SPDX-License-Identifier: GPL-2.0-or-later
// What the Data > Sync > Trash screen does with Drive trash files
// (drive-trash.ts): list them, rename one back to its original name, or
// delete some. Restore and delete run under the sync lock (the callers in
// sync-reset-ipc.ts), and each lists Drive again first, so a file the poll
// renamed back (sync-trash.ts) after the screen loaded is not acted on.

import { deleteFilesById, listFiles, renameFile, syncUnitFromFileName, type DriveFile } from './google-drive'
import { TRASH_QUARANTINE_MS, moveFilesToTrash, parseTrashFile, type TrashInfo } from './drive-trash'
import { filesNamed } from './drive-canonical'
import { isOwnTypingDayName } from './sync-trash'
import { assertNoLocalPasswordChange, assertSyncAllowed } from './sync-password-guard'
import { requireSyncCredentials, SyncCredentialError } from './sync-password'
import { syncFormatGeneration } from './sync-format'
import { resetHoldsKeyboard } from './sync-runtime-state'
import { TRASH_BUSY_MESSAGE } from './sync-reset-lock'
import { getMachineHash } from '../typing-analytics/machine-hash'
import { log } from '../logger'
import type { SyncTrashFile } from '../../shared/types/sync'

export const TRASH_NOT_FOUND_MESSAGE = 'sync.trash.notFound'
export const TRASH_NOT_RESTORABLE_MESSAGE = 'sync.trash.notRestorable'

/** One full listing, after the credentials and the sync guards pass.
 *  Throws `SyncCredentialError` (a `sync.readiness.*` key) when signed out
 *  or without a sync password, and `SyncBlockedError` while a sync password
 *  change is in progress or Drive needs a newer app. */
async function listAllowedFiles(): Promise<DriveFile[]> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) throw new SyncCredentialError(credentials.reason, 'readiness')
  await assertNoLocalPasswordChange()
  const generation = syncFormatGeneration()
  const listing = await listFiles()
  await assertSyncAllowed(listing, generation)
  return listing
}

/** The keyboard whose data the trash file holds; null for a unit that is
 *  not tied to one keyboard. */
function trashKeyboard(trash: TrashInfo): string | null {
  const unit = syncUnitFromFileName(trash.originalName)
  if (!unit?.startsWith('keyboards/')) return null
  return unit.split('/')[1] || null
}

/** Every trash file on Drive, the most recently moved first. Names only:
 *  nothing is downloaded. */
export async function listTrashFiles(): Promise<SyncTrashFile[]> {
  const listing = await listAllowedFiles()
  const ownHash = await getMachineHash()
  const rows = listing.flatMap((file): SyncTrashFile[] => {
    const trash = parseTrashFile(file)
    if (!trash) return []
    return [{
      fileId: file.id,
      originalName: trash.originalName,
      syncUnit: syncUnitFromFileName(trash.originalName),
      updatedAt: trash.preModifiedMs,
      expiresAt: trash.renamedAtMs + TRASH_QUARANTINE_MS,
      restorable: !isOwnTypingDayName(trash.originalName, ownHash),
    }]
  })
  return rows.sort((a, b) => b.expiresAt - a.expiresAt)
}

/** The keyboards whose data `fileIds` hold, for the reset lock the caller
 *  takes before restoring or deleting them: it refuses while an analytics
 *  sync or a remote day fetch of those keyboards runs. Ids that are not
 *  trash files add nothing; the action itself lists again and skips them. */
export async function trashFileKeyboards(fileIds: readonly string[]): Promise<string[]> {
  const wanted = new Set(fileIds)
  const uids = new Set<string>()
  for (const file of await listAllowedFiles()) {
    const trash = wanted.has(file.id) ? parseTrashFile(file) : null
    const uid = trash ? trashKeyboard(trash) : null
    if (uid) uids.add(uid)
  }
  return [...uids]
}

/** Whether the reset lock the caller holds covers the trash file's keyboard. */
function lockCovers(trash: TrashInfo): boolean {
  const uid = trashKeyboard(trash)
  return uid === null || resetHoldsKeyboard(uid)
}

/** Swaps `fileId` in for the current copies of its original name: every
 *  current copy is moved to trash first, then `fileId` is renamed back.
 *  Throws `TRASH_NOT_FOUND_MESSAGE` when `fileId` is not a trash file any
 *  more, and `TRASH_NOT_RESTORABLE_MESSAGE` for one of this machine's own
 *  typing days (`isOwnTypingDayName`). When the rename back fails, the
 *  moved copies are renamed back to the name; what that cannot undo is left
 *  to the poll, which renames the trash file with the newest content back
 *  when a name has no copy. */
export async function restoreTrashFile(fileId: string): Promise<void> {
  const listing = await listAllowedFiles()
  const file = listing.find((f) => f.id === fileId)
  const trash = file ? parseTrashFile(file) : null
  if (!trash) throw new Error(TRASH_NOT_FOUND_MESSAGE)
  if (isOwnTypingDayName(trash.originalName, await getMachineHash())) throw new Error(TRASH_NOT_RESTORABLE_MESSAGE)
  if (!lockCovers(trash)) throw new Error(TRASH_BUSY_MESSAGE)
  const current = filesNamed(listing, trash.originalName)
  const moved = await moveFilesToTrash(current, Date.now())
  if (moved.failed > 0) {
    await renameBack(current, trash.originalName)
    throw new Error(`Failed to move ${moved.failed} of ${moved.attempted} files to trash: ${moved.firstError}`)
  }
  let restored: DriveFile | null
  try {
    restored = await renameFile(fileId, trash.originalName)
  } catch (err) {
    await renameBack(current, trash.originalName)
    throw err
  }
  if (!restored) {
    await renameBack(current, trash.originalName)
    throw new Error(TRASH_NOT_FOUND_MESSAGE)
  }
}

/** Renames `files` back to `name` after a restore stopped halfway. A
 *  failure is logged, not thrown: the restore's own error is the one the
 *  user sees. */
async function renameBack(files: readonly DriveFile[], name: string): Promise<void> {
  for (const file of files) {
    try {
      await renameFile(file.id, name)
    } catch (err) {
      log('warn', `sync: undoing a trash restore failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** Deletes those of `fileIds` that are still trash files of data the
 *  caller's lock covers; the others are returned as skipped. */
export async function deleteTrashFiles(fileIds: readonly string[]): Promise<{ deleted: string[]; skipped: string[] }> {
  const listing = await listAllowedFiles()
  const deletable = new Set(listing.flatMap((file) => {
    const trash = parseTrashFile(file)
    return trash && lockCovers(trash) ? [file.id] : []
  }))
  const deleted = fileIds.filter((id) => deletable.has(id))
  const skipped = fileIds.filter((id) => !deletable.has(id))
  const result = await deleteFilesById(deleted)
  if (result.failed > 0) throw new Error(`Failed to delete ${result.failed} of ${result.attempted} files: ${result.firstError}`)
  return { deleted, skipped }
}
