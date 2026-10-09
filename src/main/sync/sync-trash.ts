// SPDX-License-Identifier: GPL-2.0-or-later
// Automatic tidying of Drive names with several copies, run by the poll pass
// on its own listing. Only file metadata changes (renames and deletes of
// trash files); no content is downloaded or merged. Per name:
//   - two or more copies: every copy except the chosen one
//     (drive-canonical.ts) is renamed to a trash name (drive-trash.ts);
//   - at least one copy: trash files renamed `TRASH_QUARANTINE_MS` or more
//     ago are deleted, so the last copy of a name is never deleted. Drive
//     is listed again by name right before the delete, so a trash file
//     another machine renamed back since the pass's listing is kept;
//   - no copy but trash: the trash file with the newest content
//     (`preModifiedMs`) is renamed back to the name.
// Two machines tidying at once converge: a copy each renamed away leaves
// only trash, which the next pass renames back.

import { deleteFilesById, isDataFileName, listFiles, renameFile, syncUnitFromFileName, type DriveFile } from './google-drive'
import { isTrashExpired, moveFilesToTrash } from './drive-trash'
import { duplicatedNames, filesNamed, isNewerCopy, namesWithTrash, pickCanonicalFile, trashCopiesOf, type TrashCopy } from './drive-canonical'
import { shouldDownloadSyncUnit } from './sync-scope'
import { syncRuntime } from './sync-runtime-state'
import { parseTypingAnalyticsDeviceDaySyncUnit } from '../typing-analytics/sync'
import { isSafePathSegment } from '../utils/safe-filename'
import { log } from '../logger'

/** Names tidied per pass, so a Drive with many duplicates is worked through
 *  over several passes instead of holding the sync lock for long. */
export const TRASH_NAMES_PER_PASS = 5

export interface TrashTidyContext {
  /** Keyboards with local data; other keyboards' files are left alone, as
   *  the poll's merge leaves them (`shouldDownloadSyncUnit`). */
  localKeyboardUids: Set<string>
  ownHash: string
  nowMs: number
}

type NameScope = { kind: 'skip' } | { kind: 'tidy'; ownDay: boolean }

/** Whether `name` is one of this machine's own typing days. Such a day is
 *  never renamed back from trash, automatically or from the Trash screen:
 *  a day this machine deleted must stay deleted, and one it still has
 *  locally is uploaded again by the next sync anyway. */
export function isOwnTypingDayName(name: string, ownHash: string): boolean {
  const unit = syncUnitFromFileName(name)
  const day = unit ? parseTypingAnalyticsDeviceDaySyncUnit(unit) : null
  return day !== null && day.machineHash === ownHash
}

/** Whether this machine tidies `name`. Another machine's typing days are
 *  only tidied by that machine, and this machine's own days are never
 *  renamed back (`isOwnTypingDayName`). */
function nameScope(name: string, ctx: TrashTidyContext): NameScope {
  const unit = isDataFileName(name) ? syncUnitFromFileName(name) : null
  if (!unit || unit.split('/').some((part) => !isSafePathSegment(part))) return { kind: 'skip' }
  if (!shouldDownloadSyncUnit(unit, 'all', ctx.localKeyboardUids)) return { kind: 'skip' }
  const day = parseTypingAnalyticsDeviceDaySyncUnit(unit)
  if (!day) return { kind: 'tidy', ownDay: false }
  // An analytics sync of the keyboard uploads its days with its own listing.
  if (day.machineHash !== ctx.ownHash || syncRuntime.analyticsSyncingUids.has(day.uid)) return { kind: 'skip' }
  return { kind: 'tidy', ownDay: true }
}

/** The trash file with the newest content (`isNewerCopy` on `preModifiedMs`). */
function newestTrash(trash: readonly TrashCopy[]): TrashCopy {
  return trash.reduce((best, copy) =>
    isNewerCopy(copy.trash.preModifiedMs, copy.file.id, best.trash.preModifiedMs, best.file.id) ? copy : best)
}

/** Those of `ids` that a fresh listing of `name` still shows as expired
 *  trash of it while a current copy of it exists. */
async function stillExpiredTrash(name: string, ids: readonly string[], nowMs: number): Promise<string[]> {
  const fresh = await listFiles({ nameContains: name })
  if (filesNamed(fresh, name).length === 0) return []
  const wanted = new Set(ids)
  return trashCopiesOf(fresh, name)
    .filter((copy) => wanted.has(copy.file.id) && isTrashExpired(copy.trash, nowMs))
    .map((copy) => copy.file.id)
}

/** Tidies one name; resolves whether anything was changed or attempted. */
async function tidyName(remoteFiles: readonly DriveFile[], name: string, ownDay: boolean, nowMs: number): Promise<boolean> {
  const live = filesNamed(remoteFiles, name)
  const trash = trashCopiesOf(remoteFiles, name)
  let acted = false

  if (live.length > 1) {
    const chosen = pickCanonicalFile(remoteFiles, name)
    const result = await moveFilesToTrash(live.filter((file) => file !== chosen), nowMs)
    if (result.failed > 0) log('warn', `sync: moving duplicate copies to trash failed: ${result.firstError}`)
    acted = true
  }

  if (live.length > 0) {
    const expired = trash.filter((copy) => isTrashExpired(copy.trash, nowMs)).map((copy) => copy.file.id)
    if (expired.length > 0) {
      try {
        const result = await deleteFilesById(await stillExpiredTrash(name, expired, nowMs))
        if (result.failed > 0) log('warn', `sync: deleting expired trash failed: ${result.firstError}`)
      } catch (err) {
        log('warn', `sync: listing before deleting expired trash failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      acted = true
    }
  } else if (trash.length > 0 && !ownDay) {
    const restore = newestTrash(trash)
    try {
      await renameFile(restore.file.id, name)
    } catch (err) {
      log('warn', `sync: renaming trash back failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    acted = true
  }
  return acted
}

/** Tidies up to `TRASH_NAMES_PER_PASS` names of `remoteFiles` and stops early
 *  when the app starts quitting. A failed rename or delete is logged and
 *  the next pass tries again; nothing here throws. */
export async function tidyDuplicateCopies(remoteFiles: readonly DriveFile[], ctx: TrashTidyContext): Promise<void> {
  const names = new Set([...duplicatedNames(remoteFiles), ...namesWithTrash(remoteFiles)])
  let tidied = 0
  for (const name of names) {
    if (tidied >= TRASH_NAMES_PER_PASS || syncRuntime.isQuitting) return
    const scope = nameScope(name, ctx)
    if (scope.kind === 'skip') continue
    if (await tidyName(remoteFiles, name, scope.ownDay, ctx.nowMs)) tidied++
  }
}
