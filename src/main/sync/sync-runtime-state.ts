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
  /** Account (id_token `sub`) the units in `pendingChanges` were changed
   *  under; null while signed out or when the account is unknown. */
  pendingOwner: null as string | null,
  /** Pending units of accounts other than the current one, kept until that
   *  account signs in again. No upload path reads them. */
  heldPending: new Map<string, Set<string>>(),
  progressCallback: null as ProgressCallback | null,
  isQuitting: false,
  isSyncing: false,
  /** Settles (never rejects) when the work holding `isSyncing` (a flush,
   *  executeSync, a poll, a password change, a lock release or a reset)
   *  ends; null when nothing holds it. Set and cleared together with
   *  `isSyncing` by `claimSyncLock`. */
  inFlightPass: null as Promise<void> | null,
  /** Whether the holder of `inFlightPass` claimed it as waitable: work that
   *  always settles on its own (a poll, a reset), so `executeSync` waits for
   *  it instead of skipping. Set and cleared together with `inFlightPass`. */
  inFlightPassWaitable: false,
  /** Keyboards whose data the running reset removes (sync-reset-lock.ts):
   *  every keyboard, the listed uids, or null when no reset is running or it
   *  removes no keyboard data. Analytics syncs and remote day fetches of
   *  these keyboards don't start while it is set. */
  resetKeyboards: null as 'all' | ReadonlySet<string> | null,
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
  /** Remote day fetches running per keyboard (`fetchRemoteTypingDay`,
   *  sync-typing-remote.ts); a uid is removed when its count reaches 0. A
   *  reset that removes a listed keyboard's data refuses to start. */
  remoteTypingDayFetches: new Map<string, number>(),
  /** True while a sign-in stores new tokens or a sign-out removes them
   *  (sync-pending-account.ts). Analytics syncs and remote day fetches
   *  don't start while it is set. */
  accountSwitching: false,
}

/** Puts every `syncRuntime` field back to its initial value. Test-only —
 *  called by the sync-service facade's `_resetForTests`. */
export function resetSyncRuntimeForTests(): void {
  clearFlushTimer()
  pendingPersistence = null
  pendingFileUnreadable = false
  syncRuntime.pendingChanges.clear()
  syncRuntime.pendingGeneration.clear()
  syncRuntime.pendingOwner = null
  syncRuntime.heldPending.clear()
  syncRuntime.lastKnownRemoteState.clear()
  syncRuntime.isSyncing = false
  syncRuntime.inFlightPass = null
  syncRuntime.inFlightPassWaitable = false
  syncRuntime.resetKeyboards = null
  syncRuntime.isQuitting = false
  syncRuntime.progressCallback = null
  syncRuntime.validatedPasswordCheck = null
  syncRuntime.passwordCheckCreated = null
  syncRuntime.passwordCheckCreating = null
  syncRuntime.syncFormatMarkerCreatedAt = null
  syncRuntime.syncFormatMarkerSeenAt = null
  syncRuntime.syncFormatMarkerCreating = null
  syncRuntime.passwordChangeUndecryptable = null
  syncRuntime.passwordChangeLockLost = false
  syncRuntime.passwordChangeRun = null
  syncRuntime.analyticsSyncingUids.clear()
  syncRuntime.remoteTypingDayFetches.clear()
  syncRuntime.accountSwitching = false
}

/** The pending state as it is written to disk (sync-pending-store.ts). */
export interface PendingSnapshot {
  owner: string | null
  units: string[]
  held: Record<string, string[]>
}

/** Writes the pending state to disk: `writeNow` synchronously, throwing on
 *  failure; `schedule` shortly after, with whatever the state is then.
 *  `isDirty` is true while the last write failed. */
export interface PendingPersistence {
  writeNow: (snapshot: PendingSnapshot) => void
  schedule: () => void
  isDirty: () => boolean
}

/** Registered at startup (sync-pending-store.ts). Null until then and after
 *  a test reset, so the pending state is kept in memory only. */
let pendingPersistence: PendingPersistence | null = null

export function setPendingPersistence(persistence: PendingPersistence): void {
  pendingPersistence = persistence
}

/** Set at startup when the pending file exists but cannot be read
 *  (sync-pending-store.ts): it is left as it is and nothing is written, so
 *  a cancel that must be on disk cannot be. */
let pendingFileUnreadable = false

export function setPendingFileUnreadable(): void {
  pendingFileUnreadable = true
}

/** The pending state with only the units `keep` accepts, held units
 *  included; accounts left with no held unit are dropped. */
function snapshotKeeping(keep: (unit: string) => boolean): PendingSnapshot {
  const held: Record<string, string[]> = {}
  for (const [sub, units] of syncRuntime.heldPending) {
    const kept = [...units].filter(keep)
    if (kept.length > 0) held[sub] = kept
  }
  return { owner: syncRuntime.pendingOwner, units: [...syncRuntime.pendingChanges].filter(keep), held }
}

export function pendingSnapshot(): PendingSnapshot {
  return snapshotKeeping(() => true)
}

/** Disarms the flush timer once nothing is pending and tells the renderer
 *  whether anything is. */
export function afterPendingChange(): void {
  if (syncRuntime.pendingChanges.size === 0) clearFlushTimer()
  broadcastPendingStatus()
}

/** Writes the pending state now. A failure is logged; the next write
 *  catches up. */
export function persistPendingNow(): void {
  try {
    pendingPersistence?.writeNow(pendingSnapshot())
  } catch (err) {
    console.warn('[sync] failed to write the pending changes', err)
  }
}

/** Writes the pending state now; throws when it cannot be written. */
export function writePendingStateOrThrow(): void {
  pendingPersistence?.writeNow(pendingSnapshot())
}

