// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mock electron ---
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => {
      const str = b.toString()
      if (str.startsWith('enc:')) return str.slice(4)
      throw new Error('decrypt failed')
    }),
  },
  app: {
    getPath: (name: string) => `/mock/${name}`,
  },
}))

import {
  encrypt,
  decrypt,
  storePassword,
  retrievePassword,
  clearPassword,
  hasStoredPassword,
  checkPasswordStrength,
} from '../sync/sync-crypto'
import type { SyncEnvelope } from '../../shared/types/sync'

// Mock fs for password storage
vi.mock('node:fs/promises', () => {
  const store = new Map<string, Buffer>()
  return {
    writeFile: vi.fn(async (path: string, data: Buffer) => {
      store.set(path, Buffer.from(data))
    }),
    readFile: vi.fn(async (path: string) => {
      const data = store.get(path)
      if (!data) throw new Error('ENOENT')
      return Buffer.from(data)
    }),
    unlink: vi.fn(async (path: string) => {
      if (!store.has(path)) throw new Error('ENOENT')
      store.delete(path)
    }),
    mkdir: vi.fn(async () => {}),
    // Expose store for test reset
    _testStore: store,
  }
})

describe('sync-crypto', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const fs = await import('node:fs/promises')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(fs as any)._testStore.clear()
  })

  describe('encrypt/decrypt roundtrip', () => {
    it('encrypts and decrypts data correctly', async () => {
      const password = 'test-password-strong-123!'
      const plaintext = JSON.stringify({ type: 'favorite', key: 'tapDance', files: {} })
      const syncUnit = 'favorites/tapDance'

      const envelope = await encrypt(plaintext, password, syncUnit)

      expect(envelope.version).toBe(1)
      expect(envelope.syncUnit).toBe(syncUnit)
      expect(envelope.updatedAt).toBeTruthy()
      expect(envelope.salt).toBeTruthy()
      expect(envelope.iv).toBeTruthy()
      expect(envelope.ciphertext).toBeTruthy()

      // Ciphertext should not contain plaintext
      expect(envelope.ciphertext).not.toContain(plaintext)

      const decrypted = await decrypt(envelope, password)
      expect(decrypted).toBe(plaintext)
    })

    it('produces different ciphertext for same input (random salt/iv)', async () => {
      const password = 'test-password-strong-123!'
      const plaintext = 'same data'
      const syncUnit = 'favorites/macro'

      const envelope1 = await encrypt(plaintext, password, syncUnit)
      const envelope2 = await encrypt(plaintext, password, syncUnit)

      expect(envelope1.salt).not.toBe(envelope2.salt)
      expect(envelope1.iv).not.toBe(envelope2.iv)
      expect(envelope1.ciphertext).not.toBe(envelope2.ciphertext)
    })

    it('fails to decrypt with wrong password', async () => {
      const plaintext = 'secret data'
      const envelope = await encrypt(plaintext, 'correct-password', 'favorites/tapDance')

      await expect(decrypt(envelope, 'wrong-password')).rejects.toThrow()
    })

    it('fails to decrypt with tampered ciphertext', async () => {
      const plaintext = 'secret data'
      const envelope = await encrypt(plaintext, 'password123', 'favorites/tapDance')

      const tamperedCiphertext = Buffer.from(envelope.ciphertext, 'base64')
      tamperedCiphertext[0] ^= 0xff
      const tampered: SyncEnvelope = {
        ...envelope,
        ciphertext: tamperedCiphertext.toString('base64'),
      }

      await expect(decrypt(tampered, 'password123')).rejects.toThrow()
    })

    it('handles empty string plaintext', async () => {
      const password = 'password'
      const envelope = await encrypt('', password, 'favorites/tapDance')
      const decrypted = await decrypt(envelope, password)
      expect(decrypted).toBe('')
    })

    it('handles large plaintext', async () => {
      const password = 'password'
      const plaintext = 'x'.repeat(100_000)
      const envelope = await encrypt(plaintext, password, 'favorites/tapDance')
      const decrypted = await decrypt(envelope, password)
      expect(decrypted).toBe(plaintext)
    })

    it('sets updatedAt to current ISO timestamp', async () => {
      const before = new Date().toISOString()
      const envelope = await encrypt('data', 'pass', 'favorites/tapDance')
      const after = new Date().toISOString()

      expect(envelope.updatedAt >= before).toBe(true)
      expect(envelope.updatedAt <= after).toBe(true)
    })

    it('fails to decrypt with tampered syncUnit (AAD binding)', async () => {
      const plaintext = 'secret data'
      const envelope = await encrypt(plaintext, 'password123', 'favorites/tapDance')

      const tampered: SyncEnvelope = {
        ...envelope,
        syncUnit: 'favorites/macro',
      }

      await expect(decrypt(tampered, 'password123')).rejects.toThrow()
    })

    it('fails to decrypt with tampered version (AAD binding)', async () => {
      const plaintext = 'secret data'
      const envelope = await encrypt(plaintext, 'password123', 'favorites/tapDance')

      const tampered = {
        ...envelope,
        version: 2 as unknown as 1,
      }

      await expect(decrypt(tampered, 'password123')).rejects.toThrow()
    })

    it('rejects ciphertext shorter than auth tag length', async () => {
      const envelope: SyncEnvelope = {
        version: 1,
        syncUnit: 'favorites/tapDance',
        updatedAt: new Date().toISOString(),
        salt: Buffer.alloc(16).toString('base64'),
        iv: Buffer.alloc(12).toString('base64'),
        ciphertext: Buffer.alloc(8).toString('base64'),
      }

      await expect(decrypt(envelope, 'password')).rejects.toThrow('Ciphertext too short')
    })
  })

  describe('envelope format', () => {
    it('produces valid base64 for salt, iv, and ciphertext', async () => {
      const envelope = await encrypt('test', 'pass', 'favorites/tapDance')

      // base64 regex
      const b64re = /^[A-Za-z0-9+/]+=*$/

      expect(envelope.salt).toMatch(b64re)
      expect(envelope.iv).toMatch(b64re)
      expect(envelope.ciphertext).toMatch(b64re)

      // Salt should be 16 bytes = ~24 chars in base64
      const saltBytes = Buffer.from(envelope.salt, 'base64')
      expect(saltBytes.length).toBe(16)

      // IV should be 12 bytes = 16 chars in base64
      const ivBytes = Buffer.from(envelope.iv, 'base64')
      expect(ivBytes.length).toBe(12)
    })
  })

  describe('password storage (safeStorage)', () => {
    it('stores and retrieves password', async () => {
      await storePassword('my-secure-password')
      const retrieved = await retrievePassword()
      expect(retrieved).toBe('my-secure-password')
    })

    it('hasStoredPassword returns false when no password stored', async () => {
      const has = await hasStoredPassword()
      expect(has).toBe(false)
    })

    it('hasStoredPassword returns true after storing', async () => {
      await storePassword('password')
      const has = await hasStoredPassword()
      expect(has).toBe(true)
    })

    it('clearPassword removes stored password', async () => {
      await storePassword('password')
      await clearPassword()
      const has = await hasStoredPassword()
      expect(has).toBe(false)
    })

    it('retrievePassword returns null when no password stored', async () => {
      const retrieved = await retrievePassword()
      expect(retrieved).toBeNull()
    })

    it('storePassword throws when safeStorage unavailable', async () => {
      const { safeStorage } = await import('electron')
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValueOnce(false)

      await expect(storePassword('password')).rejects.toThrow('not available')
    })

    it('hasStoredPassword returns false when safeStorage unavailable', async () => {
      await storePassword('password')
      const { safeStorage } = await import('electron')
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValueOnce(false)

      const has = await hasStoredPassword()
      expect(has).toBe(false)
    })
  })

  describe('password strength (zxcvbn)', () => {
    it('rejects weak passwords (score < 3)', () => {
      const result = checkPasswordStrength('123456')
      expect(result.score).toBeLessThan(3)
    })

    it('accepts strong passwords (score >= 3)', () => {
      const result = checkPasswordStrength('correct-horse-battery-staple')
      expect(result.score).toBeGreaterThanOrEqual(3)
    })

    it('returns feedback for weak passwords', () => {
      const result = checkPasswordStrength('password')
      expect(result.score).toBeLessThan(3)
    })

    it('handles empty password', () => {
      const result = checkPasswordStrength('')
      expect(result.score).toBe(0)
    })
  })
})
