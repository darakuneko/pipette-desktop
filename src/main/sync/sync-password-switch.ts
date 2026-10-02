// SPDX-License-Identifier: GPL-2.0-or-later
// The switch run of a sync password change: re-encrypt every remote file
// towards `state.target`, then commit (password-check + stored password)
// and clean up. The same run serves a change (`target: 'new'`) and a
// rollback (`target: 'old'`); every step is safe to repeat after an
// interruption, because each file is judged by which key opens it.
//
// Callers (sync-password-change.ts) hold `syncRuntime.isSyncing` around
// `runPasswordSwitch`.

import { encrypt, decrypt, storePassword } from './sync-crypto'
import {
  listFiles,
  downloadRawFile,
  uploadFile,
  deleteFile,
  driveFileName,
  isDataFileName,
  PASSWORD_CHECK_UNIT,
  type DriveFile,
} from './google-drive'
import { runConcurrently } from '../../shared/concurrency'
import { SYNC_CONCURRENCY, syncRuntime } from './sync-runtime-state'
import { isPasswordChangeLockHeld, releasePasswordChangeLock } from './sync-password-lock'
import {
  clearChangeKeys,
  clearChangeState,
  writeChangeState,
  type PasswordChangeKeys,
  type PasswordChangeState,
} from './sync-password-change-state'
import {
  PasswordMismatchError,
  findPasswordCheck,
  listedPasswordChecks,
  resetPasswordCheckCache,
  writePasswordCheck,
} from './sync-password'
import type { SyncEnvelope } from '../../shared/types/sync'

/** `chunkSize`: files per batch; the lock is re-checked before each batch.
 *  `maxPasses`: passes over Drive before giving up while files keep
 *  needing conversion (another machine writing with a stale key).
 *  Exported so tests can shrink them. */
export const passwordChangeTuning = {
  chunkSize: 50,
  maxPasses: 3,
}

type PasswordChangeErrorKey =
  | 'sync.passwordChange.alreadyInProgress'
  | 'sync.passwordChange.notInProgress'
  | 'sync.passwordChange.invalidState'
  | 'sync.passwordChange.keysUnavailable'
  | 'sync.passwordChange.wrongStep'
  | 'sync.passwordChange.notStarted'
  | 'sync.passwordChange.locked'
  | 'sync.passwordChange.lost'
  | 'sync.passwordChange.lockLost'
  | 'sync.passwordChange.interrupted'
  | 'sync.passwordChange.undecryptable'
  | 'sync.passwordChange.notConverged'

/** The message is an i18n key, returned to the renderer as is. */
export class PasswordChangeError extends Error {
  constructor(key: PasswordChangeErrorKey) {
    super(key)
    this.name = 'PasswordChangeError'
  }
}

function keyFor(keys: PasswordChangeKeys, target: PasswordChangeState['target']): string {
  return target === 'new' ? keys.newPassword : keys.oldPassword
}

function otherKey(keys: PasswordChangeKeys, target: PasswordChangeState['target']): string {
  return target === 'new' ? keys.oldPassword : keys.newPassword
}

/** Removes the local keys and state file. Drive is not touched. */
export async function clearLocalChange(): Promise<void> {
  await clearChangeKeys()
  await clearChangeState()
  syncRuntime.passwordChangeUndecryptable = null
  syncRuntime.passwordChangeLockLost = false
}

export async function isOwnLockHeld(state: PasswordChangeState): Promise<boolean> {
  return state.lockFileId !== undefined && (await isPasswordChangeLockHeld(state.lockFileId))
}

/** Our Drive lock is gone (e.g. another PC released it) or another lock is
 *  earlier: stop writing. Keys and state stay, so the change can be resumed
 *  (taking a new lock) or abandoned; the status reports `lockLost`. */
async function ensureLockHeld(state: PasswordChangeState): Promise<void> {
  if (await isOwnLockHeld(state)) return
  syncRuntime.passwordChangeLockLost = true
  throw new PasswordChangeError('sync.passwordChange.lockLost')
}

/** Plaintext and sync unit of a downloaded envelope, or null when it is
 *  not a valid envelope or `password` does not open it. */
