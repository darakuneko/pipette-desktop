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

// Mock fs for google-auth token storage
vi.mock('node:fs/promises', () => {
  const store = new Map<string, Buffer | string>()
  return {
    writeFile: vi.fn(async (path: string, data: Buffer | string) => {
      store.set(path, typeof data === 'string' ? data : Buffer.from(data))
    }),
    readFile: vi.fn(async (path: string) => {
      const data = store.get(path)
      if (!data) throw new Error('ENOENT')
      return data
    }),
    unlink: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    _testStore: store,
  }
})

import { driveFileName, syncUnitFromFileName } from '../sync/google-drive'

describe('google-drive', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('driveFileName', () => {
    it('converts favorite sync unit to drive filename', () => {
      expect(driveFileName('favorites/tapDance')).toBe('favorites_tapDance.enc')
      expect(driveFileName('favorites/macro')).toBe('favorites_macro.enc')
    })

    it('converts keyboard sync units to drive filename', () => {
      expect(driveFileName('keyboards/0x1234/settings')).toBe('keyboards_0x1234_settings.enc')
      expect(driveFileName('keyboards/0x1234/snapshots')).toBe('keyboards_0x1234_snapshots.enc')
    })
  })

  describe('syncUnitFromFileName', () => {
    it('parses favorite drive filename to sync unit', () => {
      expect(syncUnitFromFileName('favorites_tapDance.enc')).toBe('favorites/tapDance')
      expect(syncUnitFromFileName('favorites_macro.enc')).toBe('favorites/macro')
    })

    it('parses keyboard settings drive filename to sync unit', () => {
      expect(syncUnitFromFileName('keyboards_0x1234_settings.enc')).toBe('keyboards/0x1234/settings')
    })

    it('parses keyboard snapshots drive filename to sync unit', () => {
      expect(syncUnitFromFileName('keyboards_0x1234_snapshots.enc')).toBe('keyboards/0x1234/snapshots')
    })

    it('returns null for invalid filenames', () => {
      expect(syncUnitFromFileName('invalid.txt')).toBeNull()
      expect(syncUnitFromFileName('other_thing.enc')).toBeNull()
      expect(syncUnitFromFileName('layerNames_0x1234.enc')).toBeNull()
      expect(syncUnitFromFileName('')).toBeNull()
    })
  })
})
