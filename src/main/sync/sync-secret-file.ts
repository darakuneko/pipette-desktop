// SPDX-License-Identifier: GPL-2.0-or-later
//
// Secrets kept on this machine only, encrypted with the OS keychain
// (safeStorage) under `userData/local/auth/`.

import { safeStorage, app } from 'electron'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SyncCredentialFailureReason } from '../../shared/types/sync'
import { isEnoent } from '../utils/is-enoent'
import { writeFileAtomic } from '../utils/write-file-atomic'

/** The local failure reasons; the remote-only ones never come from a file read. */
export type SecretFileFailureReason = Extract<
  SyncCredentialFailureReason,
  'keystoreUnavailable' | 'noPasswordFile' | 'decryptFailed'
>

export type SecretFileResult =
  | { ok: true; password: string }
  | { ok: false; reason: SecretFileFailureReason }

export function getAuthDir(): string {
  return join(app.getPath('userData'), 'local', 'auth')
}

/**
 * Encrypt `secret` with the OS keychain (safeStorage) and write it to
 * `path` atomically (temp file + rename), creating the parent directory.
 * Throws when the keychain is unavailable so a secret is never written in
 * plain text.
 */
export async function storeSecretFile(path: string, secret: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain encryption is not available')
  }
  const encrypted = safeStorage.encryptString(secret)
  await mkdir(dirname(path), { recursive: true })
  await writeFileAtomic(path, encrypted)
}

/**
 * Read and decrypt a secret written by `storeSecretFile`, surfacing why it
 * couldn't be returned instead of collapsing every failure into `null`. We
 * probe the file first so the happy path skips the OS keychain availability
 * check; the probe only runs when we actually have to disambiguate a decrypt
 * failure from a missing keystore.
 */
export async function retrieveSecretFile(path: string): Promise<SecretFileResult> {
  let encrypted: Buffer
  try {
    encrypted = await readFile(path)
  } catch {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, reason: 'keystoreUnavailable' }
    }
    return { ok: false, reason: 'noPasswordFile' }
  }
  try {
    return { ok: true, password: safeStorage.decryptString(encrypted) }
  } catch {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, reason: 'keystoreUnavailable' }
    }
    return { ok: false, reason: 'decryptFailed' }
  }
}

/** Delete a secret file; a missing file is not an error, any other failure is rethrown. */
export async function clearSecretFile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (err) {
    if (!isEnoent(err)) throw err
  }
}
