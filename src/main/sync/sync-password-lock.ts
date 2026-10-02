// SPDX-License-Identifier: GPL-2.0-or-later
// Unencrypted "password change in progress" lock file in appDataFolder.
// A machine re-encrypting every remote file under a new sync password holds
// this lock so other machines stop syncing until the change is finished or
// rolled back. The file carries no secrets, and is never a sync unit.

import {
  listFiles,
  createRawFile,
  downloadRawFile,
  deleteFile,
  isPasswordChangeLockFile,
  PASSWORD_CHANGE_LOCK_FILE,
  type DriveFile,
} from './google-drive'

const LOCK_TYPE = 'password-change-lock'
const LOCK_VERSION = 1

/** Drive listings are eventually consistent: a just-created file can be
 *  missing from a listing for a moment. `relistDelaysMs` are the waits
 *  before each extra re-list while our own lock is not yet visible;
 *  `settleMs` is the wait before the final re-list once we appear to win,
 *  so a peer lock that becomes visible slightly later is still seen.
 *  Exported so tests can replace the wait. */
export const lockTiming = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  relistDelaysMs: [1000, 2000, 4000] as readonly number[],
  settleMs: 2000,
}

export interface PasswordChangeLock {
  type: typeof LOCK_TYPE
  version: typeof LOCK_VERSION
  /** Random id chosen by the machine that started the change; identifies
   *  its own lock when the Drive file id was never saved locally. */
  lockId: string
  /** `getMachineHash()` (typing-analytics/machine-hash.ts) of the holder. */
  machineHash: string
  /** ISO 8601 time the change started, by the holder's clock. Display
   *  only: lock ordering uses Drive's `createdTime`. */
  startedAt: string
}

export type PasswordChangeLockInfo = Pick<PasswordChangeLock, 'machineHash' | 'startedAt'>

export type AcquirePasswordChangeLockResult =
  | { ok: true; fileId: string }
  /** A lock already existed before ours was created. `holder` is the
   *  earliest one's content, or null when it could not be read. */
  | { ok: false; reason: 'locked'; holder: PasswordChangeLockInfo | null }
  /** Another lock was created around the same time and won; ours was
   *  deleted. */
  | { ok: false; reason: 'lost' }

export interface AcquirePasswordChangeLockOptions {
  /** Called with the new lock's file id before the re-list. The caller
   *  persists it, so a lock this machine fails to delete can be found and
   *  removed later. If it throws, our lock is deleted and the error is
   *  rethrown. */
  onCreated: (fileId: string) => Promise<void>
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** Parses lock file content; null when it is not a valid version-1 lock.
 *  Callers treat null as "a lock whose content is unreadable", not as
 *  "no lock". */
export function parsePasswordChangeLock(text: string): PasswordChangeLock | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const { type, version, lockId, machineHash, startedAt } = parsed as Record<string, unknown>
  if (type !== LOCK_TYPE || version !== LOCK_VERSION) return null
  if (!isNonEmptyString(lockId) || !isNonEmptyString(machineHash) || !isNonEmptyString(startedAt)) return null
  if (Number.isNaN(Date.parse(startedAt))) return null
  return { type, version, lockId, machineHash, startedAt }
}

/** Sort key for the winner rule: earliest Drive `createdTime` first, ties
 *  broken by the smallest file id; a file without a usable `createdTime`
 *  sorts after every timed one. The holder's clock (`startedAt`) is not
 *  used, so a machine that created its lock alone, earlier, always wins. */
