// SPDX-License-Identifier: GPL-2.0-or-later
// Debounced auto-sync upload (notifyChange → flushPendingChanges) and
// the before-quit handler that flushes pending changes and runs
// registered finalizers before the app is allowed to exit.

import { app } from 'electron'
import { listFiles, type DriveFile } from './google-drive'
import { pLimit } from '../../shared/concurrency'
import { loadAppConfig } from '../app-config'
import { log } from '../logger'
import {
  SYNC_CONCURRENCY,
  DEBOUNCE_MS,
  POLL_INTERVAL_MS,
  syncRuntime,
  emitProgress,
  errorMessage,
  broadcastPendingStatus,
  markPending,
  pendingGenerationOf,
  snapshotPendingGenerations,
  settlePending,
  tryClaimSyncLock,
  clearFlushTimer,
} from './sync-runtime-state'
import { requireSyncCredentials, ensurePasswordCheckValidated, PasswordMismatchError } from './sync-password'
import { localSyncBlock, remoteSyncBlock, emitSyncBlocked } from './sync-password-guard'
import { ensureSyncFormatMarker, syncFormatGeneration } from './sync-format'
import type { SyncBlockReason, SyncCredentialFailureReason } from '../../shared/types/sync'
import { syncOrUpload } from './sync-merge-dispatch'
import { stopPolling } from './sync-polling'

// --- Debounced upload ---

/** How long before-quit waits for the sync work it started or found
 *  running. A Drive request has no timeout of its own, so a stalled upload
 *  must not keep the app from exiting. */
export const QUIT_SYNC_DEADLINE_MS = 30_000

/** Credential failures that can clear up on their own. The others wait for
 *  a sign-in or a password, which schedule a flush themselves. */
const RETRYABLE_CREDENTIAL_REASONS: ReadonlySet<SyncCredentialFailureReason> = new Set([
  'keystoreUnavailable',
  'decryptFailed',
  'remoteCheckFailed',
])

export function notifyChange(syncUnit: string): void {
  markPending(syncUnit)
  broadcastPendingStatus()
  // Each change pushes the flush out by the full debounce.
  armFlushTimer(DEBOUNCE_MS)
}

export async function flushPendingChanges(): Promise<void> {
  if (syncRuntime.pendingChanges.size === 0) return

  // A held lock is waited out once (until it is free while quitting); with
  // no pass to wait on, or still held after that, the flush is rescheduled.
  let releaseLock = tryClaimSyncLock()
  let waited = false
  while (!releaseLock) {
    const pass = syncRuntime.inFlightPass
    if (!pass || (waited && !syncRuntime.isQuitting)) {
      scheduleFlushIfPending(DEBOUNCE_MS)
      return
    }
    await pass
    waited = true
    releaseLock = tryClaimSyncLock()
  }
  // The pass waited on may have uploaded everything.
  if (syncRuntime.pendingChanges.size === 0) {
    releaseLock()
    return
  }
  clearFlushTimer()

  // Every early return below keeps the pending set; only an upload that
  // succeeds removes a unit from it.
  try {
    const config = await loadAppConfig()
    // Turning auto sync on schedules a flush (sync-ipc.ts).
    if (!config.autoSync) return

    const localBlock = await localSyncBlock()
    if (localBlock) {
      reportBlockedFlush(localBlock)
      return
    }

    const credentials = await requireSyncCredentials()
    if (!credentials.ok) {
      if (RETRYABLE_CREDENTIAL_REASONS.has(credentials.reason)) scheduleFlushIfPending(POLL_INTERVAL_MS)
      return
    }
    const password = credentials.password

    emitProgress({ direction: 'upload', status: 'syncing', message: 'Auto-sync starting...' })

    const formatGeneration = syncFormatGeneration()
    let remoteFiles: DriveFile[]
    try {
      remoteFiles = await listFiles()
    } catch (err) {
      reportFailedFlush(errorMessage(err, 'Sync failed'))
      return
    }
    const remoteBlock = remoteSyncBlock(remoteFiles, formatGeneration)
    if (remoteBlock) {
      reportBlockedFlush(remoteBlock)
      return
    }
    try {
      await ensureSyncFormatMarker(remoteFiles, formatGeneration)
    } catch (err) {
      reportFailedFlush(errorMessage(err, 'Sync failed'))
      return
    }

    try {
      await ensurePasswordCheckValidated(password, remoteFiles)
    } catch (err) {
      if (err instanceof PasswordMismatchError) {
        // Waits for the new password; storing it schedules a flush
        // (sync-ipc.ts).
        emitProgress({ direction: 'upload', status: 'error', message: 'sync.passwordMismatch' })
      } else {
        reportFailedFlush(errorMessage(err, 'Password check failed'))
      }
      return
    }

    const generations = snapshotPendingGenerations()
    let anyFailed = false
    const limit = pLimit(SYNC_CONCURRENCY)
    await Promise.allSettled(
      [...generations].map(([syncUnit, generation]) =>
        limit(async () => {
          try {
            await syncOrUpload(syncUnit, password, remoteFiles)
            settlePending(syncUnit, generation)
          } catch {
            anyFailed = true
          }
        }),
      ),
    )

    broadcastPendingStatus()

    if (anyFailed) {
      emitProgress({ direction: 'upload', status: 'error', message: 'Some sync units failed' })
    } else {
      emitProgress({ direction: 'upload', status: 'success', message: 'Sync complete' })
    }

    if (syncRuntime.pendingChanges.size > 0 && !syncRuntime.isQuitting) {
      // A unit changed during this pass goes out after the usual debounce;
      // when only failed units are left, they wait a polling interval.
      const changedDuringPass = [...syncRuntime.pendingChanges].some(
        (unit) => pendingGenerationOf(unit) !== (generations.get(unit) ?? 0),
      )
      scheduleFlush(changedDuringPass ? DEBOUNCE_MS : POLL_INTERVAL_MS)
    }
  } finally {
    releaseLock()
  }
}

