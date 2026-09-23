// SPDX-License-Identifier: GPL-2.0-or-later
// 3-minute background polling for remote changes.

import { listFiles, syncUnitFromFileName } from './google-drive'
import { pLimit } from '../../shared/concurrency'
import { MalformedSyncBundleError } from './merge'
import { isAnalyticsSyncUnit, isRunLogSyncUnit } from './sync-bundle'
import { runPackGcAfterPass } from './pack-gc'
import { log } from '../logger'
import { SYNC_CONCURRENCY, POLL_INTERVAL_MS, syncRuntime, updateRemoteState, emitProgress } from './sync-runtime-state'
import { requireSyncCredentials, validatePasswordCheck } from './sync-password'
import { listLocalKeyboardUids, shouldDownloadSyncUnit } from './sync-scope'
import { mergeWithRemote } from './sync-merge-dispatch'

let pollTimer: ReturnType<typeof setInterval> | null = null
// The pass the interval started and that has not settled yet, kept so
// tests can await the exact pass. Production behavior does not depend on
// it: the tick guard in startPolling only skips a call that would return
// at pollForRemoteChanges's lock check anyway.
let inFlightPoll: Promise<void> | null = null

async function pollForRemoteChanges(): Promise<void> {
  if (syncRuntime.isSyncing) return
  syncRuntime.isSyncing = true

  try {
    const credentials = await requireSyncCredentials()
    if (!credentials.ok) return  // polling stays silent — manual sync surfaces the reason
    const password = credentials.password

    const remoteFiles = await listFiles()

    if (!syncRuntime.passwordCheckValidated) {
      await validatePasswordCheck(password, remoteFiles)
    }

    // First poll: just validate password and record remote state
    // Avoids downloading all files on startup
    if (syncRuntime.lastKnownRemoteState.size === 0) {
      updateRemoteState(remoteFiles)
      return
    }

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

    updateRemoteState(remoteFiles)

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
              // Contained per-unit, same as any other poll failure — but
              // deliberately do NOT forget the modifiedTime below: this
              // poll already recorded it into lastKnownRemoteState above
              // (before this loop ran), so leaving it in place makes the
              // NEXT poll see this exact revision as unchanged and skip
              // retrying it forever. A later fix (a new modifiedTime) is
              // a different key and is retried normally. Manual syncs
              // (executeDownloadSync/executeUploadSync) have no such
              // memory and may retry a malformed unit on every attempt —
              // deliberate, since those are visible, user-initiated
              // actions, not a silent background loop. Unit name only —
              // never bundle content — per the project's
              // no-payload-in-logs rule for attacker-reachable remote data.
              log('warn', `sync: ${err.message}`)
              return
            }
            // Forget the modifiedTime so the next poll re-detects this file as changed
            // and gets another chance to merge it.
            syncRuntime.lastKnownRemoteState.delete(remoteFile.name)
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

/** Test-only: resolves when the poll pass the interval started has
 * settled (immediately when none is running). */
export function waitForPollPassForTests(): Promise<void> {
  return inFlightPoll ?? Promise.resolve()
}

/** Test-only reset for the tracked pass — called by the sync-service
 * facade's `_resetForTests`. It does not stop a running pass. */
export function clearInFlightPollForTests(): void {
  inFlightPoll = null
}
