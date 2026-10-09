// SPDX-License-Identifier: GPL-2.0-or-later
// 3-minute background polling for remote changes.

import { listFiles, syncUnitFromFileName } from './google-drive'
import { pLimit } from '../../shared/concurrency'
import { MalformedSyncBundleError } from './merge'
import { isAnalyticsSyncUnit, isRunLogSyncUnit } from './sync-bundle'
import { runPackGcAfterPass } from './pack-gc'
import { log } from '../logger'
import { loadAppConfig } from '../app-config'
import { SYNC_CONCURRENCY, POLL_INTERVAL_MS, syncRuntime, recordRemoteState, isKnownRemoteRevision, emitProgress, tryClaimSyncLock } from './sync-runtime-state'
import { requireSyncCredentials, ensurePasswordCheckValidated } from './sync-password'
import { localSyncBlock, remoteSyncBlock, emitSyncBlocked } from './sync-password-guard'
import { ensureSyncFormatMarker, syncFormatGeneration } from './sync-format'
import type { SyncBlockReason } from '../../shared/types/sync'
import { listLocalKeyboardUids, shouldDownloadSyncUnit } from './sync-scope'
import { mergeWithRemote } from './sync-merge-dispatch'
import { settlePackIndexUnitsFirst } from './pack-bundle-merge'
import { canonicalFiles } from './drive-canonical'
import { queueOwnDeletedRangesApply } from './typing-deleted-ranges-merge'

let pollTimer: ReturnType<typeof setInterval> | null = null
// The delayed first pass's timer, kept until that pass starts so
// stopPolling can cancel it while it waits for the lock.
let firstPassTimer: ReturnType<typeof setTimeout> | null = null
// The poll pass that has not settled yet. The guard in startTrackedPass
// only skips a call that would return at pollForRemoteChanges's lock check
// anyway.
let inFlightPoll: Promise<void> | null = null

async function pollForRemoteChanges(): Promise<void> {
  const releaseLock = tryClaimSyncLock({ waitable: true })
  if (!releaseLock) return

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
    // One copy per name: the remote state is keyed by name, so evaluating or
    // recording a second copy of a name would overwrite the chosen copy's
    // revision and make it look changed on every pass.
    const listedFiles = canonicalFiles(remoteFiles)
    // {file, syncUnit} pairs resolved once here rather than re-parsing
    // the filename again inside the merge loop below.
    const changedFiles = listedFiles.flatMap((file) => {
      if (isKnownRemoteRevision(file)) return []
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
    recordRemoteState(listedFiles.filter((file) => !changedNames.has(file.name)))

    const limit = pLimit(SYNC_CONCURRENCY)
    const failedUnits: string[] = []
    // Pack rosters before pack bodies (`settlePackIndexUnitsFirst`). A body
    // whose revision a roster merge forgets is picked up by the next poll.
    await settlePackIndexUnitsFirst(changedFiles, (f) => f.syncUnit, ({ file: remoteFile, syncUnit }) =>
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
    )

    // Pass-level GC — see pack-gc.ts's doc for why this must never be
    // triggered from inside a single unit's own merge callback above, and
    // for why `failedUnits` is passed separately (skips that store's
    // sweep only, not the whole GC call).
    await runPackGcAfterPass(changedFiles.map((f) => f.syncUnit), failedUnits)
    queueOwnDeletedRangesApply()
  } catch {
    // Polling failed — will retry next interval
  } finally {
    releaseLock()
  }
}

/** Unlike a credential problem, a sync guard block (a password change in
 *  progress, or Drive needing a newer app) is shown: it is the only sign on
 *  this machine that syncing has stopped. */
function reportBlockedPoll(reason: SyncBlockReason): void {
  emitSyncBlocked('download', reason)
}

/** Delay of the first pass when polling starts at launch: leaves time for
 *  the OS keychain and the Google token to become available, and for a
 *  connect-time download to take the lock first. */
const STARTUP_POLL_DELAY_MS = 15_000

/** Starts a pass unless the tracked one is still running: that pass holds
 *  `syncRuntime.isSyncing`, so a second call would return at its lock check
 *  without doing anything. pollForRemoteChanges catches its own errors, so
 *  the tracked promise never rejects. */
function startTrackedPass(): void {
  if (inFlightPoll) return
  const pass = pollForRemoteChanges().finally(() => {
    // Only clear our own entry — a reset may have dropped it already.
    if (inFlightPoll === pass) inFlightPoll = null
  })
  inFlightPoll = pass
}

/** Runs the delayed first pass. Unlike an interval tick, it waits out a pass
 *  holding the lock (e.g. a connect-time download) instead of skipping, so
 *  the launch pass is not lost; it is dropped when polling stops meanwhile.
 *  The holder it waits for is never a poll pass: the delay is shorter than
 *  the first interval tick, so startTrackedPass is not blocked by inFlightPoll. */
async function runFirstPass(timer: ReturnType<typeof setTimeout>): Promise<void> {
  while (syncRuntime.inFlightPass) {
    await syncRuntime.inFlightPass
    if (firstPassTimer !== timer) return
  }
  firstPassTimer = null
  startTrackedPass()
}

/** Idempotent: while polling runs, a later call changes nothing, including
 *  `firstPassDelayMs`. With `firstPassDelayMs`, one extra pass runs that
 *  long after the start; the interval keeps its own schedule. */
export function startPolling(options?: { firstPassDelayMs?: number }): void {
  if (pollTimer) return
  pollTimer = setInterval(startTrackedPass, POLL_INTERVAL_MS)
  if (options?.firstPassDelayMs !== undefined) {
    const timer = setTimeout(() => {
      void runFirstPass(timer)
    }, options.firstPassDelayMs)
    firstPassTimer = timer
  }
}

/** Starts polling when auto sync is on: after a download, sign-in or a
 *  stored password (re-arms it after sign-out). */
export function startPollingIfAutoSync(): void {
  if (loadAppConfig().autoSync) startPolling()
}

/** Starts polling at launch when auto sync is on, with a delayed first pass,
 *  so other machines' changes arrive even with no keyboard connected. A pass
 *  without credentials returns silently. */
export function startPollingAtLaunch(): void {
  if (loadAppConfig().autoSync) startPolling({ firstPassDelayMs: STARTUP_POLL_DELAY_MS })
}

export function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (firstPassTimer) {
    clearTimeout(firstPassTimer)
    firstPassTimer = null
  }
}

/** Test-only: resolves when the running poll pass (interval tick or delayed
 * first pass) has settled (immediately when none is running). */
export function waitForPollPassForTests(): Promise<void> {
  return inFlightPoll ?? Promise.resolve()
}

/** Test-only reset for the tracked pass — called by the sync-service
 * facade's `_resetForTests`. It does not stop a running pass. */
export function clearInFlightPollForTests(): void {
  inFlightPoll = null
}
