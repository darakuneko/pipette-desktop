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

import { driveFileName, listFiles, syncUnitFromFileName, uploadFile, deleteFilesByExactName } from '../sync/google-drive'
import type { SyncEnvelope } from '../../shared/types/sync'

function extractFetchUrl(call: unknown): URL {
  const args = call as readonly [string | URL, RequestInit?]
  return new URL(typeof args[0] === 'string' ? args[0] : args[0].toString())
}

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

    it('parses keyboard run-log drive filename to sync unit', () => {
      expect(driveFileName('keyboards/0x1234/runs')).toBe('keyboards_0x1234_runs.enc')
      expect(syncUnitFromFileName('keyboards_0x1234_runs.enc')).toBe('keyboards/0x1234/runs')
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

    // Task-sync-unit-filename-gap: these five patterns were previously
    // unmapped, so a fresh machine could never discover a remote-only
    // unit for these stores via scanRemoteData / polling / manual sync
    // (the store still uploaded fine — only the reverse mapping was
    // missing). Each case round-trips through both directions since
    // driveFileName and syncUnitFromFileName are meant to be exact
    // inverses of each other.
    it.each<[syncUnit: string, fileName: string]>([
      ['keyboards/0x1234/analyze_filters', 'keyboards_0x1234_analyze_filters.enc'],
      ['key-labels', 'key-labels.enc'],
      ['typing-test-texts', 'typing-test-texts.enc'],
      ['themes/index', 'themes_index.enc'],
      ['themes/packs/pack-abc-123', 'themes_packs_pack-abc-123.enc'],
    ])('round-trips %s', (syncUnit, fileName) => {
      expect(driveFileName(syncUnit)).toBe(fileName)
      expect(syncUnitFromFileName(fileName)).toBe(syncUnit)
    })

    it('keeps password-check.enc unmapped (not a data sync unit)', () => {
      expect(syncUnitFromFileName('password-check.enc')).toBeNull()
    })

    it('handles a uid whose own text contains "_analyze_filters"-shaped substrings via non-greedy backtracking', () => {
      // The uid capture is non-greedy — confirm the regex still resolves
      // to the intended (uid, store) split rather than mis-splitting on
      // an early underscore inside the uid itself.
      expect(syncUnitFromFileName('keyboards_foo_analyze_analyze_filters.enc'))
        .toBe('keyboards/foo_analyze/analyze_filters')
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

  // S3: the local-wins pack-body upload path (sync-service.ts's
  // uploadSyncUnit + pack-bundle-merge.ts's pinPackBodyMtimeAfterUpload)
  // pins the local file's mtime to whatever `modifiedTime` Drive just
  // assigned this revision — closing a clock-skew loop where a
  // locally-ahead wall clock would otherwise look newer than Drive's
  // own stamped time forever. That only works if `uploadFile` actually
  // requests and returns `modifiedTime` — Drive's default response
  // fields for an upload omit it.
  describe('uploadFile', () => {
    const envelope: SyncEnvelope = {
      version: 1,
      syncUnit: 'i18n/packs/pack-a',
      updatedAt: '2026-01-01T00:00:00.000Z',
      salt: 's',
      iv: 'i',
      ciphertext: 'cipher',
    }

    function mockFetchUploadOk(id: string, modifiedTime: string): { fetchSpy: ReturnType<typeof vi.fn> } {
      const fetchSpy = vi.fn(async () =>
        new Response(JSON.stringify({ id, modifiedTime }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      vi.stubGlobal('fetch', fetchSpy)
      return { fetchSpy }
    }

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('requests id + modifiedTime fields and returns both when creating a new file', async () => {
      const { fetchSpy } = mockFetchUploadOk('new-id', '2026-06-01T00:00:00.000Z')

      const result = await uploadFile('i18n_packs_pack-a.enc', envelope)

      const url = extractFetchUrl(fetchSpy.mock.calls[0])
      expect(url.searchParams.get('fields')).toBe('id,modifiedTime')
      expect(result).toEqual({ id: 'new-id', modifiedTime: '2026-06-01T00:00:00.000Z' })
    })

    it('requests id + modifiedTime fields and returns both when updating an existing file', async () => {
      const { fetchSpy } = mockFetchUploadOk('existing-id', '2026-06-02T00:00:00.000Z')

      const result = await uploadFile('i18n_packs_pack-a.enc', envelope, 'existing-id')

      const url = extractFetchUrl(fetchSpy.mock.calls[0])
      expect(url.searchParams.get('fields')).toBe('id,modifiedTime')
      expect(result).toEqual({ id: 'existing-id', modifiedTime: '2026-06-02T00:00:00.000Z' })
    })
  })

  // A: key-labels / typing-test-texts have no subtree — deleteFilesByExactName
  // is the reset path for both. Unlike a find-first-id approach, it must
  // delete EVERY file sharing this exact name (Drive keys by id, not
  // name — a stale duplicate from a past upload race could otherwise
  // survive a reset untouched).
  describe('deleteFilesByExactName', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('deletes every remote file with this exact name, not just the first match', async () => {
      const deletedIds: string[] = []
      const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          const u = new URL(typeof url === 'string' ? url : url.toString())
          const id = u.pathname.split('/').pop()
          deletedIds.push(id ?? '')
          return new Response(null, { status: 204 })
        }
        return new Response(JSON.stringify({
          files: [
            { id: 'a', name: 'key-labels.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
            { id: 'b', name: 'key-labels.enc', modifiedTime: '2025-01-02T00:00:00.000Z' },
            { id: 'c', name: 'typing-test-texts.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      })
      vi.stubGlobal('fetch', fetchSpy)

      const result = await deleteFilesByExactName('key-labels.enc')

      expect(deletedIds.sort()).toEqual(['a', 'b'])
      expect(result).toEqual({ attempted: 2, failed: 0 })
    })

    it('deletes nothing when no remote file matches the exact name', async () => {
      const fetchSpy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') throw new Error('should not delete anything')
        return new Response(JSON.stringify({
          files: [{ id: 'c', name: 'typing-test-texts.enc', modifiedTime: '2025-01-01T00:00:00.000Z' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      })
      vi.stubGlobal('fetch', fetchSpy)

      await expect(deleteFilesByExactName('key-labels.enc')).resolves.toEqual({ attempted: 0, failed: 0 })
    })

    // C1: a rejected delete must be surfaced (`failed > 0`) rather than
    // silently discarded by the underlying Promise.allSettled.
    it('reports a failed count when a delete rejects', async () => {
      const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          const u = new URL(typeof url === 'string' ? url : url.toString())
          if (u.pathname.endsWith('/b')) throw new Error('network error')
          return new Response(null, { status: 204 })
        }
        return new Response(JSON.stringify({
          files: [
            { id: 'a', name: 'key-labels.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
            { id: 'b', name: 'key-labels.enc', modifiedTime: '2025-01-02T00:00:00.000Z' },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      })
      vi.stubGlobal('fetch', fetchSpy)

      const result = await deleteFilesByExactName('key-labels.enc')

      expect(result).toEqual({ attempted: 2, failed: 1 })
    })
  })

  // C1: a Drive listing spanning more than one page must be followed to
  // completion via `nextPageToken` — a single-page cap previously meant
  // a large appDataFolder (many keyboards/devices/per-day analytics
  // files) silently lost everything past the first 1000 results.
  describe('listFiles pagination', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('follows nextPageToken until Drive stops returning one', async () => {
      const page1 = { id: 'p1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' }
      const page2 = { id: 'p2', name: 'favorites_macro.enc', modifiedTime: '2025-01-01T00:00:00.000Z' }
      const fetchSpy = vi.fn(async (url: string | URL) => {
        const u = new URL(typeof url === 'string' ? url : url.toString())
        const token = u.searchParams.get('pageToken')
        if (!token) {
          return new Response(JSON.stringify({ files: [page1], nextPageToken: 'token-2' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        expect(token).toBe('token-2')
        return new Response(JSON.stringify({ files: [page2] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      })
      vi.stubGlobal('fetch', fetchSpy)

      const files = await listFiles()

      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(files).toEqual([page1, page2])
    })
  })
})
