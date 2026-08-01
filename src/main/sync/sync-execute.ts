// SPDX-License-Identifier: GPL-2.0-or-later
// Full-pass sync execution: the manual/initial download and upload
// sync passes driven by executeSync (IPC-facing entry point). Split
// out of sync-service.ts (Task-split-sync-service) — see
// .claude/rules/file-splitting.md.

import { app } from 'electron'
import { listFiles, syncUnitFromFileName, type DriveFile } from './google-drive'
import { pLimit } from '../../shared/concurrency'
import { SYNC_CONCURRENCY, syncRuntime, emitProgress, errorMessage, updateRemoteState, broadcastPendingStatus } from './sync-runtime-state'
import { requireSyncCredentials, validatePasswordCheck } from './sync-password'
import { matchesScope, listLocalKeyboardUids, shouldDownloadSyncUnit } from './sync-scope'
import { mergeWithRemote, syncOrUpload } from './sync-merge-dispatch'
import { collectAllSyncUnits } from './sync-bundle'
import { backfillKeyboardMeta } from './keyboard-meta'
import { KEYBOARD_META_SYNC_UNIT } from '../../shared/types/keyboard-meta'
import { runPackGcAfterPass } from './pack-gc'
import { reconcileOwnHashTypingAnalytics } from './sync-typing-remote'
import { getMachineHash } from '../typing-analytics/machine-hash'
import { log } from '../logger'
import type { SyncScope, SyncExecuteStatus, SyncSkipReason } from '../../shared/types/sync'
import { syncCredentialI18nKey } from '../../shared/types/sync'

/** Real outcome of an `executeSync` call — distinct from the `void`
 *  return the caller used to get, which made a busy-race skip and a
 *  missing-credentials skip both look identical to a fully-completed
 *  sync (neither throws; both just emit progress and return). Threaded
 *  through SYNC_EXECUTE's IPC result as `status`/`skipReason` — see
 *  `SyncOperationResult`'s doc in shared/types/sync.ts for why `success`
 *  itself is deliberately left alone. */
export interface SyncExecuteResult {
  status: SyncExecuteStatus
  /** Populated only when `status === 'skipped'`. */
  skipReason?: SyncSkipReason
  /** Populated only when `status === 'partial'`. */
  failedUnits?: string[]
}

export async function executeSync(
  direction: 'download' | 'upload',
  scope: SyncScope = 'all',
): Promise<SyncExecuteResult> {
  if (syncRuntime.isSyncing) return { status: 'skipped', skipReason: 'busy' }
  syncRuntime.isSyncing = true

  try {
    const credentials = await requireSyncCredentials()
    if (!credentials.ok) {
      emitProgress({
        direction,
        status: 'error',
        reason: credentials.reason,
        message: syncCredentialI18nKey('readiness', credentials.reason),
      })
      return { status: 'skipped', skipReason: credentials.reason }
    }
    const password = credentials.password

    emitProgress({ direction, status: 'syncing', message: 'Starting sync...' })

    const initialFiles = await listFiles()

    // Force password re-validation on scope 'all' (changePassword, listUndecryptable)
    // Scoped syncs (including manual sync) respect the cached validation;
    // decryption errors during actual file processing serve as implicit validation
    if (scope === 'all' || !syncRuntime.passwordCheckValidated) {
      await validatePasswordCheck(password, initialFiles)
    }

    let failedUnits: string[]
    if (direction === 'download') {
      failedUnits = await executeDownloadSync(password, initialFiles, scope)
      if (scope === 'all') {
        const { resolved } = await backfillKeyboardMeta(password, initialFiles)
        if (resolved > 0) {
          syncRuntime.pendingChanges.add(KEYBOARD_META_SYNC_UNIT)
          broadcastPendingStatus()
        }
      }
    } else {
      failedUnits = await executeUploadSync(password, initialFiles, scope)
      // Clear pending changes matching the scope, then re-add failed units
      for (const unit of syncRuntime.pendingChanges) {
        if (matchesScope(unit, scope)) syncRuntime.pendingChanges.delete(unit)
      }
      for (const unit of failedUnits) {
        syncRuntime.pendingChanges.add(unit)
      }
      broadcastPendingStatus()
    }

    if (failedUnits.length === 0) {
      emitProgress({ direction, status: 'success', message: 'Sync complete' })
      return { status: 'completed' }
    } else {
      emitProgress({
        direction,
        status: 'partial',
        message: `${failedUnits.length} sync unit(s) failed`,
        failedUnits,
      })
      return { status: 'partial', failedUnits }
    }
  } catch (err) {
    emitProgress({
      direction,
      status: 'error',
      message: errorMessage(err, 'Sync failed'),
    })
    throw err
  } finally {
    syncRuntime.isSyncing = false
  }
}

