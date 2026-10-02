// SPDX-License-Identifier: GPL-2.0-or-later
// Encryption (PBKDF2 + AES-256-GCM) and password management via safeStorage

import { safeStorage } from 'electron'
import { randomBytes, pbkdf2, createCipheriv, createDecipheriv } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ZxcvbnFactory } from '@zxcvbn-ts/core'
import * as zxcvbnCommonPackage from '@zxcvbn-ts/language-common'
import * as zxcvbnEnPackage from '@zxcvbn-ts/language-en'
import type { SyncCredentialResult, SyncEnvelope } from '../../shared/types/sync'
import { clearSecretFile, getAuthDir, retrieveSecretFile, storeSecretFile } from './sync-secret-file'
import type { PasswordStrength } from '../../shared/types/sync'

const pbkdf2Async = promisify(pbkdf2)

const PBKDF2_ITERATIONS = 600_000
const SALT_LENGTH = 16
const IV_LENGTH = 12
const KEY_LENGTH = 32 // AES-256
const ALGORITHM = 'aes-256-gcm'
const AUTH_TAG_LENGTH = 16
const PASSWORD_FILE = 'sync-password.enc'

// @zxcvbn-ts/core v4 replaced the singleton zxcvbn()/zxcvbnOptions API with
// an instantiable ZxcvbnFactory — options are now passed to the constructor
// instead of a global setOptions() call.
const zxcvbnInstance = new ZxcvbnFactory({
  translations: zxcvbnEnPackage.translations,
  graphs: zxcvbnCommonPackage.adjacencyGraphs,
  dictionary: {
    ...zxcvbnCommonPackage.dictionary,
    ...zxcvbnEnPackage.dictionary,
  },
})

function getPasswordPath(): string {
  return join(getAuthDir(), PASSWORD_FILE)
}

async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return pbkdf2Async(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256')
}

function buildAad(envelope: Pick<SyncEnvelope, 'version' | 'syncUnit'>): Buffer {
  return Buffer.from(`${envelope.version}:${envelope.syncUnit}`)
}

export async function encrypt(
  plaintext: string,
  password: string,
  syncUnit: string,
): Promise<SyncEnvelope> {
  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const key = await deriveKey(password, salt)

  const envelopeMeta = { version: 1 as const, syncUnit }
  const aad = buildAad(envelopeMeta)

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  cipher.setAAD(aad)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  const ciphertext = Buffer.concat([encrypted, authTag])

  return {
    ...envelopeMeta,
    updatedAt: new Date().toISOString(),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

export async function decrypt(envelope: SyncEnvelope, password: string): Promise<string> {
  const salt = Buffer.from(envelope.salt, 'base64')
  const iv = Buffer.from(envelope.iv, 'base64')
  const ciphertextWithTag = Buffer.from(envelope.ciphertext, 'base64')

  if (ciphertextWithTag.length < AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext too short')
  }

  const key = await deriveKey(password, salt)
  const aad = buildAad(envelope)

  const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - AUTH_TAG_LENGTH)
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - AUTH_TAG_LENGTH)

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  decipher.setAAD(aad)
  decipher.setAuthTag(authTag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])

  return decrypted.toString('utf-8')
}

export async function storePassword(password: string): Promise<void> {
  await storeSecretFile(getPasswordPath(), password)
}

export async function retrievePasswordResult(): Promise<SyncCredentialResult> {
  return retrieveSecretFile(getPasswordPath())
}

export async function hasStoredPassword(): Promise<boolean> {
  if (!safeStorage.isEncryptionAvailable()) return false
  try {
    await readFile(getPasswordPath())
    return true
  } catch {
    return false
  }
}

export async function clearPassword(): Promise<void> {
  // Every unlink failure is ignored here, not only a missing file.
  await clearSecretFile(getPasswordPath()).catch(() => {})
}

export function checkPasswordStrength(password: string): PasswordStrength {
  if (password === '') {
    return { score: 0, feedback: [] }
  }
  const result = zxcvbnInstance.check(password)
  return {
    score: result.score,
    feedback: [
      ...(result.feedback.warning ? [result.feedback.warning] : []),
      ...result.feedback.suggestions,
    ],
  }
}
