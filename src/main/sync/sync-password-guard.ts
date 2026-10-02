// SPDX-License-Identifier: GPL-2.0-or-later
// The one check every sync entry point runs before it downloads, uploads
// or deletes anything on Google Drive: no sync while a sync password
// change is in progress, on this machine or on another one, and none while
// Drive needs a newer sync format than this app supports.
//
// - This machine: a local password-change state file (any step, even an
//   unreadable one) blocks every entry point. Only the password-change
//   operations themselves (sync-password-change.ts) run then, and they do
//   not call this guard.
// - Another machine: a password-change lock in the Drive listing blocks.
//   Our own lock can only exist while our local state does, and that
//   already blocks, so every lock seen here belongs to someone else (or is
//   a lock this machine failed to release and no longer tracks).
// - Sync format: a `sync-format-v{n}.json` marker with `n` above
//   SYNC_FORMAT_VERSION in the Drive listing blocks (`updateRequired`,
//   sync-format.ts).

import { listFiles, isPasswordChangeLockFile, PASSWORD_CHANGE_LOCK_FILE, type DriveFile } from './google-drive'
import { isSyncFormatUpdateRequired, listSyncFormatFiles } from './sync-format'
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

/** `updateRequired` when `listing` contains a sync-format marker newer
 *  than this app's, otherwise `blockedByOtherDevice` when it contains a
 *  password-change lock. The format comes first: finishing a password
 *  change would not let this app sync. */
export function remoteSyncBlock(listing: DriveFile[]): SyncBlockReason | null {
  if (isSyncFormatUpdateRequired(listing)) return 'updateRequired'
  return listing.some((file) => isPasswordChangeLockFile(file.name)) ? 'blockedByOtherDevice' : null
}

/** The files `remoteSyncBlock` looks at, via two narrow listings (the
 *  lock and the sync-format markers), for entry points without an
 *  unfiltered listing. Also usable as `ensureSyncFormatMarker`'s listing. */
export async function listGuardFiles(): Promise<DriveFile[]> {
  const [locks, markers] = await Promise.all([
    listFiles({ nameContains: PASSWORD_CHANGE_LOCK_FILE }),
    listSyncFormatFiles(),
  ])
  return [...locks, ...markers]
}

/** The local check, then the remote check against `listing` (an
 *  unfiltered appData listing the caller already has) or, without one,
 *  `listGuardFiles`. Null when syncing may go ahead. */
export async function getSyncBlock(listing?: DriveFile[]): Promise<SyncBlockReason | null> {
  const local = await localSyncBlock()
  if (local) return local
  return remoteSyncBlock(listing ?? (await listGuardFiles()))
}

/** `getSyncBlock` that throws `SyncBlockedError` instead of returning a reason. */
export async function assertSyncAllowed(listing?: DriveFile[]): Promise<void> {
  const reason = await getSyncBlock(listing)
  if (reason) throw new SyncBlockedError(reason)
}

/** Throws `SyncBlockedError('updateRequired')` when `listing` (any listing
 *  that includes the markers; without one, a markers-only listing) holds
 *  a sync-format marker newer than this app's. For the password-change
 *  operations, which do not run the full guard. */
export async function assertSyncFormatSupported(listing?: DriveFile[]): Promise<void> {
  if (isSyncFormatUpdateRequired(listing ?? (await listSyncFormatFiles()))) {
    throw new SyncBlockedError('updateRequired')
  }
}

/** Reports a blocked sync pass as a terminal `error` progress event whose
 *  message is the reason's i18n key. */
export function emitSyncBlocked(direction: SyncDirection, reason: SyncBlockReason): void {
  emitProgress({ direction, status: 'error', message: syncBlockI18nKey(reason) })
}