async function openEnvelope(raw: string, password: string): Promise<{ plaintext: string; syncUnit: string } | null> {
  try {
    const envelope = JSON.parse(raw) as SyncEnvelope
    return { plaintext: await decrypt(envelope, password), syncUnit: envelope.syncUnit }
  } catch {
    return null
  }
}

/** Whether `password` opens the downloaded `file`. */
export async function fileOpensWith(file: DriveFile, password: string): Promise<boolean> {
  return (await openEnvelope(await downloadRawFile(file.id), password)) !== null
}

type FileKeyState =
  | { kind: 'target' }
  | { kind: 'other'; plaintext: string; syncUnit: string }
  | { kind: 'neither' }

/** Downloads `file` and reports which key opens it. A download failure
 *  throws; only a failed decrypt (or a malformed envelope) is `neither`.
 *  `otherFirst` tries the other key first: each wrong try costs a full
 *  PBKDF2 derivation, so the likelier key goes first. */
export async function readFileKeyState(
  file: DriveFile,
  keys: PasswordChangeKeys,
  target: PasswordChangeState['target'],
  otherFirst = false,
): Promise<FileKeyState> {
  const raw = await downloadRawFile(file.id)
  const openTarget = (): Promise<boolean> => openEnvelope(raw, keyFor(keys, target)).then((opened) => opened !== null)
  if (!otherFirst && (await openTarget())) return { kind: 'target' }
  const opened = await openEnvelope(raw, otherKey(keys, target))
  if (opened) return { kind: 'other', ...opened }
  return otherFirst && (await openTarget()) ? { kind: 'target' } : { kind: 'neither' }
}

type FileOutcome = { kind: 'target' | 'neither' } | { kind: 'converted'; modifiedTime: string }

async function convertFile(
  file: DriveFile,
  keys: PasswordChangeKeys,
  target: PasswordChangeState['target'],
  otherFirst: boolean,
): Promise<FileOutcome> {
  const keyState = await readFileKeyState(file, keys, target, otherFirst)
  if (keyState.kind !== 'other') return { kind: keyState.kind }
  const envelope = await encrypt(keyState.plaintext, keyFor(keys, target), keyState.syncUnit)
  const uploaded = await uploadFile(file.name, envelope, file.id)
  return { kind: 'converted', modifiedTime: uploaded.modifiedTime }
}

/** Within one run: file id → the Drive `modifiedTime` at which the file was
 *  known to be on the target key (checked, or written by us). A later pass
 *  skips the file while its listed `modifiedTime` still matches; a peer's
 *  write changes it, so the file is checked again. */
type ConfirmedOnTarget = Map<string, string>

/** One pass over every data file. Transfer failures abort the pass after
 *  the started workers settle; the lock is re-checked before each chunk
 *  after the first. */
async function runPass(
  state: PasswordChangeState,
  keys: PasswordChangeKeys,
  listed: DriveFile[],
  confirmed: ConfirmedOnTarget,
  otherFirst: boolean,
): Promise<{ converted: number; undecryptable: DriveFile[] }> {
  let converted = 0
  const undecryptable: DriveFile[] = []
  const files = listed.filter((f) => confirmed.get(f.id) !== f.modifiedTime)
  for (let start = 0; start < files.length; start += passwordChangeTuning.chunkSize) {
    if (syncRuntime.isQuitting) throw new PasswordChangeError('sync.passwordChange.interrupted')
    // The caller checked the lock right before the first chunk.
    if (start > 0) await ensureLockHeld(state)
    const chunk = files.slice(start, start + passwordChangeTuning.chunkSize)
    const result = await runConcurrently(chunk, SYNC_CONCURRENCY, (file) => convertFile(file, keys, state.target, otherFirst), {
      shouldStop: () => syncRuntime.isQuitting,
    })
    if (result.errors.length > 0) throw result.errors[0].error
    if (result.stopped) throw new PasswordChangeError('sync.passwordChange.interrupted')
    result.results.forEach((outcome, i) => {
      const file = chunk[i]
      if (outcome?.kind === 'target') confirmed.set(file.id, file.modifiedTime)
      else if (outcome?.kind === 'converted') {
        converted++
        confirmed.set(file.id, outcome.modifiedTime)
      } else if (outcome?.kind === 'neither') undecryptable.push(file)
    })
  }
  return { converted, undecryptable }
}

