// SPDX-License-Identifier: GPL-2.0-or-later
// Sync credentials and the password-check sentinel file: verifying the
// stored password against the remote password-check unit, and the
// non-destructive change-password flow. Split out of sync-service.ts to
// keep it under the project's 800-line Service/Util size ceiling.

import { encrypt, decrypt, retrievePasswordResult, storePassword, clearPassword } from './sync-crypto'
import { getAuthStatus } from './google-auth'
import { listFiles, downloadFile, uploadFile, driveFileName, type DriveFile } from './google-drive'
import { pLimit } from '../../shared/concurrency'
import { SYNC_CONCURRENCY, syncRuntime } from './sync-runtime-state'
import type { SyncCredentialFailureReason, SyncCredentialResult } from '../../shared/types/sync'
import { syncCredentialI18nKey } from '../../shared/types/sync'

export class SyncCredentialError extends Error {
  readonly reason: SyncCredentialFailureReason
  constructor(reason: SyncCredentialFailureReason, namespace: 'readiness' | 'changePasswordError' = 'changePasswordError') {
    super(syncCredentialI18nKey(namespace, reason))
    this.reason = reason
  }
}

export const PASSWORD_CHECK_UNIT = 'password-check'
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
    const envelope = await encrypt(PASSWORD_CHECK_PAYLOAD, password, PASSWORD_CHECK_UNIT)
    await uploadFile(fileName, envelope)
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

// --- Non-destructive password change ---

export async function changePassword(newPassword: string): Promise<void> {
  if (syncRuntime.isSyncing) throw new Error('sync.changePasswordInProgress')
  syncRuntime.isSyncing = true
  try {
    const credentials = await requireSyncCredentials()
    if (!credentials.ok) throw new SyncCredentialError(credentials.reason)
    const oldPassword = credentials.password
    if (newPassword === oldPassword) throw new Error('sync.samePassword')
    const remoteFiles = await listFiles()

    // Validate old password against password-check first
    await validatePasswordCheck(oldPassword, remoteFiles)

    const passwordCheckFileName = driveFileName(PASSWORD_CHECK_UNIT)
    const dataFiles = remoteFiles.filter((f) => f.name !== passwordCheckFileName)

    // Phase 1: Download + decrypt all files (fail-fast on any error)
    const limit = pLimit(SYNC_CONCURRENCY)
    const decrypted = await Promise.all(
      dataFiles.map((file) =>
        limit(async () => {
          const envelope = await downloadFile(file.id)
          try {
            const plaintext = await decrypt(envelope, oldPassword)
            return { file, plaintext, syncUnit: envelope.syncUnit }
          } catch {
            throw new Error('sync.changePasswordUndecryptable')
          }
        }),
      ),
    )

    // Phase 2: Re-encrypt + upload with new password (overwrite)
    await Promise.all(
      decrypted.map(({ file, plaintext, syncUnit }) =>
        limit(async () => {
          const newEnvelope = await encrypt(plaintext, newPassword, syncUnit)
          await uploadFile(file.name, newEnvelope, file.id)
        }),
      ),
    )

    // Phase 3: Recreate password-check with new password
    const existingPc = remoteFiles.find((f) => f.name === passwordCheckFileName)
    const pcEnvelope = await encrypt(PASSWORD_CHECK_PAYLOAD, newPassword, PASSWORD_CHECK_UNIT)
    await uploadFile(passwordCheckFileName, pcEnvelope, existingPc?.id)

    await storePassword(newPassword)
    resetPasswordCheckCache()
  } finally {
    syncRuntime.isSyncing = false
  }
}
