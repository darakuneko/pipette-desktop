// SPDX-License-Identifier: GPL-2.0-or-later
//
// Local, machine-only state for an in-progress sync password change.
//
// - `sync-password-change-keys.enc` keeps the old and new passwords
//   together as one safeStorage-encrypted JSON object, written in a single
//   atomic write so a crash can never leave only one of them (or a pair
//   from two different changes). It exists until the change finishes or
//   is rolled back, so files on Drive can be decrypted with either
//   password while they are mixed.
// - `sync-password-change.json` holds the non-secret progress (direction,
//   step, Drive lock identity) so a restart can tell where the change
//   stopped and which way it was heading.
//
// Nothing here is synced; every file lives under `userData/local/auth/`.

import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from '../logger'
import { isEnoent } from '../utils/is-enoent'
import { writeFileAtomic } from '../utils/write-file-atomic'
import {
  clearSecretFile,
  getAuthDir,
  retrieveSecretFile,
  storeSecretFile,
  type SecretFileFailureReason,
} from './sync-secret-file'

const KEYS_FILE = 'sync-password-change-keys.enc'
const STATE_FILE = 'sync-password-change.json'

const TARGETS = ['new', 'old'] as const
const STEPS = ['locking', 'reencrypting', 'committing', 'cleanup'] as const

type PasswordChangeTarget = (typeof TARGETS)[number]
type PasswordChangeStep = (typeof STEPS)[number]

export interface PasswordChangeState {
  version: 1
  /** The password the change is heading towards: `'new'` while changing, `'old'` while rolling back. */
  target: PasswordChangeTarget
  step: PasswordChangeStep
  /** Random id written into this machine's Drive lock file, used to recognise it. */
  lockId: string
  /** Drive file id of the lock, once Drive has created it. */
  lockFileId?: string
  /** Epoch milliseconds when the change started (local clock). */
  startedAt: number
}

export interface PasswordChangeKeys {
  oldPassword: string
  newPassword: string
}

/**
 * Why the keys couldn't be returned:
 * - `keystoreUnavailable`: the OS keychain isn't ready (common on Linux
 *   right after login); retrying later can succeed
 * - `noPasswordFile`: the keys file doesn't exist (or can't be read)
 * - `decryptFailed`: the keychain refuses to decrypt the file
 * - `invalidContent`: it decrypts, but isn't a `PasswordChangeKeys` object
 */
export type ChangeKeysFailureReason = SecretFileFailureReason | 'invalidContent'

export type ChangeKeysResult =
  | { ok: true; keys: PasswordChangeKeys }
  | { ok: false; reason: ChangeKeysFailureReason }

export type ChangeStateReadResult =
  | { kind: 'none' }
  | { kind: 'ok'; state: PasswordChangeState }
  | { kind: 'invalid' }

function keysPath(): string {
  return join(getAuthDir(), KEYS_FILE)
}

