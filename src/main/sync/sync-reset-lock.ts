// SPDX-License-Identifier: GPL-2.0-or-later
// Sync lock for the reset and delete handlers (sync-reset-ipc.ts) and the
// typing-data import (sync-ipc.ts), so no sync pass writes the files they
// are removing or replacing.

import {
  claimSyncLockWhenIdleBy,
  lockFreeWriterRunning,
  syncRuntime,
  tryClaimSyncLock,
  type ResetKeyboards,
} from './sync-runtime-state'

/** Busy messages; each is an i18n key (the renderer shows `t(error, error)`). */
export const RESET_BUSY_MESSAGE = 'sync.resetBusy'
export const DELETE_BUSY_MESSAGE = 'sync.deleteBusy'
export const IMPORT_BUSY_MESSAGE = 'sync.importBusy'

/** How long `withResetLockWhenFree` waits for running sync work. */
export const RESET_LOCK_WAIT_MS = 30_000

function heldKeyboards(keyboards: ResetKeyboards): typeof syncRuntime.resetKeyboards {
  return keyboards === 'all' ? 'all' : keyboards?.length ? new Set(keyboards) : null
}

/** Runs `fn` holding the sync lock as a waitable holder, with
 *  `resetKeyboards` set to `keyboards`. Throws `busyMessage` instead when
 *  the lock is held or an analytics sync / remote day fetch of one of
 *  `keyboards` runs. The checks and the claim happen before the first
 *  await, as do those writers' `lockFreeWriterBlocked` checks (defined in
 *  sync-runtime-state.ts, checked in sync-analytics.ts and
 *  sync-typing-remote.ts), so the two never overlap.
 *  Polls skip and flushes wait while the lock is held; executeSync waits for
 *  the reset to end (sync-execute.ts). */
export async function withResetLock<T>(
  keyboards: ResetKeyboards,
  fn: () => Promise<T>,
  busyMessage = RESET_BUSY_MESSAGE,
): Promise<T> {
  if (lockFreeWriterRunning(keyboards)) throw new Error(busyMessage)
  const releaseLock = tryClaimSyncLock({ waitable: true })
  if (!releaseLock) throw new Error(busyMessage)
  syncRuntime.resetKeyboards = heldKeyboards(keyboards)
  return holdingResetLock(releaseLock, fn)
}

/** `withResetLock` for an action the user starts while a poll or a flush
 *  may hold the lock for a few seconds: instead of refusing at once, waits
 *  up to `RESET_LOCK_WAIT_MS` for the lock, then sets `resetKeyboards` (so
 *  no new analytics sync or remote day fetch of `keyboards` starts) and
 *  waits, within the same deadline, for the running ones of `keyboards`
 *  to end. Throws `busyMessage` when the deadline passes first. */
export async function withResetLockWhenFree<T>(
  keyboards: ResetKeyboards,
  fn: () => Promise<T>,
  busyMessage: string,
): Promise<T> {
  const { release, idle } = await claimSyncLockWhenIdleBy(Date.now() + RESET_LOCK_WAIT_MS, {
    running: () => lockFreeWriterRunning(keyboards),
    onClaimed: () => {
      syncRuntime.resetKeyboards = heldKeyboards(keyboards)
    },
  })
  if (!release) throw new Error(busyMessage)
  return holdingResetLock(release, async () => {
    if (!idle) throw new Error(busyMessage)
    return fn()
  })
}

/** Runs `fn`, then clears `resetKeyboards` and releases the lock, whether
 *  or not `fn` throws. */
async function holdingResetLock<T>(releaseLock: () => void, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } finally {
    syncRuntime.resetKeyboards = null
    releaseLock()
  }
}
