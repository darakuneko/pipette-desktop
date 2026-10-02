// SPDX-License-Identifier: GPL-2.0-or-later
// Central mutable state for the sync service, consolidated into one
// exported object so every sibling module in this directory shares the
// same live bindings. A plain `export let x` cannot be reassigned from
// outside its declaring module (an imported binding is read-only), so
// every module-scoped flag that's read/written across the split lives
// on `syncRuntime` instead of as a bare top-level `let`.

import { IpcChannels } from '../../shared/ipc/channels'
import { broadcastToAllWindows } from '../utils/broadcast'
import type { DriveFile } from './google-drive'
import type { SyncProgress } from '../../shared/types/sync'

export const SYNC_CONCURRENCY = 10
export const DEBOUNCE_MS = 10_000
export const POLL_INTERVAL_MS = 3 * 60 * 1000 // 3 minutes

export type ProgressCallback = (progress: SyncProgress) => void

/** Every module-scoped mutable binding the sync service needs, shared
 * across sync-execute.ts, sync-polling.ts, sync-flush.ts, sync-password.ts,
 * and the sync-service.ts facade. Only modules under src/main/sync/ may
 * read or write these fields directly — external callers go through the
 * facade's exported functions (hasPendingChanges, isSyncInProgress,
 * setProgressCallback, etc.), never this object. */
export const syncRuntime = {
  debounceTimer: null as ReturnType<typeof setTimeout> | null,
  pendingChanges: new Set<string>(),
  progressCallback: null as ProgressCallback | null,
  isQuitting: false,
  isSyncing: false,
  passwordCheckValidated: false,
  lastKnownRemoteState: new Map<string, string>(), // fileName -> modifiedTime
  /** Files the last re-encryption pass could open with neither the old nor
   *  the new password; null when that pass found none. Kept in memory
   *  only — a resume after a restart finds them again. */
  passwordChangeUndecryptable: null as Array<{ id: string; name: string }> | null,
  /** Set when a password change stopped because this machine no longer
   *  holds its Drive lock (e.g. another PC released it); cleared once the
   *  lock is held again or the change ends. */
  passwordChangeLockLost: false,
  /** Settles (never rejects) when the running password-change operation
   *  has finished; null when none is running. The before-quit handler
   *  waits on it. */
  passwordChangeRun: null as Promise<void> | null,
}

export function hasPendingChanges(): boolean {
  return syncRuntime.pendingChanges.size > 0
}

export function cancelPendingChanges(prefix?: string): void {
  if (prefix) {
    for (const unit of syncRuntime.pendingChanges) {
      if (unit.startsWith(prefix)) syncRuntime.pendingChanges.delete(unit)
    }
  } else {
    syncRuntime.pendingChanges.clear()
  }
  if (syncRuntime.pendingChanges.size === 0 && syncRuntime.debounceTimer) {
    clearTimeout(syncRuntime.debounceTimer)
    syncRuntime.debounceTimer = null
  }
  broadcastPendingStatus()
}

export function isSyncInProgress(): boolean {
  return syncRuntime.isSyncing
}

export function broadcastPendingStatus(): void {
  broadcastToAllWindows(IpcChannels.SYNC_PENDING_STATUS, hasPendingChanges())
}

export function setProgressCallback(cb: ProgressCallback): void {
  syncRuntime.progressCallback = cb
}

export function emitProgress(progress: SyncProgress): void {
  syncRuntime.progressCallback?.(progress)
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

// --- Remote state tracking ---

export function updateRemoteState(files: DriveFile[]): void {
  syncRuntime.lastKnownRemoteState.clear()
  for (const file of files) {
    syncRuntime.lastKnownRemoteState.set(file.name, file.modifiedTime)
  }
}
