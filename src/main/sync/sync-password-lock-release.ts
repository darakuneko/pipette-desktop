// SPDX-License-Identifier: GPL-2.0-or-later
// Reading and force-removing the password-change lock from a machine that
// has no password change of its own. When the machine holding the lock
// broke or never comes back, every other machine stays blocked by the
// sync guard (sync-password-guard.ts); removing the lock is the only way
// out, so neither function here runs the guard's Drive lock check
// (`assertSyncAllowed` / `getSyncBlock`). Releasing still runs its local
// check, `assertNoLocalPasswordChange`, and the sync-format check
// (`assertSyncFormatSupported`): an app too old for Drive's data leaves
// the lock to an updated one.

import { getMachineHash } from '../typing-analytics/machine-hash'
import { listPasswordChangeLocks, readPasswordChangeLockInfo, releasePasswordChangeLock } from './sync-password-lock'
import { assertNoLocalPasswordChange, assertSyncFormatSupported } from './sync-password-guard'
import { syncRuntime } from './sync-runtime-state'
import type { PasswordChangeLockStatus } from '../../shared/types/sync'

/** The earliest lock on Drive (the one that blocks syncing), or null when
 *  there is none. Read-only. */
export async function getPasswordChangeLockStatus(): Promise<PasswordChangeLockStatus | null> {
  const [holder] = await listPasswordChangeLocks()
  if (!holder) return null
  const info = await readPasswordChangeLockInfo(holder)
  if (!info) return { startedAt: null, ownMachine: false }
  return { startedAt: info.startedAt, ownMachine: info.machineHash === (await getMachineHash()) }
}

/** Deletes every password-change lock on Drive. Refused while this machine
 *  has a password change of its own (its lock is still needed to finish or
 *  revert it), while Drive needs a newer sync format, and while a sync or
 *  password change runs here; holds `isSyncing` so no password change
 *  starts meanwhile. */
export async function releasePasswordChangeLocks(): Promise<void> {
  await assertNoLocalPasswordChange()
  if (syncRuntime.isSyncing || syncRuntime.analyticsSyncingUids.size > 0) {
    throw new Error('sync.passwordChange.releaseBusy')
  }
  syncRuntime.isSyncing = true
  try {
    await assertSyncFormatSupported()
    for (const lock of await listPasswordChangeLocks()) {
      await releasePasswordChangeLock(lock.id)
    }
  } finally {
    syncRuntime.isSyncing = false
  }
}
