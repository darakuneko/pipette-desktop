// SPDX-License-Identifier: GPL-2.0-or-later
// Entry points of the resumable sync password change: start, resume,
// revert, startup recovery, status for the renderer, and deleting files
// that open with neither password. The re-encryption itself lives in
// sync-password-switch.ts; local keys and progress in
// sync-password-change-state.ts; the Drive lock in sync-password-lock.ts.
//
// Every entry point that touches Drive holds `syncRuntime.isSyncing` until
// all of its work has settled, so no other sync runs alongside it.

import { randomUUID } from 'node:crypto'
import { log } from '../logger'
import { getMachineHash } from '../typing-analytics/machine-hash'
import { listFiles, deleteFile, isDataFileName } from './google-drive'
import { syncRuntime } from './sync-runtime-state'
import {
  requireSyncCredentials,
  SyncCredentialError,
  PasswordMismatchError,
  findPasswordCheck,
} from './sync-password'
import { acquirePasswordChangeLock, findOwnPasswordChangeLock, releasePasswordChangeLock } from './sync-password-lock'
import {
  clearChangeKeys,
  clearChangeState,
  readChangeState,
  retrieveChangeKeys,
  storeChangeKeys,
  writeChangeState,
  type PasswordChangeKeys,
  type PasswordChangeState,
} from './sync-password-change-state'
import {
  PasswordChangeError,
  cleanupChange,
  clearLocalChange,
  fileOpensWith,
  isOwnLockHeld,
  readFileKeyState,
  runPasswordSwitch,
} from './sync-password-switch'
import type { PasswordChangeStatus } from '../../shared/types/sync'

/** Holds `isSyncing` for the whole operation and publishes it as
 *  `passwordChangeRun`, so the before-quit handler can wait for it.
 *  Analytics syncs (sync-analytics.ts) don't take `isSyncing`, so running
 *  ones (`analyticsSyncingUids`) are checked separately; they don't start
 *  while `passwordChangeRun` is set. */
async function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  if (syncRuntime.isSyncing || syncRuntime.analyticsSyncingUids.size > 0) throw new Error('sync.changePasswordInProgress')
  syncRuntime.isSyncing = true
  const run = fn()
  syncRuntime.passwordChangeRun = run.then(
    () => undefined,
    () => undefined,
  )
  try {
    return await run
  } finally {
    syncRuntime.isSyncing = false
    syncRuntime.passwordChangeRun = null
  }
}

async function loadState(): Promise<PasswordChangeState> {
  const read = await readChangeState()
  if (read.kind === 'none') throw new PasswordChangeError('sync.passwordChange.notInProgress')
  if (read.kind === 'invalid') throw new PasswordChangeError('sync.passwordChange.invalidState')
  return read.state
}

async function loadKeys(): Promise<PasswordChangeKeys> {
  const keys = await retrieveChangeKeys()
  if (!keys.ok) throw new PasswordChangeError('sync.passwordChange.keysUnavailable')
  return keys.keys
}

/** Removes our lock if Drive has it (found by `lockId` when `lockFileId`
 *  was never saved), then forgets the change. When the removal fails the
 *  local state stays, so the lock can still be found later. */
async function abandonLocking(state: PasswordChangeState): Promise<void> {
  const fileId = state.lockFileId ?? (await findOwnPasswordChangeLock(state.lockId))
  if (fileId) await releasePasswordChangeLock(fileId)
  await clearLocalChange()
}

function lockFailure(reason: 'locked' | 'lost'): PasswordChangeError {
  return new PasswordChangeError(reason === 'locked' ? 'sync.passwordChange.locked' : 'sync.passwordChange.lost')
}

/** Takes the Drive lock for `state`, recording the new file id in the
 *  state as soon as Drive creates it. */
async function acquireLockFor(
  state: PasswordChangeState,
): Promise<{ state: PasswordChangeState; result: Awaited<ReturnType<typeof acquirePasswordChangeLock>> }> {
  let current = state
  const result = await acquirePasswordChangeLock(
    { lockId: state.lockId, machineHash: await getMachineHash(), startedAt: new Date(state.startedAt).toISOString() },
    {
      onCreated: async (fileId) => {
        current = { ...state, lockFileId: fileId }
        await writeChangeState(current)
      },
    },
  )
  return { state: current, result }
}

/** Before resuming: keep our lock if we still hold it; if it is gone and
 *  no other lock exists, take a new one; if another machine's lock exists,
 *  fail with `locked` and leave the state as it is. */
