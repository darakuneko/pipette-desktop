// SPDX-License-Identifier: GPL-2.0-or-later
// Debounced auto-sync upload (notifyChange → flushPendingChanges) and
// the before-quit handler that flushes pending changes and runs
// registered finalizers before the app is allowed to exit.

import { app } from 'electron'
import { listFiles } from './google-drive'
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
  updateRemoteState,
  broadcastPendingStatus,
} from './sync-runtime-state'
import { requireSyncCredentials, ensurePasswordCheckValidated, PasswordMismatchError } from './sync-password'
import { localSyncBlock, remoteSyncBlock, emitSyncBlocked } from './sync-password-guard'
import type { SyncBlockReason } from '../../shared/types/sync'
import { syncOrUpload } from './sync-merge-dispatch'
import { stopPolling } from './sync-polling'

// --- Debounced upload ---

export function notifyChange(syncUnit: string): void {
  syncRuntime.pendingChanges.add(syncUnit)
  broadcastPendingStatus()

  if (syncRuntime.debounceTimer) {
    clearTimeout(syncRuntime.debounceTimer)
  }

  syncRuntime.debounceTimer = setTimeout(() => {
    void flushPendingChanges()
  }, DEBOUNCE_MS)
}

export async function flushPendingChanges(): Promise<void> {
  if (syncRuntime.pendingChanges.size === 0) return

  if (syncRuntime.isSyncing) {
    scheduleFlush(DEBOUNCE_MS)
    return
  }

  syncRuntime.isSyncing = true

  if (syncRuntime.debounceTimer) clearTimeout(syncRuntime.debounceTimer)
  syncRuntime.debounceTimer = null

  try {
    const config = await loadAppConfig()
    if (!config.autoSync) {
      syncRuntime.pendingChanges.clear()
      broadcastPendingStatus()
      return
    }

    // Both block checks run before the pending set is taken below, so a
    // blocked flush keeps every pending change for a later pass.
    const localBlock = await localSyncBlock()
    if (localBlock) {
      reportBlockedFlush(localBlock)
      return
    }

    const credentials = await requireSyncCredentials()
    if (!credentials.ok) {
      syncRuntime.pendingChanges.clear()
      broadcastPendingStatus()
      return
    }
    const password = credentials.password

    emitProgress({ direction: 'upload', status: 'syncing', message: 'Auto-sync starting...' })

    const remoteFiles = await listFiles()
    const remoteBlock = remoteSyncBlock(remoteFiles)
    if (remoteBlock) {
      reportBlockedFlush(remoteBlock)
      return
    }
    updateRemoteState(remoteFiles)

    try {
      await ensurePasswordCheckValidated(password, remoteFiles)
    } catch (err) {
      if (err instanceof PasswordMismatchError) {
        emitProgress({ direction: 'upload', status: 'error', message: 'sync.passwordMismatch' })
      } else {
        emitProgress({ direction: 'upload', status: 'error', message: errorMessage(err, 'Password check failed') })
      }
      return
    }

    const changes = new Set(syncRuntime.pendingChanges)
    syncRuntime.pendingChanges.clear()

    const limit = pLimit(SYNC_CONCURRENCY)
    await Promise.allSettled(
      [...changes].map((syncUnit) =>
        limit(async () => {
          try {
            await syncOrUpload(syncUnit, password, remoteFiles)
          } catch {
            // Re-add failed unit so pending stays true
            syncRuntime.pendingChanges.add(syncUnit)
          }
        }),
      ),
    )

    broadcastPendingStatus()

    // Refresh remote state after uploads to prevent polling re-downloads
    const updatedFiles = await listFiles()
    updateRemoteState(updatedFiles)

    if (syncRuntime.pendingChanges.size === 0) {
      emitProgress({ direction: 'upload', status: 'success', message: 'Sync complete' })
    } else {
      emitProgress({ direction: 'upload', status: 'error', message: 'Some sync units failed' })
    }
  } finally {
    syncRuntime.isSyncing = false
  }
}

/** Reports a flush stopped by a password change and tries again after a
 *  polling interval (not while quitting); the pending changes stay. */
function reportBlockedFlush(reason: SyncBlockReason): void {
  emitSyncBlocked('upload', reason)
  if (syncRuntime.isQuitting) return
  scheduleFlush(POLL_INTERVAL_MS)
}

/** Replaces any pending flush timer (e.g. one a notifyChange set while
 *  this flush was running), so at most one is ever scheduled. */
function scheduleFlush(delayMs: number): void {
  if (syncRuntime.debounceTimer) clearTimeout(syncRuntime.debounceTimer)
  syncRuntime.debounceTimer = setTimeout(() => {
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

    const syncPending = syncRuntime.pendingChanges.size > 0 || syncRuntime.debounceTimer !== null
    const preSync = preSyncFinalizers.filter((f) => f.hasWork())
    const extras = extraFinalizers.filter((f) => f.hasWork())
    const passwordChangeRun = syncRuntime.passwordChangeRun
    if (!syncPending && preSync.length === 0 && extras.length === 0 && !passwordChangeRun) return

    e.preventDefault()
    syncRuntime.isQuitting = true

    if (syncRuntime.debounceTimer) {
      clearTimeout(syncRuntime.debounceTimer)
      syncRuntime.debounceTimer = null
    }

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

      // Phase 2: sync flush. Re-evaluate pendingChanges because pre-sync
      // finalizers may have added to it.
      if (syncPending || syncRuntime.pendingChanges.size > 0) {
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

    // Always call app.quit() even if a phase unexpectedly throws, so the
    // app cannot hang on the preventDefault()'d quit.
    runQuitPhases()
      .catch((err: unknown) => {
        log('error', `before-quit phases crashed: ${String(err)}`)
      })
      .finally(() => {
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
