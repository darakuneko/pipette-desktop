// SPDX-License-Identifier: GPL-2.0-or-later
// 3-minute background polling for remote changes.

import { listFiles, syncUnitFromFileName } from './google-drive'
import { pLimit } from '../../shared/concurrency'
import { MalformedSyncBundleError } from './merge'
import { isAnalyticsSyncUnit, isRunLogSyncUnit } from './sync-bundle'
import { runPackGcAfterPass } from './pack-gc'
import { log } from '../logger'
import { SYNC_CONCURRENCY, POLL_INTERVAL_MS, syncRuntime, recordRemoteState, emitProgress } from './sync-runtime-state'
import { requireSyncCredentials, ensurePasswordCheckValidated } from './sync-password'
import { localSyncBlock, remoteSyncBlock, emitSyncBlocked } from './sync-password-guard'
import { ensureSyncFormatMarker, syncFormatGeneration } from './sync-format'
import type { SyncBlockReason } from '../../shared/types/sync'
import { listLocalKeyboardUids, shouldDownloadSyncUnit } from './sync-scope'
import { mergeWithRemote } from './sync-merge-dispatch'

let pollTimer: ReturnType<typeof setInterval> | null = null
// The pass the interval started and that has not settled yet. The tick guard
// in startPolling only skips a call that would return at
// pollForRemoteChanges's lock check anyway.
let inFlightPoll: Promise<void> | null = null

async function pollForRemoteChanges(): Promise<void> {
  if (syncRuntime.isSyncing) return
  syncRuntime.isSyncing = true

  try {
    const localBlock = await localSyncBlock()
    if (localBlock) {
      reportBlockedPoll(localBlock)
      return
    }

    const credentials = await requireSyncCredentials()
    if (!credentials.ok) return  // polling stays silent — manual sync surfaces the reason
    const password = credentials.password

    const formatGeneration = syncFormatGeneration()
    const remoteFiles = await listFiles()
    const remoteBlock = remoteSyncBlock(remoteFiles, formatGeneration)
    if (remoteBlock) {
      reportBlockedPoll(remoteBlock)
      return
    }
    // Merges may upload, so the marker comes first, even on the first poll.
    await ensureSyncFormatMarker(remoteFiles, formatGeneration)

    await ensurePasswordCheckValidated(password, remoteFiles)

    // The first poll of a launch has no recorded state, so every listed file
    // counts as changed: each locally relevant unit is downloaded once.
    const localKeyboardUids = await listLocalKeyboardUids()
    // {file, syncUnit} pairs resolved once here rather than re-parsing
    // the filename again inside the merge loop below.
    const changedFiles = remoteFiles.flatMap((file) => {
      if (syncRuntime.lastKnownRemoteState.get(file.name) === file.modifiedTime) return []
      const syncUnit = syncUnitFromFileName(file.name)
      if (!syncUnit) return []
      // analytics: handled by executeAnalyticsSync (Analyze panel mount).
      if (isAnalyticsSyncUnit(syncUnit)) return []
      // run logs: no dedicated on-demand sync entry point yet (see
      // isRunLogSyncUnit's doc comment) — before-quit flush and manual
      // sync still cover it, 3-minute polling does not.
      if (isRunLogSyncUnit(syncUnit)) return []
      if (!shouldDownloadSyncUnit(syncUnit, 'all', localKeyboardUids)) return []
      return [{ file, syncUnit }]
    })

    // Record the files evaluated and left alone on purpose (unchanged, lazily
    // skipped, analytics/run-log units, names with no sync unit). A changed
    // file is recorded by mergeWithRemote only when its merge succeeds.
    const changedNames = new Set(changedFiles.map(({ file }) => file.name))
    recordRemoteState(remoteFiles.filter((file) => !changedNames.has(file.name)))

    const limit = pLimit(SYNC_CONCURRENCY)
    const failedUnits: string[] = []
    await Promise.allSettled(
      changedFiles.map(({ file: remoteFile, syncUnit }) =>
        limit(async () => {
          try {
            await mergeWithRemote(remoteFile, syncUnit, password, remoteFiles)
            emitProgress({
              direction: 'download',
              status: 'success',
              syncUnit,
              message: 'Sync complete',
            })
          } catch (err) {
            failedUnits.push(syncUnit)
            if (err instanceof MalformedSyncBundleError) {
              // A malformed bundle's exact revision is recorded so the next
              // poll does not retry it every 3 minutes; a new revision has a
              // different modifiedTime and is retried. Manual syncs have no
              // such memory and may retry it. Unit name only, never bundle
              // content: the project's no-payload-in-logs rule for
              // attacker-reachable remote data.
              recordRemoteState([remoteFile])
              log('warn', `sync: ${err.message}`)
            }
          }
        }),
      ),
    )

    // Pass-level GC — see pack-gc.ts's doc for why this must never be
    // triggered from inside a single unit's own merge callback above, and
    // for why `failedUnits` is passed separately (skips that store's
    // sweep only, not the whole GC call).
    await runPackGcAfterPass(changedFiles.map((f) => f.syncUnit), failedUnits)
  } catch {
    // Polling failed — will retry next interval
  } finally {
    syncRuntime.isSyncing = false
  }
}

/** Unlike a credential problem, a sync guard block (a password change in
 *  progress, or Drive needing a newer app) is shown: it is the only sign on
 *  this machine that syncing has stopped. */
function reportBlockedPoll(reason: SyncBlockReason): void {
  emitSyncBlocked('download', reason)
}

export function startPolling(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    // A tick while the tracked pass is still running is skipped: that pass
    // holds `syncRuntime.isSyncing`, so a second call would return at its
    // lock check without doing anything. pollForRemoteChanges catches its
    // own errors, so the tracked promise never rejects.
    if (inFlightPoll) return
    const pass = pollForRemoteChanges().finally(() => {
      // Only clear our own entry — a reset may have dropped it already.
      if (inFlightPoll === pass) inFlightPoll = null
    })
    inFlightPoll = pass
  }, POLL_INTERVAL_MS)
}

export function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/** The poll pass the interval started and that has not settled yet.
 * executeSync waits on it instead of skipping as busy; tests await the exact
 * pass. */
export function inFlightPollPass(): Promise<void> | null {
  return inFlightPoll
}

/** Test-only: resolves when the poll pass the interval started has
 * settled (immediately when none is running). */
export function waitForPollPassForTests(): Promise<void> {
  return inFlightPollPass() ?? Promise.resolve()
}

/** Test-only reset for the tracked pass — called by the sync-service
 * facade's `_resetForTests`. It does not stop a running pass. */
export function clearInFlightPollForTests(): void {
  inFlightPoll = null
}