async function holdLockForRun(state: PasswordChangeState): Promise<PasswordChangeState> {
  if (!(await isOwnLockHeld(state))) {
    const acquired = await acquireLockFor(state)
    if (!acquired.result.ok) throw lockFailure(acquired.result.reason)
    state = { ...acquired.state, lockFileId: acquired.result.fileId }
    await writeChangeState(state)
  }
  syncRuntime.passwordChangeLockLost = false
  return state
}

/** Starts changing the sync password to `newPassword`: saves the progress
 *  and both passwords locally, takes the Drive lock, then runs the switch.
 *  A failure after the lock is taken leaves the change at `reencrypting`
 *  for `resumePasswordChange` / `revertPasswordChange`. */
export async function startPasswordChange(newPassword: string): Promise<void> {
  await withSyncLock(async () => {
    if ((await readChangeState()).kind !== 'none') throw new PasswordChangeError('sync.passwordChange.alreadyInProgress')
    const credentials = await requireSyncCredentials()
    if (!credentials.ok) throw new SyncCredentialError(credentials.reason)
    const oldPassword = credentials.password
    if (newPassword === oldPassword) throw new Error('sync.samePassword')
    // A missing password-check is created at commit.
    const check = findPasswordCheck(await listFiles())
    if (check && !(await fileOpensWith(check, oldPassword))) throw new PasswordMismatchError()

    // State before keys: keys without a state file are removed at startup,
    // while a state without keys can still be abandoned.
    let state: PasswordChangeState = { version: 1, target: 'new', step: 'locking', lockId: randomUUID(), startedAt: Date.now() }
    await writeChangeState(state)
    const keys = { oldPassword, newPassword }
    try {
      await storeChangeKeys(keys)
    } catch (err) {
      await clearChangeState()
      throw err
    }
    syncRuntime.passwordChangeLockLost = false

    // When undoing the lock attempt fails, the `locking` state stays for
    // startup recovery to remove the lock.
    const undoLocking = (s: PasswordChangeState): Promise<void> =>
      abandonLocking(s).catch((err: unknown) => {
        log('warn', `sync password change: cannot undo the lock attempt: ${String(err)}`)
      })
    let acquired: Awaited<ReturnType<typeof acquireLockFor>>
    try {
      acquired = await acquireLockFor(state)
    } catch (err) {
      await undoLocking(state)
      throw err
    }
    state = acquired.state
    if (!acquired.result.ok) {
      await undoLocking(state)
      throw lockFailure(acquired.result.reason)
    }

    state = { ...state, lockFileId: acquired.result.fileId, step: 'reencrypting' }
    await writeChangeState(state)
    await runPasswordSwitch(state, keys)
  })
}

/** Continues an interrupted change (or rollback) in its current direction.
 *  `locking` and `cleanup` need no keys. */
export async function resumePasswordChange(): Promise<void> {
  await withSyncLock(async () => {
    const state = await loadState()
    if (state.step === 'locking') {
      await abandonLocking(state)
      throw new PasswordChangeError('sync.passwordChange.notStarted')
    }
    if (state.step === 'cleanup') {
      await cleanupChange(state)
      return
    }
    const keys = await loadKeys()
    await runPasswordSwitch(await holdLockForRun(state), keys)
  })
}

/** Turns an interrupted change around (`'new'` → `'old'`, or back) and
 *  runs it. Only while re-encrypting: from `committing` on, the change
 *  finishes and a new change is the way back. */
export async function revertPasswordChange(): Promise<void> {
  await withSyncLock(async () => {
    const state = await loadState()
    if (state.step !== 'reencrypting') throw new PasswordChangeError('sync.passwordChange.wrongStep')
    const keys = await loadKeys()
    const held = await holdLockForRun(state)
    const reverted: PasswordChangeState = { ...held, target: held.target === 'new' ? 'old' : 'new' }
    await writeChangeState(reverted)
    await runPasswordSwitch(reverted, keys)
  })
}

/** Gives up a change without the keys: releases our lock (best effort)
 *  and removes the local keys and state. Drive files stay on whichever key
 *  they are on, so they may stay mixed. For when the keys can't be read or
 *  the password-check opens with neither key. */
export async function abandonPasswordChange(): Promise<void> {
  await withSyncLock(async () => {
    const read = await readChangeState()
    if (read.kind === 'none') throw new PasswordChangeError('sync.passwordChange.notInProgress')
    if (read.kind === 'ok') {
      try {
        const fileId = read.state.lockFileId ?? (await findOwnPasswordChangeLock(read.state.lockId))
        if (fileId) await releasePasswordChangeLock(fileId)
      } catch (err) {
        log('warn', `sync password change: cannot release the lock while abandoning: ${String(err)}`)
      }
    }
    await clearLocalChange()
  })
}

