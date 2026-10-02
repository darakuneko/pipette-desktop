// SPDX-License-Identifier: GPL-2.0-or-later
// Sync credentials and the password-check sentinel file: verifying the
// stored password against the remote password-check unit. Changing the
// password lives in sync-password-change.ts.

import { encrypt, decrypt, retrievePasswordResult, storePassword, clearPassword } from './sync-crypto'
import { getAuthStatus } from './google-auth'
import {
  listFiles,
  downloadFile,
  uploadFile,
  driveFileName,
  PASSWORD_CHECK_UNIT,
  type DriveFile,
} from './google-drive'
import { syncRuntime } from './sync-runtime-state'
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
export async function writePasswordCheck(password: string, existingFileId?: string): Promise<void> {
  const envelope = await encrypt(PASSWORD_CHECK_PAYLOAD, password, PASSWORD_CHECK_UNIT)
  await uploadFile(driveFileName(PASSWORD_CHECK_UNIT), envelope, existingFileId)
}

export async function validatePasswordCheck(
  password: string,
  remoteFiles: DriveFile[],
): Promise<void> {
  const fileName = driveFileName(PASSWORD_CHECK_UNIT)
  const existing = remoteFiles.find((f) => f.name === fileName)

  if (existing) {
    const envelope = await downloadFile(existing.id)
    try {
      await decrypt(envelope, password)
    } catch {
      throw new PasswordMismatchError()
    }
  } else {
    await writePasswordCheck(password)
  }
  syncRuntime.passwordCheckValidated = true
}

export function resetPasswordCheckCache(): void {
  syncRuntime.passwordCheckValidated = false
}

export async function checkPasswordCheckExists(): Promise<boolean> {
  const remoteFiles = await listFiles()
  const fileName = driveFileName(PASSWORD_CHECK_UNIT)
  return remoteFiles.some((f) => f.name === fileName)
}

export async function setPasswordAndValidate(password: string): Promise<void> {
  await storePassword(password)
  resetPasswordCheckCache()
  try {
    const remoteFiles = await listFiles()
    await validatePasswordCheck(password, remoteFiles)
  } catch (err) {
    await clearPassword()
    throw err
  }
}