/** Repeats passes until one finds every file already on the target key
 *  (a pass that skips every file counts), so files another machine wrote
 *  back with the other key are picked up. */
async function reencryptAll(state: PasswordChangeState, keys: PasswordChangeKeys): Promise<void> {
  const confirmed: ConfirmedOnTarget = new Map()
  let otherFirst = false
  for (let pass = 0; pass < passwordChangeTuning.maxPasses; pass++) {
    // Checked on every pass, also one that ends up skipping every file.
    if (syncRuntime.isQuitting) throw new PasswordChangeError('sync.passwordChange.interrupted')
    await ensureLockHeld(state)
    const listed = await listFiles()
    if (pass === 0) {
      // Mid-change the password-check may be on either key; a third key
      // means another machine changed the password, so nothing is written.
      // Data files most likely share the password-check's key, so the first
      // pass tries that key first; later passes mostly see target-key files.
      const check = findPasswordCheck(listed)
      const checkState = check ? await readFileKeyState(check, keys, state.target) : null
      if (checkState?.kind === 'neither') throw new PasswordMismatchError()
      otherFirst = checkState?.kind === 'other'
    } else {
      otherFirst = false
    }
    const dataFiles = listed.filter((f) => isDataFileName(f.name))
    const { converted, undecryptable } = await runPass(state, keys, dataFiles, confirmed, otherFirst)
    if (undecryptable.length > 0) {
      syncRuntime.passwordChangeUndecryptable = undecryptable.map(({ id, name }) => ({ id, name }))
      throw new PasswordChangeError('sync.passwordChange.undecryptable')
    }
    syncRuntime.passwordChangeUndecryptable = null
    if (converted === 0) return
  }
  throw new PasswordChangeError('sync.passwordChange.notConverged')
}

/** Every data file is on the target key: point the password-check and the
 *  stored password at it too. The lock is not re-checked between these
 *  writes — stopping halfway would leave data and password-check on
 *  different keys. */
async function commit(state: PasswordChangeState, keys: PasswordChangeKeys): Promise<void> {
  const password = keyFor(keys, state.target)
  const checks = listedPasswordChecks(await listFiles({ nameContains: driveFileName(PASSWORD_CHECK_UNIT) }))
  const written = await writePasswordCheck(password, findPasswordCheck(checks)?.id)
  // Extra password-checks (from two machines creating one at once) would
  // still open with the other key; only the one just written is kept.
  for (const extra of checks) {
    if (extra.id !== written.id) await deleteFile(extra.id)
  }
  await storePassword(password)
  resetPasswordCheckCache()
}

export async function cleanupChange(state: PasswordChangeState): Promise<void> {
  if (state.lockFileId) await releasePasswordChangeLock(state.lockFileId)
  await clearLocalChange()
}

function isNotConvergedError(err: unknown): boolean {
  return (
    err instanceof PasswordChangeError &&
    (err.message === 'sync.passwordChange.undecryptable' || err.message === 'sync.passwordChange.notConverged')
  )
}

/** Runs the remaining steps from `initial.step`, whose lock the caller
 *  holds. A failure before `committing` leaves the state at `reencrypting`
 *  for a resume or revert. `committing` re-runs the passes first, so every
 *  data file is confirmed on the target key (and the lock held) before the
 *  password-check moves. */
export async function runPasswordSwitch(initial: PasswordChangeState, keys: PasswordChangeKeys): Promise<void> {
  let state = initial
  if (state.step === 'reencrypting' || state.step === 'committing') {
    try {
      await reencryptAll(state, keys)
    } catch (err) {
      // The pre-commit check found files to fix: back to `reencrypting`,
      // where deleting undecryptable files and reverting are allowed.
      if (state.step === 'committing' && isNotConvergedError(err)) {
        await writeChangeState({ ...state, step: 'reencrypting' })
      }
      throw err
    }
    if (state.step === 'reencrypting') {
      state = { ...state, step: 'committing' }
      await writeChangeState(state)
    }
  }
  if (state.step === 'committing') {
    await commit(state, keys)
    state = { ...state, step: 'cleanup' }
    await writeChangeState(state)
  }
  if (state.step === 'cleanup') await cleanupChange(state)
}