function statePath(): string {
  return join(getAuthDir(), STATE_FILE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

/** Both passwords must be non-empty strings; used on store and on read. */
function toChangeKeys(value: unknown): PasswordChangeKeys | null {
  if (!isRecord(value)) return null
  const { oldPassword, newPassword } = value
  if (!isNonEmptyString(oldPassword) || !isNonEmptyString(newPassword)) return null
  return { oldPassword, newPassword }
}

function parseChangeKeys(json: string): PasswordChangeKeys | null {
  try {
    return toChangeKeys(JSON.parse(json))
  } catch {
    return null
  }
}

/** Throws without touching the disk when either password is not a non-empty string. */
export async function storeChangeKeys(keys: PasswordChangeKeys): Promise<void> {
  const valid = toChangeKeys(keys)
  if (!valid) throw new Error('Invalid sync password change keys')
  await storeSecretFile(keysPath(), JSON.stringify(valid))
}

export async function retrieveChangeKeys(): Promise<ChangeKeysResult> {
  const result = await retrieveSecretFile(keysPath())
  if (!result.ok) return { ok: false, reason: result.reason }
  const keys = parseChangeKeys(result.password)
  return keys ? { ok: true, keys } : { ok: false, reason: 'invalidContent' }
}

/** Remove the keys file; a missing file is not an error, any other failure is rethrown. */
export async function clearChangeKeys(): Promise<void> {
  await clearSecretFile(keysPath())
}

/**
 * Validate `value` as a `PasswordChangeState`. Every field is checked
 * strictly; keys that aren't part of the type are dropped from the result
 * rather than causing a rejection.
 */
function parseChangeState(value: unknown): PasswordChangeState | null {
  if (!isRecord(value)) return null
  const { version, target, step, lockId, lockFileId, startedAt } = value
  if (version !== 1) return null
  if (!isOneOf(TARGETS, target) || !isOneOf(STEPS, step)) return null
  if (!isNonEmptyString(lockId)) return null
  if (lockFileId !== undefined && !isNonEmptyString(lockFileId)) return null
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt < 0) return null
  return {
    version,
    target,
    step,
    lockId,
    ...(lockFileId !== undefined ? { lockFileId } : {}),
    startedAt,
  }
}

/**
 * `none` when no change is in progress. `invalid` (with a warning in the
 * log) when the file exists but can't be read, isn't JSON, or fails
 * `parseChangeState`.
 */
export async function readChangeState(): Promise<ChangeStateReadResult> {
  let raw: string
  try {
    raw = await readFile(statePath(), 'utf-8')
  } catch (err) {
    if (isEnoent(err)) return { kind: 'none' }
    log('warn', `sync password change state: cannot read ${STATE_FILE}: ${String(err)}`)
    return { kind: 'invalid' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    log('warn', `sync password change state: ${STATE_FILE} is not valid JSON`)
    return { kind: 'invalid' }
  }
  const state = parseChangeState(parsed)
  if (!state) {
    log('warn', `sync password change state: ${STATE_FILE} has unexpected contents`)
    return { kind: 'invalid' }
  }
  return { kind: 'ok', state }
}

/** Throws without touching the disk when `state` fails `parseChangeState`. */
export async function writeChangeState(state: PasswordChangeState): Promise<void> {
  const valid = parseChangeState(state)
  if (!valid) throw new Error('Invalid sync password change state')
  try {
    await mkdir(getAuthDir(), { recursive: true })
    await writeFileAtomic(statePath(), JSON.stringify(valid))
  } finally {
    forgetChangeStateCache()
  }
}

/** Remove the state file; a missing file is not an error, any other failure is rethrown. */
export async function clearChangeState(): Promise<void> {
  try {
    // `force` ignores only a missing path; other errors (e.g. EISDIR, EACCES) still throw.
    await rm(statePath(), { force: true })
  } finally {
    forgetChangeStateCache()
  }
}

// `hasChangeState` is asked before every sync pass, so its answer is kept
// in memory. Keyed by the file path because `userData` is what locates it.
// `generation` drops the result of a read that overlapped a write or clear.
let changeStateCache: { path: string; present: boolean } | null = null
let changeStateGeneration = 0

/** Whether this machine has a password-change state file, readable or not
 *  (`readChangeState` is `ok` or `invalid`). Cached until the next
 *  `writeChangeState` / `clearChangeState` / `forgetChangeStateCache`. */
export async function hasChangeState(): Promise<boolean> {
  const path = statePath()
  if (changeStateCache?.path === path) return changeStateCache.present
  const generation = changeStateGeneration
  const present = (await readChangeState()).kind !== 'none'
  if (generation === changeStateGeneration) changeStateCache = { path, present }
  return present
}

/** Drops the cached `hasChangeState` answer. Anything that removes or
 *  writes the state file without the functions above (e.g. deleting the
 *  whole `local/auth` directory) calls this. */
export function forgetChangeStateCache(): void {
  changeStateCache = null
  changeStateGeneration++
}