/** Reports a flush stopped by the sync guard (a password change, or Drive
 *  needing a newer app) and tries again after a polling interval (not
 *  while quitting); the pending changes stay. */
function reportBlockedFlush(reason: SyncBlockReason): void {
  emitSyncBlocked('upload', reason)
  scheduleFlushIfPending(POLL_INTERVAL_MS)
}

/** Reports a flush that failed before uploading anything (Drive listing,
 *  format marker, password check) and tries again after a polling interval
 *  (not while quitting); the pending changes stay. */
function reportFailedFlush(message: string): void {
  emitProgress({ direction: 'upload', status: 'error', message })
  scheduleFlushIfPending(POLL_INTERVAL_MS)
}

/** Schedules a flush when changes are pending and the app is not quitting.
 *  Called once a reason a flush kept them is gone (auto sync turned on, a
 *  sign-in, a password stored). */
export function scheduleFlushIfPending(delayMs: number = DEBOUNCE_MS): void {
  if (syncRuntime.pendingChanges.size === 0 || syncRuntime.isQuitting) return
  scheduleFlush(delayMs)
}

/** Arms the flush timer for `delayMs` from now, keeping one that already
 *  fires no later, so at most one timer exists and the earlier flush wins. */
function scheduleFlush(delayMs: number): void {
  const dueAt = Date.now() + delayMs
  if (syncRuntime.debounceTimer && syncRuntime.debounceDueAt !== null && syncRuntime.debounceDueAt <= dueAt) return
  armFlushTimer(delayMs)
}

/** Replaces any flush timer with one firing `delayMs` from now. */
function armFlushTimer(delayMs: number): void {
  clearFlushTimer()
  syncRuntime.debounceDueAt = Date.now() + delayMs
  syncRuntime.debounceTimer = setTimeout(() => {
    syncRuntime.debounceTimer = null
    syncRuntime.debounceDueAt = null
    void flushPendingChanges()
  }, delayMs)
}

// --- Before-quit handler ---

interface BeforeQuitFinalizer {
  hasWork: () => boolean
  run: () => Promise<void>
}

const preSyncFinalizers: BeforeQuitFinalizer[] = []
const extraFinalizers: BeforeQuitFinalizer[] = []

