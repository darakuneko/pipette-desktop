// SPDX-License-Identifier: GPL-2.0-or-later
// Sync credentials and the password-check sentinel file: verifying the
// stored password against the remote password-check unit. Changing the
// password lives in sync-password-change.ts.

import { createHash } from 'node:crypto'
import { encrypt, decrypt, retrievePasswordResult, storePassword, clearPassword } from './sync-crypto'
import { getAuthStatus } from './google-auth'
import {
  listFiles,
  downloadFile,
  uploadFile,
  driveFileName,
  PASSWORD_CHECK_UNIT,
  type DriveFile,
  type UploadedFile,
} from './google-drive'
import { syncRuntime } from './sync-runtime-state'
import { filesNamed, pickCanonicalFile } from './drive-canonical'
import { assertNoLocalPasswordChange, assertSyncAllowed } from './sync-password-guard'
import { ensureSyncFormatMarkerKnown, syncFormatGeneration } from './sync-format'
import type { SyncCredentialFailureReason, SyncCredentialResult } from '../../shared/types/sync'
import { syncCredentialI18nKey } from '../../shared/types/sync'

export class SyncCredentialError extends Error {
  readonly reason: SyncCredentialFailureReason
  constructor(reason: SyncCredentialFailureReason, namespace: 'readiness' | 'changePasswordError' = 'changePasswordError') {
    super(syncCredentialI18nKey(namespace, reason))
    this.reason = reason
  }
}

export const PASSWORD_CHECK_PAYLOAD = JSON.stringify({ type: 'password-check', version: 1 })

export async function requireSyncCredentials(): Promise<SyncCredentialResult> {
  const authStatus = await getAuthStatus()
  if (!authStatus.authenticated) return { ok: false, reason: 'unauthenticated' }
  return retrievePasswordResult()
}

// --- Password check validation ---

export class PasswordMismatchError extends Error {
  constructor() {
    super('sync.passwordMismatch')
    this.name = 'PasswordMismatchError'
  }
}

/** Encrypts the password-check payload with `password` and uploads it,
 *  over `existingFileId` when given, otherwise as a new file. */
export async function writePasswordCheck(password: string, existingFileId?: string): Promise<UploadedFile> {
  const envelope = await encrypt(PASSWORD_CHECK_PAYLOAD, password, PASSWORD_CHECK_UNIT)
  return uploadFile(driveFileName(PASSWORD_CHECK_UNIT), envelope, existingFileId)
}

/** `createdMemoryMs`: how long a created password-check that no listing
 *  shows yet still counts as present. Long enough for Drive's listing lag;
 *  short enough that one deleted from another machine is created again.
 *  Exported so tests can replace the clock. */
export const passwordCheckTiming = {
  createdMemoryMs: 5 * 60 * 1000,
  now: (): number => Date.now(),
}

/** Every password-check file in `remoteFiles`. More than one can exist
 *  (two machines creating it at once); see `findPasswordCheck`. */
export function listedPasswordChecks(remoteFiles: DriveFile[]): readonly DriveFile[] {
  return filesNamed(remoteFiles, driveFileName(PASSWORD_CHECK_UNIT))
}

/** The password-check every machine uses when several are listed: the
 *  copy `pickCanonicalFile` (drive-canonical.ts) chooses — the newest
 *  `modifiedTime`, ties broken by the smallest file id. */
export function findPasswordCheck(remoteFiles: readonly DriveFile[]): DriveFile | undefined {
  return pickCanonicalFile(remoteFiles, driveFileName(PASSWORD_CHECK_UNIT))
}

/** SHA-256 hex digest of `password`, kept with the validated
 *  password-check so a pass holding another password validates again. */
function passwordFingerprint(password: string): string {
  return createHash('sha256').update(password, 'utf8').digest('hex')
}

function rememberValidated(file: UploadedFile, password: string): void {
  syncRuntime.validatedPasswordCheck = {
    id: file.id,
    modifiedTime: file.modifiedTime,
    passwordFingerprint: passwordFingerprint(password),
  }
}

function forgetCreatedPasswordCheck(): void {
  syncRuntime.passwordCheckCreated = null
}

/** The password-check this process created recently enough that a listing
 *  without it is put down to listing lag; null otherwise. */
function recentlyCreatedPasswordCheck(): UploadedFile | null {
  const created = syncRuntime.passwordCheckCreated
  if (!created) return null
  if (passwordCheckTiming.now() - created.at < passwordCheckTiming.createdMemoryMs) return created.file
  forgetCreatedPasswordCheck()
  return null
}

/** Opens `file` with `password` and remembers it as validated. Throws
 *  `PasswordMismatchError` when it does not open. */
async function openPasswordCheck(password: string, file: UploadedFile): Promise<void> {
  const envelope = await downloadFile(file.id)
  try {
    await decrypt(envelope, password)
  } catch {
    syncRuntime.validatedPasswordCheck = null
    throw new PasswordMismatchError()
  }
  rememberValidated(file, password)
}