async function executeDownloadSync(
  password: string,
  prefetchedFiles?: DriveFile[],
  scope: SyncScope = 'all',
): Promise<string[]> {
  const remoteFiles = prefetchedFiles ?? await listFiles()
  updateRemoteState(remoteFiles) // Always record full remote state for polling

  const localKeyboardUids = await listLocalKeyboardUids()
  // {file, syncUnit} pairs resolved once here rather than re-parsing the
  // filename again inside the download loop below.
  const filesToDownload = remoteFiles.flatMap((file) => {
    const syncUnit = syncUnitFromFileName(file.name)
    if (!syncUnit || !shouldDownloadSyncUnit(syncUnit, scope, localKeyboardUids)) return []
    return [{ file, syncUnit }]
  })

  const total = filesToDownload.length
  let completed = 0
  const failedUnits: string[] = []
  const limit = pLimit(SYNC_CONCURRENCY)

  await Promise.allSettled(
    filesToDownload.map(({ file: remoteFile, syncUnit }) =>
      limit(async () => {
        completed++

        emitProgress({
          direction: 'download',
          status: 'syncing',
          syncUnit,
          current: completed,
          total,
        })

        try {
          await mergeWithRemote(remoteFile, syncUnit, password, remoteFiles)
        } catch (err) {
          failedUnits.push(syncUnit)
          emitProgress({
            direction: 'download',
            status: 'error',
            syncUnit,
            message: errorMessage(err, 'Download failed'),
          })
        }
      }),
    ),
  )

  // Pass-level GC — see pack-gc.ts's doc for why this must never be
  // triggered from inside a single unit's own merge callback above, and
  // for why `failedUnits` is passed separately from the full attempted
  // list (a failed unit skips that store's sweep, not the whole GC call).
  await runPackGcAfterPass(filesToDownload.map((f) => f.syncUnit), failedUnits)

  return failedUnits
}

async function executeUploadSync(
  password: string,
  prefetchedFiles?: DriveFile[],
  scope: SyncScope = 'all',
): Promise<string[]> {
  const remoteFilesInitial = prefetchedFiles ?? await listFiles()
  // Run own-hash typing-analytics reconcile before collecting units so
  // deleted cloud days don't get re-uploaded and vice-versa. The
  // reconcile only deletes when it detects a divergence; when nothing
  // changed we reuse the initial snapshot to keep the N+1 invariant.
  let mutatedDuringReconcile = false
  try {
    const ownHash = await getMachineHash()
    const result = await reconcileOwnHashTypingAnalytics(
      remoteFilesInitial,
      app.getPath('userData'),
      ownHash,
    )
    mutatedDuringReconcile = result.mutated
  } catch (err) {
    log('warn', `typing-analytics reconcile failed: ${String(err)}`)
  }
  let syncUnits = await collectAllSyncUnits()
  if (scope !== 'all') {
    syncUnits = syncUnits.filter((unit) => matchesScope(unit, scope))
  }
  const remoteFiles = mutatedDuringReconcile ? await listFiles() : remoteFilesInitial
  updateRemoteState(remoteFiles)
  const total = syncUnits.length
  let completed = 0
  const failedUnits: string[] = []
  const limit = pLimit(SYNC_CONCURRENCY)

  await Promise.allSettled(
    syncUnits.map((syncUnit) =>
      limit(async () => {
        completed++
        emitProgress({
          direction: 'upload',
          status: 'syncing',
          syncUnit,
          current: completed,
          total,
        })

        try {
          await syncOrUpload(syncUnit, password, remoteFiles)
        } catch (err) {
          failedUnits.push(syncUnit)
          emitProgress({
            direction: 'upload',
            status: 'error',
            syncUnit,
            message: errorMessage(err, 'Upload failed'),
          })
        }
      }),
    ),
  )

  // Refresh remote state once after all uploads to prevent polling re-downloads
  const updatedFiles = await listFiles()
  updateRemoteState(updatedFiles)

  return failedUnits
}
