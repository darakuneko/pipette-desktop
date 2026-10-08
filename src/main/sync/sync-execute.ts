// SPDX-License-Identifier: GPL-2.0-or-later
// Full-pass sync execution: the manual/initial download and upload
// sync passes driven by executeSync (IPC-facing entry point).

import { app } from 'electron'
import { listFiles, syncUnitFromFileName, type DriveFile } from './google-drive'
import { pLimit } from '../../shared/concurrency'
import {
  SYNC_CONCURRENCY,
  POLL_INTERVAL_MS,
  syncRuntime,
  emitProgress,
  errorMessage,
  broadcastPendingStatus,
  tryClaimSyncLock,
  snapshotPendingGenerations,
  settlePending,
} from './sync-runtime-state'
import { scheduleFlushIfPending } from './sync-flush'
import { adoptPendingForSignedInAccount, markPendingFor } from './sync-pending-account'
import { requireSyncCredentials, validatePasswordCheck, ensurePasswordCheckValidated } from './sync-password'
import { localSyncBlock, remoteSyncBlock, emitSyncBlocked } from './sync-password-guard'
import { ensureSyncFormatMarker, syncFormatGeneration } from './sync-format'
import { matchesScope, listLocalKeyboardUids, shouldDownloadSyncUnit } from './sync-scope'
import { mergeWithRemote, syncOrUpload } from './sync-merge-dispatch'
import { settlePackIndexUnitsFirst } from './pack-bundle-merge'
import { canonicalFiles } from './drive-canonical'
import { collectAllSyncUnits } from './sync-bundle'
import { backfillKeyboardMeta } from './keyboard-meta'
import { KEYBOARD_META_SYNC_UNIT } from '../../shared/types/keyboard-meta'
import { runPackGcAfterPass } from './pack-gc'
import { reconcileOwnHashTypingAnalytics } from './sync-typing-remote'
import { getMachineHash } from '../typing-analytics/machine-hash'
import { log } from '../logger'
import type { SyncScope, SyncExecuteStatus, SyncSkipReason, SyncBlockReason } from '../../shared/types/sync'
import { syncCredentialI18nKey } from '../../shared/types/sync'

/** Real outcome of an `executeSync` call. Threaded through SYNC_EXECUTE's
 *  IPC result as `status`/`skipReason` — see `SyncOperationResult`'s doc
 *  in shared/types/sync.ts for why `success` itself is deliberately left
 *  alone. */
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
  let releaseLock = tryClaimSyncLock()
  while (!releaseLock) {
    // A waitable holder (a background poll, a reset) always settles on its
    // own, so waiting for it keeps a connect-time download from being
    // dropped. Any other holder (another executeSync, a flush) skips, which
    // is how parallel callers dedupe.
    const pass = syncRuntime.inFlightPassWaitable ? syncRuntime.inFlightPass : null
    if (!pass) return { status: 'skipped', skipReason: 'busy' }
    await pass
    releaseLock = tryClaimSyncLock()
  }

  const skipBlocked = (reason: SyncBlockReason): SyncExecuteResult => {
    emitSyncBlocked(direction, reason)
    return { status: 'skipped', skipReason: reason }
  }

  try {
    const localBlock = await localSyncBlock()
    if (localBlock) return skipBlocked(localBlock)

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
    // Units changed under another account are held for it; units this pass
    // marks pending belong to the account it runs as.
    const passOwner = await adoptPendingForSignedInAccount()

    emitProgress({ direction, status: 'syncing', message: 'Starting sync...' })

    const formatGeneration = syncFormatGeneration()
    const initialFiles = await listFiles()
    const remoteBlock = remoteSyncBlock(initialFiles, formatGeneration)
    if (remoteBlock) return skipBlocked(remoteBlock)
    await ensureSyncFormatMarker(initialFiles, formatGeneration)

    // Scope 'all' always re-validates; scoped syncs skip it while the
    // password-check is the one last validated (same modifiedTime).
    if (scope === 'all') {
      await validatePasswordCheck(password, initialFiles)
    } else {
      await ensurePasswordCheckValidated(password, initialFiles)
    }

    let failedUnits: string[]
    if (direction === 'download') {
      failedUnits = await executeDownloadSync(password, initialFiles, scope)
      if (scope === 'all') {
        const { resolved } = await backfillKeyboardMeta(password, initialFiles)
        if (resolved > 0) {
          markPendingFor(passOwner, KEYBOARD_META_SYNC_UNIT)
          broadcastPendingStatus()
          scheduleFlushIfPending()
        }
      }
    } else {
      // A pending unit this pass uploads stops being pending unless it
      // changed again during the pass. A failed unit becomes (or stays)
      // pending, and the auto flush retries it after a polling interval.
      const generations = snapshotPendingGenerations()
      const upload = await executeUploadSync(password, initialFiles, scope)
      failedUnits = upload.failedUnits
      for (const unit of upload.succeededUnits) settlePending(unit, generations.get(unit) ?? 0)
      for (const unit of failedUnits) markPendingFor(passOwner, unit)
      broadcastPendingStatus()
      if (failedUnits.length > 0) scheduleFlushIfPending(POLL_INTERVAL_MS)
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
    releaseLock()
  }
}

async function executeDownloadSync(
  password: string,
  prefetchedFiles?: DriveFile[],
  scope: SyncScope = 'all',
): Promise<string[]> {
  const remoteFiles = prefetchedFiles ?? await listFiles()
  const localKeyboardUids = await listLocalKeyboardUids()
  // {file, syncUnit} pairs resolved once here rather than re-parsing the
  // filename again inside the download loop below. One copy per name, so a
  // unit with duplicate files on Drive is merged once.
  const filesToDownload = canonicalFiles(remoteFiles).flatMap((file) => {
    const syncUnit = syncUnitFromFileName(file.name)
    if (!syncUnit || !shouldDownloadSyncUnit(syncUnit, scope, localKeyboardUids)) return []
    return [{ file, syncUnit }]
  })

  const total = filesToDownload.length
  let completed = 0
  const failedUnits: string[] = []
  const limit = pLimit(SYNC_CONCURRENCY)

  // Pack rosters before pack bodies (`settlePackIndexUnitsFirst`).
  await settlePackIndexUnitsFirst(filesToDownload, (f) => f.syncUnit, ({ file: remoteFile, syncUnit }) =>
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
): Promise<{ failedUnits: string[]; succeededUnits: string[] }> {
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
  const total = syncUnits.length
  let completed = 0
  const failedUnits: string[] = []
  const succeededUnits: string[] = []
  const limit = pLimit(SYNC_CONCURRENCY)

  // Pack rosters before pack bodies (`settlePackIndexUnitsFirst`).
  await settlePackIndexUnitsFirst(syncUnits, (u) => u, (syncUnit) =>
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
        succeededUnits.push(syncUnit)
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
  )

  return { failedUnits, succeededUnits }
}