/**
 * Register a finalizer that runs BEFORE the sync flush at before-quit time.
 * Use this when the subsystem's flush may enqueue new sync units via
 * notifyChange() — running pre-sync guarantees the freshly queued units land
 * in the same quit cycle instead of waiting for the next launch.
 */
export function registerPreSyncQuitFinalizer(finalizer: BeforeQuitFinalizer): void {
  preSyncFinalizers.push(finalizer)
}

/**
 * Register an additional async finalizer to run alongside the sync flush at
 * before-quit time. Used by subsystems that do not touch the sync queue.
 */
export function registerBeforeQuitFinalizer(finalizer: BeforeQuitFinalizer): void {
  extraFinalizers.push(finalizer)
}

export function setupBeforeQuitHandler(): void {
  app.on('before-quit', (e) => {
    if (syncRuntime.isQuitting) return

    stopPolling()

    const syncPending = syncRuntime.pendingChanges.size > 0
      || syncRuntime.debounceTimer !== null
      || syncRuntime.inFlightPass !== null
    const preSync = preSyncFinalizers.filter((f) => f.hasWork())
    const extras = extraFinalizers.filter((f) => f.hasWork())
    const passwordChangeRun = syncRuntime.passwordChangeRun
    if (!syncPending && preSync.length === 0 && extras.length === 0 && !passwordChangeRun) return

    e.preventDefault()
    syncRuntime.isQuitting = true
    clearFlushTimer()

    const runQuitPhases = async (): Promise<void> => {
      // Phase 0: a running password switch sees `isQuitting` at its next
      // chunk boundary, stops, and keeps its state for the next launch.
      if (passwordChangeRun) {
        await passwordChangeRun.catch((err: unknown) => {
          log('error', `password change failed while quitting: ${String(err)}`)
        })
      }

      // Phase 1: pre-sync finalizers. They may call notifyChange() to
      // enqueue additional sync units; those land in pendingChanges before
      // the sync flush starts.
      if (preSync.length > 0) {
        await Promise.all(
          preSync.map((f) =>
            f.run().catch((err: unknown) => {
              log('error', `pre-sync quit finalizer failed: ${String(err)}`)
            }),
          ),
        )
      }

      // Phase 2: sync flush. The running pass (a flush, a manual sync or a
      // poll) ends first; then pendingChanges is re-evaluated because that
      // pass and the pre-sync finalizers may have changed it.
      const runningPass = syncRuntime.inFlightPass
      if (runningPass) await runningPass
      if (syncRuntime.pendingChanges.size > 0) {
        await flushPendingChanges().catch((err: unknown) => {
          log('error', `before-quit sync flush failed: ${String(err)}`)
        })
      }

      // Phase 3: remaining extra finalizers. Re-check hasWork() so nothing
      // is run twice if it also happens to sit on the extra list.
      const extrasAfter = extraFinalizers.filter((f) => f.hasWork())
      if (extrasAfter.length > 0) {
        await Promise.all(
          extrasAfter.map((f) =>
            f.run().catch((err: unknown) => {
              log('error', `extra quit finalizer failed: ${String(err)}`)
            }),
          ),
        )
      }
    }

    let deadlineTimer: ReturnType<typeof setTimeout> | null = null
    const deadline = new Promise<void>((resolve) => {
      deadlineTimer = setTimeout(() => {
        log('warn', 'before-quit: sync did not finish within the deadline')
        resolve()
      }, QUIT_SYNC_DEADLINE_MS)
    })

    // Always call app.quit() even if a phase unexpectedly throws or never
    // settles, so the app cannot hang on the preventDefault()'d quit.
    Promise.race([runQuitPhases(), deadline])
      .catch((err: unknown) => {
        log('error', `before-quit phases crashed: ${String(err)}`)
      })
      .finally(() => {
        if (deadlineTimer) clearTimeout(deadlineTimer)
        app.quit()
      })
  })
}

/** Test-only reset for this module's finalizer registries — called by
 * the sync-service facade's `_resetForTests` so a test that registers
 * a finalizer doesn't leak it into the next test file. */
export function clearQuitFinalizersForTests(): void {
  preSyncFinalizers.length = 0
  extraFinalizers.length = 0
}