export interface DeleteUndecryptableResult {
  deleted: string[]
  /** Ids that are not data files on Drive or open with one of the keys. */
  skipped: string[]
}

/** Deletes the given Drive files, each only after re-checking that it
 *  still opens with neither password. Only while re-encrypting and while
 *  this machine holds the lock. */
export async function deletePasswordChangeUndecryptableFiles(fileIds: string[]): Promise<DeleteUndecryptableResult> {
  return withSyncLock(async () => {
    const state = await loadState()
    if (state.step !== 'reencrypting') throw new PasswordChangeError('sync.passwordChange.wrongStep')
    const keys = await loadKeys()
    await holdLockForRun(state)

    const dataFiles = new Map((await listFiles()).filter((f) => isDataFileName(f.name)).map((f) => [f.id, f]))
    const result: DeleteUndecryptableResult = { deleted: [], skipped: [] }
    for (const id of fileIds) {
      const file = dataFiles.get(id)
      if (file && (await readFileKeyState(file, keys, state.target)).kind === 'neither') {
        await deleteFile(id)
        result.deleted.push(id)
      } else {
        result.skipped.push(id)
      }
    }
    const remaining = syncRuntime.passwordChangeUndecryptable?.filter((f) => !result.deleted.includes(f.id))
    syncRuntime.passwordChangeUndecryptable = remaining && remaining.length > 0 ? remaining : null
    return result
  })
}

export type PasswordChangeRecovery =
  | 'none'
  | 'invalid'
  | 'busy'
  | 'abandoned'
  | 'awaitingUser'
  | 'lockLost'
  | 'keysUnavailable'
  | 'completed'
  | 'failed'

/** Run once at startup. No state: keys left by a start that never wrote
 *  its state are removed. `locking`: the change never started, so our lock
 *  is removed and the change forgotten. `reencrypting`: waits for the
 *  user's resume / revert, and reports `lockLost` when our lock is gone.
 *  `committing` / `cleanup`: finished automatically. Errors are logged, not
 *  thrown; the state stays for the next attempt. */
export async function recoverPasswordChangeOnStartup(): Promise<PasswordChangeRecovery> {
  try {
    const read = await readChangeState()
    if (read.kind === 'none') {
      await clearChangeKeys()
      return 'none'
    }
    if (read.kind === 'invalid') {
      log('warn', 'sync password change: state file is unreadable; Drive files are left as they are')
      return 'invalid'
    }
    if (syncRuntime.isSyncing || syncRuntime.analyticsSyncingUids.size > 0) return 'busy'
    const state = read.state
    return await withSyncLock(async (): Promise<PasswordChangeRecovery> => {
      if (state.step === 'locking') {
        await abandonLocking(state)
        return 'abandoned'
      }
      if (state.step === 'reencrypting') {
        if (await isOwnLockHeld(state)) return 'awaitingUser'
        syncRuntime.passwordChangeLockLost = true
        log('warn', 'sync password change: this machine no longer holds the Drive lock')
        return 'lockLost'
      }
      if (state.step === 'cleanup') {
        await cleanupChange(state)
        return 'completed'
      }
      const keys = await retrieveChangeKeys()
      if (!keys.ok) {
        log('warn', `sync password change: cannot read the change keys (${keys.reason})`)
        return 'keysUnavailable'
      }
      await runPasswordSwitch(await holdLockForRun(state), keys.keys)
      return 'completed'
    })
  } catch (err) {
    log('error', `sync password change: startup recovery failed: ${err instanceof Error ? err.message : String(err)}`)
    return 'failed'
  }
}

/** Renderer-safe progress of a password change: no passwords, no lock ids. */
export async function getPasswordChangeStatus(): Promise<PasswordChangeStatus> {
  const read = await readChangeState()
  if (read.kind === 'none') return { kind: 'none' }
  if (read.kind === 'invalid') return { kind: 'invalid' }
  const { target, step, startedAt } = read.state
  const keys = await retrieveChangeKeys()
  if (!keys.ok) return { kind: 'keysUnavailable', reason: keys.reason, target, step, startedAt }
  const undecryptable = syncRuntime.passwordChangeUndecryptable
  return {
    kind: 'inProgress',
    target,
    step,
    startedAt,
    ...(syncRuntime.passwordChangeLockLost ? { lockLost: true as const } : {}),
    ...(undecryptable ? { undecryptable: undecryptable.map((f) => ({ ...f })) } : {}),
  }
}