/** Creates the password-check with `password`, after our sync-format
 *  marker (`ensureSyncFormatMarkerKnown`: callers' listings may be
 *  name-filtered); when the marker cannot be created, neither is the
 *  password-check. When a creation is already in flight, waits for it and
 *  opens what it created instead: that pass may have used another password. */
async function createPasswordCheckOnce(password: string): Promise<void> {
  const inFlight = syncRuntime.passwordCheckCreating
  if (inFlight) {
    await openPasswordCheck(password, await inFlight)
    return
  }
  const create = async (): Promise<UploadedFile> => {
    await ensureSyncFormatMarkerKnown()
    return writePasswordCheck(password)
  }
  const run = create().then((created) => {
    syncRuntime.passwordCheckCreated = { file: created, at: passwordCheckTiming.now() }
    return created
  })
  syncRuntime.passwordCheckCreating = run
  const settle = (): void => {
    if (syncRuntime.passwordCheckCreating === run) syncRuntime.passwordCheckCreating = null
  }
  run.then(settle, settle)
  const created = await run
  rememberValidated(created, password)
}

/** Opens the chosen password-check (`findPasswordCheck`) with `password`
 *  and remembers it as validated. When the listing has none it is
 *  created, unless this process created one the listing does not show
 *  yet; that one is opened by id. Throws `PasswordMismatchError` when the
 *  password-check does not open. */
export async function validatePasswordCheck(
  password: string,
  remoteFiles: DriveFile[],
): Promise<void> {
  const existing = findPasswordCheck(remoteFiles)
  if (existing) {
    forgetCreatedPasswordCheck()
    await openPasswordCheck(password, existing)
    return
  }
  const recent = recentlyCreatedPasswordCheck()
  if (recent) {
    await openPasswordCheck(password, recent)
  } else {
    await createPasswordCheckOnce(password)
  }
}

/** `validatePasswordCheck` unless the chosen password-check is the one
 *  last validated (same Drive id and `modifiedTime`) and `password` is the
 *  one it opened with. A pass that read the stored password before a
 *  re-enter replaced it therefore validates again, and fails with
 *  `PasswordMismatchError` instead of writing with the old password.
 *  `remoteFiles` must be a listing that would include the password-check
 *  when it exists. */
export async function ensurePasswordCheckValidated(
  password: string,
  remoteFiles: DriveFile[],
): Promise<void> {
  const existing = findPasswordCheck(remoteFiles)
  const validated = syncRuntime.validatedPasswordCheck
  if (
    existing &&
    validated &&
    existing.id === validated.id &&
    existing.modifiedTime === validated.modifiedTime &&
    validated.passwordFingerprint === passwordFingerprint(password)
  ) {
    forgetCreatedPasswordCheck()
    return
  }
  await validatePasswordCheck(password, remoteFiles)
}

/** A listing of just the password-check, for entry points whose own
 *  listing is name-filtered. */
export function listPasswordCheckFiles(): Promise<DriveFile[]> {
  return listFiles({ nameContains: driveFileName(PASSWORD_CHECK_UNIT) })
}

export function resetPasswordCheckCache(): void {
  syncRuntime.validatedPasswordCheck = null
  forgetCreatedPasswordCheck()
}

export async function checkPasswordCheckExists(): Promise<boolean> {
  const remoteFiles = await listFiles()
  return findPasswordCheck(remoteFiles) !== undefined
}

/** Refused (`SyncBlockedError`) while a password change is in progress or
 *  Drive needs a newer app, before the password is stored. */
export async function setPasswordAndValidate(password: string): Promise<void> {
  await assertNoLocalPasswordChange()
  const formatGeneration = syncFormatGeneration()
  const remoteFiles = await listFiles()
  await assertSyncAllowed(remoteFiles, formatGeneration)
  await storePassword(password)
  resetPasswordCheckCache()
  try {
    await validatePasswordCheck(password, remoteFiles)
  } catch (err) {
    await clearPassword()
    throw err
  }
}

/** Replaces the stored password with `password` once it opens the chosen
 *  password-check on Drive, for a password changed on another machine.
 *  Nothing is stored until it opens, so a mismatch or a network error
 *  leaves the stored password as it was (a mismatch clears the validated
 *  cache, as in `validatePasswordCheck`). Refused (`SyncBlockedError`)
 *  while a password change is in progress, and when Drive has no
 *  password-check to compare against. */
export async function replacePasswordAndValidate(password: string): Promise<void> {
  const authStatus = await getAuthStatus()
  if (!authStatus.authenticated) throw new SyncCredentialError('unauthenticated')
  await assertNoLocalPasswordChange()
  const formatGeneration = syncFormatGeneration()
  const remoteFiles = await listFiles()
  await assertSyncAllowed(remoteFiles, formatGeneration)
  const check = findPasswordCheck(remoteFiles)
  if (!check) throw new Error('sync.reenterPasswordNoRemote')
  await openPasswordCheck(password, check)
  forgetCreatedPasswordCheck()
  try {
    await storePassword(password)
  } catch (err) {
    // The validation belongs to `password`; the stored one is unchanged.
    syncRuntime.validatedPasswordCheck = null
    throw err
  }
}
