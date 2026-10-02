// SPDX-License-Identifier: GPL-2.0-or-later
// The one check every sync entry point runs before it downloads, uploads
// or deletes anything on Google Drive: no sync while a sync password
// change is in progress, on this machine or on another one.
//
// - This machine: a local password-change state file (any step, even an
//   unreadable one) blocks every entry point. Only the password-change
//   operations themselves (sync-password-change.ts) run then, and they do
//   not call this guard.
// - Another machine: a password-change lock in the Drive listing blocks.
//   Our own lock can only exist while our local state does, and that
//   already blocks, so every lock seen here belongs to someone else (or is
//   a lock this machine failed to release and no longer tracks).

import { listFiles, isPasswordChangeLockFile, PASSWORD_CHANGE_LOCK_FILE, type DriveFile } from './google-drive'
import { hasChangeState } from './sync-password-change-state'
import { emitProgress } from './sync-runtime-state'
import { syncBlockI18nKey, type SyncBlockReason, type SyncDirection } from '../../shared/types/sync'

export class SyncBlockedError extends Error {
  readonly reason: SyncBlockReason
  constructor(reason: SyncBlockReason) {
    super(syncBlockI18nKey(reason))
    this.name = 'SyncBlockedError'
    this.reason = reason
  }
}

/** `blockedLocal` while this machine has a password-change state; no Drive access. */
export async function localSyncBlock(): Promise<SyncBlockReason | null> {
  return (await hasChangeState()) ? 'blockedLocal' : null
}

/** Throws `SyncBlockedError` while this machine has a password-change
 *  state. Entry points call it before their first Drive listing. */
export async function assertNoLocalPasswordChange(): Promise<void> {
  const reason = await localSyncBlock()
  if (reason) throw new SyncBlockedError(reason)
}

/** `blockedByOtherDevice` when `listing` contains a password-change lock. */
export function remoteSyncBlock(listing: DriveFile[]): SyncBlockReason | null {
  return listing.some((file) => isPasswordChangeLockFile(file.name)) ? 'blockedByOtherDevice' : null
}

/** The local check, then the lock check against `listing` (an unfiltered
 *  appData listing the caller already has) or, without one, a lock-only
 *  listing. Null when syncing may go ahead. */
export async function getSyncBlock(listing?: DriveFile[]): Promise<SyncBlockReason | null> {
  const local = await localSyncBlock()
  if (local) return local
  return remoteSyncBlock(listing ?? (await listFiles({ nameContains: PASSWORD_CHANGE_LOCK_FILE })))
}

/** `getSyncBlock` that throws `SyncBlockedError` instead of returning a reason. */
export async function assertSyncAllowed(listing?: DriveFile[]): Promise<void> {
  const reason = await getSyncBlock(listing)
  if (reason) throw new SyncBlockedError(reason)
}

/** Reports a blocked sync pass as a terminal `error` progress event whose
 *  message is the reason's i18n key. */
export function emitSyncBlocked(direction: SyncDirection, reason: SyncBlockReason): void {
  emitProgress({ direction, status: 'error', message: syncBlockI18nKey(reason) })
}
