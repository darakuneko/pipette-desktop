// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

vi.mock('../sync/google-auth', () => ({
  getAccessToken: vi.fn(async () => 'mock-token'),
}))

import { driveFileName, listFiles, syncUnitFromFileName } from '../sync/google-drive'

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
      expect(driveFileName('keyboards/0x1234/devices/hash-abc/days/2026-04-19'))
        .toBe('keyboards_0x1234_devices_hash-abc_days_2026-04-19.enc')
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

    it('parses per-day device JSONL drive filename to sync unit', () => {
      expect(syncUnitFromFileName('keyboards_0x1234_devices_hash-abc_days_2026-04-19.enc'))
        .toBe('keyboards/0x1234/devices/hash-abc/days/2026-04-19')
    })

    it('returns null for the legacy flat device JSONL filename shape', () => {
      // The flat `{hash}.enc` form (no `_days_` segment) was retired with
      // the v7 cutover; it must no longer round-trip into a sync unit.
      expect(syncUnitFromFileName('keyboards_0x1234_devices_hash-abc.enc')).toBeNull()
    })

    it('round-trips the keyboard-meta singleton sync unit', () => {
      expect(driveFileName('meta/keyboard-names')).toBe('meta_keyboard-names.enc')
      expect(syncUnitFromFileName('meta_keyboard-names.enc')).toBe('meta/keyboard-names')
    })

    it('returns null for invalid filenames', () => {
      expect(syncUnitFromFileName('invalid.txt')).toBeNull()
      expect(syncUnitFromFileName('other_thing.enc')).toBeNull()
      expect(syncUnitFromFileName('layerNames_0x1234.enc')).toBeNull()
      expect(syncUnitFromFileName('')).toBeNull()
    })
  })

  describe('listFiles', () => {
    function mockFetchOk(files: Array<{ id: string; name: string; modifiedTime: string }> = []): {
      fetchSpy: ReturnType<typeof vi.fn>
    } {
      const fetchSpy = vi.fn(async () =>
        new Response(JSON.stringify({ files }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      vi.stubGlobal('fetch', fetchSpy)
      return { fetchSpy }
    }

    function extractFetchUrl(call: unknown): URL {
      const args = call as readonly [string | URL, RequestInit?]
      return new URL(typeof args[0] === 'string' ? args[0] : args[0].toString())
    }

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('omits the `q` parameter when no nameContains is given', async () => {
      const { fetchSpy } = mockFetchOk()

      await listFiles()

      expect(fetchSpy).toHaveBeenCalledOnce()
      const url = extractFetchUrl(fetchSpy.mock.calls[0])
      expect(url.searchParams.get('spaces')).toBe('appDataFolder')
      expect(url.searchParams.get('pageSize')).toBe('1000')
      expect(url.searchParams.has('q')).toBe(false)
    })

    it('adds `name contains` to the `q` parameter when nameContains is given', async () => {
      const { fetchSpy } = mockFetchOk()

      await listFiles({ nameContains: 'keyboards_0x1234_devices_' })

      const url = extractFetchUrl(fetchSpy.mock.calls[0])
      expect(url.searchParams.get('q')).toBe("name contains 'keyboards_0x1234_devices_'")
    })

    it('escapes single quotes in nameContains so the Drive `q` value stays valid', async () => {
      const { fetchSpy } = mockFetchOk()

      await listFiles({ nameContains: "weird'name" })

      const url = extractFetchUrl(fetchSpy.mock.calls[0])
      expect(url.searchParams.get('q')).toBe("name contains 'weird\\'name'")
    })

    it('treats an empty nameContains as no filter', async () => {
      const { fetchSpy } = mockFetchOk()

      await listFiles({ nameContains: '' })

      const url = extractFetchUrl(fetchSpy.mock.calls[0])
      expect(url.searchParams.has('q')).toBe(false)
    })
  })
})
