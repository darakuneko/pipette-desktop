// SPDX-License-Identifier: GPL-2.0-or-later
// Central mutable state for the sync service, consolidated into one
// exported object so every sibling module in this directory shares the
// same live bindings. A plain `export let x` cannot be reassigned from
// outside its declaring module (an imported binding is read-only), so
// every module-scoped flag that's read/written across the split lives
// on `syncRuntime` instead of as a bare top-level `let`.

import { IpcChannels } from '../../shared/ipc/channels'
import { broadcastToAllWindows } from '../utils/broadcast'
import type { DriveFile, UploadedFile } from './google-drive'
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
  /** When `debounceTimer` fires (`Date.now()` ms); null while none is
   *  armed. */
  debounceDueAt: null as number | null,
  pendingChanges: new Set<string>(),
  /** Generation of each pending unit, bumped by every `markPending`. A pass
   *  removes an uploaded unit only while its generation is the one it took
   *  before the upload, so a change made during the upload stays pending. */
  pendingGeneration: new Map<string, number>(),
  /** Source of `pendingGeneration` values. Never reset: values stay unique,
   *  so a unit cancelled and changed again never matches an older pass. */
  lastPendingGeneration: 0,
  progressCallback: null as ProgressCallback | null,
  isQuitting: false,
  isSyncing: false,
  /** Settles (never rejects) when the work holding `isSyncing` (a flush,
   *  executeSync, a poll, a password change or a lock release) ends; null
   *  when nothing holds it. Set and cleared together with `isSyncing` by
   *  `claimSyncLock`. */
  inFlightPass: null as Promise<void> | null,
  /** Drive id and `modifiedTime` of the password-check this machine last
   *  opened with its stored password; null when none has been validated
   *  since the cache was reset. A listing whose chosen password-check
   *  differs in either (e.g. another PC changed the password) is validated
   *  again. */
  validatedPasswordCheck: null as UploadedFile | null,
  /** The password-check this process created and when
   *  (`passwordCheckTiming.now()` ms), until a listing shows a
   *  password-check or `passwordCheckTiming.createdMemoryMs` passes. Drive
   *  listings lag behind a create, so a pass that lists too early opens
   *  this file by id instead of creating a second one. */
  passwordCheckCreated: null as { file: UploadedFile; at: number } | null,
  /** The password-check creation in flight, shared so passes that see it
   *  missing at the same time create it once. */
  passwordCheckCreating: null as Promise<UploadedFile> | null,
  /** When (`syncFormatTiming.now()` ms) this process created its own
   *  sync-format marker, until a listing shows it or
   *  `syncFormatTiming.createdMemoryMs` passes (sync-format.ts). */
  syncFormatMarkerCreatedAt: null as number | null,
  /** When a listing last showed our own sync-format marker. */
  syncFormatMarkerSeenAt: null as number | null,
  /** The marker creation in flight, shared so passes that see it missing
   *  at the same time create it once. */
  syncFormatMarkerCreating: null as Promise<void> | null,
  /** Bumped by `forgetCreatedSyncFormatMarker` (sign-out). A create or
   *  listing that started under an older generation belongs to the previous
   *  account, so its completion records nothing. */
  syncFormatMarkerGeneration: 0,
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
  /** Keyboards with an analytics sync running (sync-analytics.ts). A
   *  per-uid mutex rather than `isSyncing`: switching keyboards while the
   *  previous sync runs doesn't skip the new uid, and `uid-a` and `uid-b`
   *  can proceed in parallel since their cloud file namespaces
   *  (`keyboards/{uid}/devices/*`) are disjoint. */
  analyticsSyncingUids: new Set<string>(),
}

export function hasPendingChanges(): boolean {
  return syncRuntime.pendingChanges.size > 0
}

/** Adds `syncUnit` to the pending set with a new generation. Every write
 *  to the pending set goes through here. */
export function markPending(syncUnit: string): void {
  syncRuntime.pendingChanges.add(syncUnit)
  syncRuntime.pendingGeneration.set(syncUnit, ++syncRuntime.lastPendingGeneration)
}

/** A unit's current generation; 0 when it has none (not pending).
 *  `markPending` hands out generations from 1. */
export function pendingGenerationOf(syncUnit: string): number {
  return syncRuntime.pendingGeneration.get(syncUnit) ?? 0
}

/** The current generation of every pending unit, taken before a pass
 *  uploads them. */
export function snapshotPendingGenerations(): Map<string, number> {
  const snapshot = new Map<string, number>()
  for (const unit of syncRuntime.pendingChanges) {
    snapshot.set(unit, pendingGenerationOf(unit))
  }
  return snapshot
}

/** Removes an uploaded unit from the pending set unless it was marked
 *  pending again after `generation` was taken. */
export function settlePending(syncUnit: string, generation: number): void {
  if (pendingGenerationOf(syncUnit) !== generation) return
  syncRuntime.pendingChanges.delete(syncUnit)
  syncRuntime.pendingGeneration.delete(syncUnit)
}

/** Disarms the flush timer. */
export function clearFlushTimer(): void {
  if (syncRuntime.debounceTimer) clearTimeout(syncRuntime.debounceTimer)
  syncRuntime.debounceTimer = null
  syncRuntime.debounceDueAt = null
}

/** Takes the sync lock unless it is held (null then). The check and the
 *  claim happen in one synchronous step, so two callers resuming from the
 *  same await cannot both take it. */
export function tryClaimSyncLock(): (() => void) | null {
  return syncRuntime.isSyncing ? null : claimSyncLock()
}

/** Takes the sync lock and publishes this pass on `inFlightPass` in the
 *  same step. The returned release frees both only while this pass is still
 *  the published one (a reset may have replaced it), and settles the pass
 *  for anyone waiting on it.
 *  Callers check `isSyncing` in the same synchronous step, or use
 *  `tryClaimSyncLock`. */
export function claimSyncLock(): () => void {
  let settle!: () => void
  const pass = new Promise<void>((resolve) => {
    settle = resolve
  })
  syncRuntime.isSyncing = true
  syncRuntime.inFlightPass = pass
  return () => {
    if (syncRuntime.inFlightPass === pass) {
      syncRuntime.isSyncing = false
      syncRuntime.inFlightPass = null
    }
    settle()
  }
}

export function cancelPendingChanges(prefix?: string): void {
  if (prefix) {
    for (const unit of syncRuntime.pendingChanges) {
      if (unit.startsWith(prefix)) {
        syncRuntime.pendingChanges.delete(unit)
        syncRuntime.pendingGeneration.delete(unit)
      }
    }
  } else {
    syncRuntime.pendingChanges.clear()
    syncRuntime.pendingGeneration.clear()
  }
  if (syncRuntime.pendingChanges.size === 0) clearFlushTimer()
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

/** Marks each file's revision as handled by this machine. Entries for other
 *  files are left alone, so a file nobody handled still looks changed to the
 *  next poll. */
export function recordRemoteState(files: Array<Pick<DriveFile, 'name' | 'modifiedTime'>>): void {
  for (const file of files) {
    syncRuntime.lastKnownRemoteState.set(file.name, file.modifiedTime)
  }
}