/** Finishes a change to the pending owner or the held units. */
export function commitPendingState(): void {
  persistPendingNow()
  afterPendingChange()
}

export function hasPendingChanges(): boolean {
  return syncRuntime.pendingChanges.size > 0
}

/** Adds `syncUnit` to the pending set with a new generation. Every write
 *  to the pending set goes through here. */
export function markPending(syncUnit: string): void {
  const added = !syncRuntime.pendingChanges.has(syncUnit)
  syncRuntime.pendingChanges.add(syncUnit)
  syncRuntime.pendingGeneration.set(syncUnit, ++syncRuntime.lastPendingGeneration)
  // A unit already pending is on disk unless the last write failed.
  if (added || pendingPersistence?.isDirty()) pendingPersistence?.schedule()
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
  pendingPersistence?.schedule()
}

/** Disarms the flush timer. */
export function clearFlushTimer(): void {
  if (syncRuntime.debounceTimer) clearTimeout(syncRuntime.debounceTimer)
  syncRuntime.debounceTimer = null
  syncRuntime.debounceDueAt = null
}

export interface SyncLockOptions {
  /** The holder always settles on its own, so `executeSync` waits for it
   *  (`inFlightPassWaitable`). */
  waitable?: boolean
}

/** Takes the sync lock unless it is held (null then). The check and the
 *  claim happen in one synchronous step, so two callers resuming from the
 *  same await cannot both take it. */
export function tryClaimSyncLock(options?: SyncLockOptions): (() => void) | null {
  return syncRuntime.isSyncing ? null : claimSyncLock(options)
}

/** Takes the sync lock and publishes this pass on `inFlightPass` in the
 *  same step. The returned release frees both only while this pass is still
 *  the published one (a test reset may have replaced it), and settles the
 *  pass for anyone waiting on it.
 *  Callers check `isSyncing` in the same synchronous step, or use
 *  `tryClaimSyncLock`. */
export function claimSyncLock(options: SyncLockOptions = {}): () => void {
  let settle!: () => void
  const pass = new Promise<void>((resolve) => {
    settle = resolve
  })
  syncRuntime.isSyncing = true
  syncRuntime.inFlightPass = pass
  syncRuntime.inFlightPassWaitable = options.waitable === true
  return () => {
    if (syncRuntime.inFlightPass === pass) {
      syncRuntime.isSyncing = false
      syncRuntime.inFlightPass = null
      syncRuntime.inFlightPassWaitable = false
    }
    settle()
  }
}

/** Takes the sync lock as a waitable holder, waiting for each pass that
 *  holds it to end; null when it is still held at `deadline`
 *  (`Date.now()` ms). */
export async function claimSyncLockBy(deadline: number): Promise<(() => void) | null> {
  for (;;) {
    const release = tryClaimSyncLock({ waitable: true })
    if (release) return release
    const pass = syncRuntime.inFlightPass
    // claimSyncLock publishes a pass with the lock, so this cannot happen;
    // waiting on nothing would spin forever.
    if (!pass) throw new Error('The sync lock is held with no pass to wait for')
    const remaining = deadline - Date.now()
    if (remaining <= 0) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([
      pass.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), remaining)
      }),
    ])
    clearTimeout(timer)
    if (timedOut) return null
  }
}

/** How often `waitForLockFreeWritersBy` checks again. */
const WRITER_CHECK_INTERVAL_MS = 100

/** Waits until no analytics sync and no remote day fetch runs (the Drive
 *  writers that don't take the sync lock); false when some still run at
 *  `deadline` (`Date.now()` ms). */
export async function waitForLockFreeWritersBy(deadline: number): Promise<boolean> {
  while (syncRuntime.analyticsSyncingUids.size > 0 || syncRuntime.remoteTypingDayFetches.size > 0) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await new Promise((resolve) => setTimeout(resolve, Math.min(WRITER_CHECK_INTERVAL_MS, remaining)))
  }
  return true
}

/** Drops the pending units starting with any of `prefixes` (every unit
 *  when `prefixes` is omitted; none for an empty list), held units of other
 *  accounts included. Nothing is written when nothing matches, unless
 *  `writeAlways` asks for the write anyway: a reset's first cancel uses it
 *  to find a disk failure before it removes anything. With `writeAlways`,
 *  it also throws while the pending file could not be read at startup. The
 *  resulting state is written to disk before memory changes: a reset calls
 *  this once, before it deletes anything, so a crash right after cannot
 *  bring a cancelled unit back at the next launch. A failed write throws
 *  and leaves the pending state as it was, which stops the reset. */
export function cancelPendingChanges(
  prefixes?: readonly string[],
  options: { writeAlways?: boolean } = {},
): void {
  const cancels = (unit: string): boolean =>
    prefixes === undefined || prefixes.some((prefix) => unit.startsWith(prefix))
  const matchesHeld = [...syncRuntime.heldPending.values()].some((units) => [...units].some(cancels))
  const cancelled = [...syncRuntime.pendingChanges].filter(cancels)
  if (options.writeAlways && pendingFileUnreadable) {
    // A unit cancelled only in memory would come back from the file once
    // it can be read again.
    throw new Error('The pending sync changes file cannot be read; restart Pipette and try again')
  }
  if (cancelled.length === 0 && !matchesHeld && !options.writeAlways) return

  const kept = snapshotKeeping((unit) => !cancels(unit))
  pendingPersistence?.writeNow(kept)

  for (const unit of cancelled) {
    syncRuntime.pendingChanges.delete(unit)
    syncRuntime.pendingGeneration.delete(unit)
  }
  syncRuntime.heldPending = new Map(Object.entries(kept.held).map(([sub, units]) => [sub, new Set(units)]))
  afterPendingChange()
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