function compareLockFiles(a: DriveFile, b: DriveFile): number {
  const ta = a.createdTime === undefined ? NaN : Date.parse(a.createdTime)
  const tb = b.createdTime === undefined ? NaN : Date.parse(b.createdTime)
  const aTimed = !Number.isNaN(ta)
  const bTimed = !Number.isNaN(tb)
  if (aTimed !== bTimed) return aTimed ? -1 : 1
  if (aTimed && ta !== tb) return ta - tb
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

async function listLockFiles(): Promise<DriveFile[]> {
  // `nameContains` narrows the listing server-side; the exact-name filter
  // still runs because it is a substring match.
  const files = await listFiles({ nameContains: PASSWORD_CHANGE_LOCK_FILE })
  return files.filter((file) => isPasswordChangeLockFile(file.name))
}

/** Holder details of another machine's lock, for display; null when the
 *  file cannot be downloaded or its content is invalid. */
export async function readPasswordChangeLockInfo(file: DriveFile): Promise<PasswordChangeLockInfo | null> {
  let text: string
  try {
    text = await downloadRawFile(file.id)
  } catch {
    return null
  }
  const lock = parsePasswordChangeLock(text)
  return lock ? { machineHash: lock.machineHash, startedAt: lock.startedAt } : null
}

/** Whether `fileId` is the earliest lock in `locks` (and listed at all). */
function isWinner(locks: DriveFile[], fileId: string): boolean {
  return [...locks].sort(compareLockFiles)[0]?.id === fileId
}

async function deleteOwnLockQuietly(fileId: string): Promise<void> {
  try {
    await deleteFile(fileId)
  } catch {
    // Best effort: a left-over lock can still be found by its lockId, and
    // the caller's result (an error or 'lost') is more useful than this one.
  }
}

/** After a create whose response was lost, the file may exist anyway. */
async function deleteLockByLockIdQuietly(lockId: string): Promise<void> {
  try {
    const fileId = await findOwnPasswordChangeLock(lockId)
    if (fileId) await deleteFile(fileId)
  } catch {
    // Best effort, as in deleteOwnLockQuietly.
  }
}

/** Re-lists until our lock is visible (bounded by `relistDelaysMs`), then,
 *  if it is the earliest, waits `settleMs` and checks once more. */
async function settleOwnership(fileId: string): Promise<boolean> {
  let locks = await listLockFiles()
  for (const delay of lockTiming.relistDelaysMs) {
    if (locks.some((file) => file.id === fileId)) break
    await lockTiming.sleep(delay)
    locks = await listLockFiles()
  }
  if (!isWinner(locks, fileId)) return false
  await lockTiming.sleep(lockTiming.settleMs)
  return isWinner(await listLockFiles(), fileId)
}

/** Creates our lock unless one exists, then re-lists to settle a race with
 *  a machine that created its lock at about the same time. Only our own
 *  file id is ever deleted here. */
export async function acquirePasswordChangeLock(
  lock: Pick<PasswordChangeLock, 'lockId' | 'machineHash' | 'startedAt'>,
  options: AcquirePasswordChangeLockOptions,
): Promise<AcquirePasswordChangeLockResult> {
  const existing = (await listLockFiles()).sort(compareLockFiles)
  if (existing.length > 0) {
    return { ok: false, reason: 'locked', holder: await readPasswordChangeLockInfo(existing[0]) }
  }

  const content: PasswordChangeLock = { type: LOCK_TYPE, version: LOCK_VERSION, ...lock }
  let fileId: string
  try {
    fileId = (await createRawFile(PASSWORD_CHANGE_LOCK_FILE, JSON.stringify(content))).id
  } catch (err) {
    await deleteLockByLockIdQuietly(lock.lockId)
    throw err
  }

  let won: boolean
  try {
    await options.onCreated(fileId)
    won = await settleOwnership(fileId)
  } catch (err) {
    await deleteOwnLockQuietly(fileId)
    throw err
  }

  if (!won) {
    await deleteOwnLockQuietly(fileId)
    return { ok: false, reason: 'lost' }
  }
  return { ok: true, fileId }
}

/** File id of the lock whose content carries `lockId`, or null when no
 *  listed lock does. Download failures propagate: "could not check" must
 *  not be mistaken for "no lock". */
export async function findOwnPasswordChangeLock(lockId: string): Promise<string | null> {
  for (const file of await listLockFiles()) {
    const lock = parsePasswordChangeLock(await downloadRawFile(file.id))
    if (lock?.lockId === lockId) return file.id
  }
  return null
}

/** Whether this machine still holds the lock: its file is listed and is
 *  the earliest lock. Checked at batch boundaries, so if two machines both
 *  passed acquire, the later one stops once the earlier lock is visible;
 *  false also when another machine released our lock. */
export async function isPasswordChangeLockHeld(fileId: string): Promise<boolean> {
  return isWinner(await listLockFiles(), fileId)
}

/** Deletes the lock by file id; an already-deleted lock is not an error. */
export async function releasePasswordChangeLock(fileId: string): Promise<void> {
  await deleteFile(fileId)
}
