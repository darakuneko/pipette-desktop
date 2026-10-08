// SPDX-License-Identifier: GPL-2.0-or-later
// Sync lock for the reset and delete handlers (sync-reset-ipc.ts), so no
// sync pass writes the files a reset is removing.

import { syncRuntime, tryClaimSyncLock } from './sync-runtime-state'

export const RESET_BUSY_MESSAGE = 'Cannot reset while sync is in progress'

/** Keyboards whose data a reset removes: every keyboard, the listed uids,
 *  or none (a reset of favorites, packs or app settings only). */
export type ResetKeyboards = 'all' | readonly string[] | null

/** True while a writer that doesn't take the sync lock (an analytics sync or
 *  a remote day fetch) runs for one of `keyboards` (any keyboard for
 *  `'all'`). */
function keyboardWriterRunning(keyboards: ResetKeyboards): boolean {
  const { analyticsSyncingUids, remoteTypingDayFetches } = syncRuntime
  if (keyboards === null) return false
  if (keyboards === 'all') return analyticsSyncingUids.size > 0 || remoteTypingDayFetches.size > 0
  return keyboards.some((uid) => analyticsSyncingUids.has(uid) || remoteTypingDayFetches.has(uid))
}

/** True while the running reset removes `uid`'s data. Analytics syncs and
 *  remote day fetches check it before their first await. */
export function resetHoldsKeyboard(uid: string): boolean {
  const held = syncRuntime.resetKeyboards
  return held === 'all' || (held !== null && held.has(uid))
}

/** Runs `fn` holding the sync lock as a waitable holder, with
 *  `resetKeyboards` set to `keyboards`. Throws `busyMessage` instead when
 *  the lock is held or an analytics sync / remote day fetch of one of
 *  `keyboards` runs. The checks and the claim happen before the first
 *  await, as do those writers' `resetHoldsKeyboard` checks
 *  (sync-analytics.ts, sync-typing-remote.ts), so the two never overlap.
 *  Polls skip and flushes wait while the lock is held; executeSync waits for
 *  the reset to end (sync-execute.ts). */
export async function withResetLock<T>(
  keyboards: ResetKeyboards,
  fn: () => Promise<T>,
  busyMessage = RESET_BUSY_MESSAGE,
): Promise<T> {
  if (keyboardWriterRunning(keyboards)) throw new Error(busyMessage)
  const releaseLock = tryClaimSyncLock({ waitable: true })
  if (!releaseLock) throw new Error(busyMessage)
  syncRuntime.resetKeyboards = keyboards === 'all' ? 'all' : keyboards?.length ? new Set(keyboards) : null
  try {
    return await fn()
  } finally {
    syncRuntime.resetKeyboards = null
    releaseLock()
  }
}
