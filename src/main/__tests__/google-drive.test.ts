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

import {
  driveFileName,
  listFiles,
  syncUnitFromFileName,
  uploadFile,
  deleteFile,
  downloadFile,
  deleteFilesByExactName,
} from '../sync/google-drive'
import { retryTiming } from '../sync/drive-retry'
import { getAccessToken } from '../sync/google-auth'
import { syncRuntime } from '../sync/sync-runtime-state'
import type { SyncEnvelope } from '../../shared/types/sync'

function extractFetchUrl(call: unknown): URL {
  const args = call as readonly [string | URL, RequestInit?]
  return new URL(typeof args[0] === 'string' ? args[0] : args[0].toString())
}

describe('google-drive', () => {
  // Backoff waits are recorded instead of slept so retry tests run instantly.
  let sleeps: number[]
  beforeEach(() => {
    vi.clearAllMocks()
    sleeps = []
    vi.spyOn(retryTiming, 'sleep').mockImplementation(async (ms: number) => {
      sleeps.push(ms)
    })
    vi.spyOn(retryTiming, 'random').mockReturnValue(0)
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
      // The flat `{hash}.enc` form (no `_days_` segment) must not
      // round-trip into a sync unit.
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

    // Each case round-trips through both directions since
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

  // The local-wins pack-body upload path (sync-service.ts's
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

    // A rejected delete must be surfaced (`failed > 0`) rather than
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

  // A Drive listing spanning more than one page must be followed to
  // completion via `nextPageToken` — a single-page cap means a large
  // appDataFolder (many keyboards/devices/per-day analytics files)
  // silently loses everything past the first 1000 results.
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

  describe('request retry', () => {
    const envelope: SyncEnvelope = {
      version: 1,
      syncUnit: 'favorites/macro',
      updatedAt: '2026-01-01T00:00:00.000Z',
      salt: 's',
      iv: 'i',
      ciphertext: 'cipher',
    }

    function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
      })
    }

    function rateLimit403(reason: string): Response {
      return json({ error: { code: 403, message: 'limit', errors: [{ reason, domain: 'usageLimits' }] } }, 403)
    }

    /** Response whose headers arrive but whose body read fails mid-stream. */
    function brokenBody(status = 200): () => Response {
      return () =>
        ({
          ok: status >= 200 && status < 300,
          status,
          headers: new Headers(),
          text: async () => {
            throw new TypeError('terminated')
          },
        }) as unknown as Response
    }

    /** fetch stub that replays `steps` in order; an Error step is thrown and
     *  a function step is called to build the response. */
    function stubSequence(steps: Array<Response | Error | (() => Response)>): ReturnType<typeof vi.fn> {
      let i = 0
      const fetchSpy = vi.fn(async () => {
        const step = steps[Math.min(i, steps.length - 1)]
        i++
        if (step instanceof Error) throw step
        if (typeof step === 'function') return step()
        return step.clone()
      })
      vi.stubGlobal('fetch', fetchSpy)
      return fetchSpy
    }

    afterEach(() => {
      vi.unstubAllGlobals()
      syncRuntime.isQuitting = false
    })

    it('retries when the response body read fails after the headers arrived', async () => {
      const fetchSpy = stubSequence([brokenBody(), json(envelope)])

      await expect(downloadFile('x')).resolves.toEqual(envelope)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('retries when reading an error body fails', async () => {
      const fetchSpy = stubSequence([brokenBody(503), json({ files: [] })])

      await expect(listFiles()).resolves.toEqual([])
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('does not retry a create (POST) whose response body read fails', async () => {
      const fetchSpy = stubSequence([brokenBody()])

      await expect(uploadFile('n.enc', envelope)).rejects.toThrow('terminated')
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it('rethrows the body-read error after exhausting retries', async () => {
      const fetchSpy = stubSequence([brokenBody()])

      await expect(listFiles()).rejects.toThrow('terminated')
      expect(fetchSpy).toHaveBeenCalledTimes(5)
    })

    it('fails on the first error without waiting while the app is quitting', async () => {
      syncRuntime.isQuitting = true
      const fetchSpy = stubSequence([new Response('boom', { status: 503 })])

      await expect(listFiles()).rejects.toThrow('Drive list failed: 503 boom')
      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(sleeps).toEqual([])
    })

    it('does not retry a network error while the app is quitting', async () => {
      syncRuntime.isQuitting = true
      const fetchSpy = stubSequence([new TypeError('fetch failed')])

      await expect(deleteFile('x')).rejects.toThrow('fetch failed')
      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(sleeps).toEqual([])
    })

    it('does not retry a rate limit while the app is quitting', async () => {
      syncRuntime.isQuitting = true
      const fetchSpy = stubSequence([new Response('slow down', { status: 429 })])

      await expect(uploadFile('n.enc', envelope)).rejects.toThrow('Drive upload failed: 429 slow down')
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it('does not wait or resend when quitting begins while a request is in flight', async () => {
      const fetchSpy = vi.fn(async () => {
        syncRuntime.isQuitting = true
        return new Response('boom', { status: 503 })
      })
      vi.stubGlobal('fetch', fetchSpy)

      await expect(listFiles()).rejects.toThrow('Drive list failed: 503 boom')
      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(sleeps).toEqual([])
    })

    it('throws the last error instead of resending when quitting begins during the wait', async () => {
      vi.mocked(retryTiming.sleep).mockImplementation(async (ms: number) => {
        sleeps.push(ms)
        syncRuntime.isQuitting = true
      })
      const fetchSpy = stubSequence([new TypeError('fetch failed')])

      await expect(downloadFile('x')).rejects.toThrow('fetch failed')
      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(sleeps).toHaveLength(1)
    })

    it('throws the last HTTP error when quitting begins during the wait', async () => {
      vi.mocked(retryTiming.sleep).mockImplementation(async () => {
        syncRuntime.isQuitting = true
      })
      const fetchSpy = stubSequence([new Response('slow down', { status: 429 })])

      await expect(deleteFile('x')).rejects.toThrow('Drive delete failed: 429 slow down')
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it('ends the default wait early once quitting begins', async () => {
      vi.mocked(retryTiming.sleep).mockRestore()
      vi.useFakeTimers()
      try {
        let done = false
        const wait = retryTiming.sleep(30_000).then(() => {
          done = true
        })
        await vi.advanceTimersByTimeAsync(1000)
        expect(done).toBe(false)
        syncRuntime.isQuitting = true
        await vi.advanceTimersByTimeAsync(300)
        expect(done).toBe(true)
        await wait
      } finally {
        vi.useRealTimers()
      }
    })

    it('waits the full time with the default wait when not quitting', async () => {
      vi.mocked(retryTiming.sleep).mockRestore()
      vi.useFakeTimers()
      try {
        let done = false
        void retryTiming.sleep(1000).then(() => {
          done = true
        })
        await vi.advanceTimersByTimeAsync(999)
        expect(done).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(done).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('honours a Retry-After header in the HTTP-date form', async () => {
      const now = Date.UTC(2026, 0, 1, 0, 0, 0)
      vi.spyOn(Date, 'now').mockReturnValue(now)
      stubSequence([
        new Response('slow', { status: 429, headers: { 'Retry-After': new Date(now + 5000).toUTCString() } }),
        new Response('slow', { status: 429, headers: { 'Retry-After': new Date(now - 5000).toUTCString() } }),
        new Response('slow', { status: 429, headers: { 'Retry-After': new Date(now + 3_600_000).toUTCString() } }),
        json({ files: [] }),
      ])

      await listFiles()

      expect(sleeps).toEqual([5000, 0, 30000])
    })

    it('retries listFiles on 5xx and then succeeds', async () => {
      const file = { id: 'a', name: 'favorites_macro.enc', modifiedTime: 't' }
      const fetchSpy = stubSequence([new Response('boom', { status: 503 }), json({ files: [file] })])

      await expect(listFiles()).resolves.toEqual([file])
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(sleeps).toEqual([1000])
    })

    it('retries downloadFile on a network error and then succeeds', async () => {
      const fetchSpy = stubSequence([new TypeError('fetch failed'), json(envelope)])

      await expect(downloadFile('file-1')).resolves.toEqual(envelope)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('retries an update (PATCH) on 429 and then succeeds', async () => {
      const fetchSpy = stubSequence([
        new Response('slow down', { status: 429 }),
        json({ id: 'x', modifiedTime: 'm' }),
      ])

      await expect(uploadFile('n.enc', envelope, 'x')).resolves.toEqual({ id: 'x', modifiedTime: 'm' })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect((fetchSpy.mock.calls[1] as unknown[])[1]).toMatchObject({ method: 'PATCH' })
    })

    it('retries deleteFile on a userRateLimitExceeded 403 and then succeeds', async () => {
      const fetchSpy = stubSequence([rateLimit403('userRateLimitExceeded'), new Response(null, { status: 204 })])

      await expect(deleteFile('x')).resolves.toBeUndefined()
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('still treats a 404 on delete as success without retrying', async () => {
      const fetchSpy = stubSequence([new Response('gone', { status: 404 })])

      await expect(deleteFile('x')).resolves.toBeUndefined()
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it('retries a create (POST) on 429 and on a rateLimitExceeded 403', async () => {
      const fetchSpy = stubSequence([
        new Response('slow down', { status: 429 }),
        rateLimit403('rateLimitExceeded'),
        json({ id: 'new', modifiedTime: 'm' }),
      ])

      await expect(uploadFile('n.enc', envelope)).resolves.toEqual({ id: 'new', modifiedTime: 'm' })
      expect(fetchSpy).toHaveBeenCalledTimes(3)
    })

    it('does not retry a create (POST) on 5xx', async () => {
      const fetchSpy = stubSequence([new Response('boom', { status: 500 })])

      await expect(uploadFile('n.enc', envelope)).rejects.toThrow('Drive upload failed: 500 boom')
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it('does not retry a create (POST) on a network error', async () => {
      const fetchSpy = stubSequence([new TypeError('fetch failed')])

      await expect(uploadFile('n.enc', envelope)).rejects.toThrow('fetch failed')
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it('does not retry a 403 that is not a rate limit', async () => {
      const body = { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } }
      const fetchSpy = stubSequence([json(body, 403)])

      await expect(listFiles()).rejects.toThrow(`Drive list failed: 403 ${JSON.stringify(body)}`)
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it('does not retry a 403 whose body is not JSON', async () => {
      const fetchSpy = stubSequence([new Response('forbidden', { status: 403 })])

      await expect(downloadFile('x')).rejects.toThrow('Drive download failed: 403 forbidden')
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it('does not retry other 4xx responses', async () => {
      const fetchSpy = stubSequence([new Response('bad', { status: 400 })])

      await expect(uploadFile('n.enc', envelope, 'x')).rejects.toThrow('Drive update failed: 400 bad')
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it('honours a Retry-After header in seconds, capped at 30s', async () => {
      stubSequence([
        new Response('slow', { status: 429, headers: { 'Retry-After': '3' } }),
        new Response('slow', { status: 429, headers: { 'Retry-After': '120' } }),
        json({ files: [] }),
      ])

      await listFiles()

      expect(sleeps).toEqual([3000, 30000])
    })

    it('backs off exponentially with jitter', async () => {
      vi.mocked(retryTiming.random).mockReturnValue(0.5)
      stubSequence([
        new Response('boom', { status: 502 }),
        new Response('boom', { status: 502 }),
        new Response('boom', { status: 502 }),
        new Response('boom', { status: 502 }),
        json({ files: [] }),
      ])

      await listFiles()

      expect(sleeps).toEqual([1500, 2500, 4500, 8500])
    })

    it('gives up after 5 attempts with the original error message', async () => {
      const fetchSpy = stubSequence([new Response('still down', { status: 503 })])

      await expect(deleteFile('x')).rejects.toThrow('Drive delete failed: 503 still down')
      expect(fetchSpy).toHaveBeenCalledTimes(5)
      expect(sleeps).toHaveLength(4)
    })

    it('rethrows the last network error after exhausting retries', async () => {
      const fetchSpy = stubSequence([new TypeError('fetch failed')])

      await expect(downloadFile('x')).rejects.toThrow('fetch failed')
      expect(fetchSpy).toHaveBeenCalledTimes(5)
    })

    it('fetches auth headers again on every attempt', async () => {
      vi.mocked(getAccessToken)
        .mockResolvedValueOnce('token-1')
        .mockResolvedValueOnce('token-2')
      const fetchSpy = stubSequence([new Response('boom', { status: 500 }), json({ files: [] })])

      await listFiles()

      const auth = fetchSpy.mock.calls.map(
        (call) => ((call as unknown[])[1] as RequestInit).headers as Record<string, string>,
      )
      expect(auth.map((h) => h.Authorization)).toEqual(['Bearer token-1', 'Bearer token-2'])
    })

    it('does not retry when auth headers cannot be obtained', async () => {
      vi.mocked(getAccessToken).mockResolvedValueOnce(null)
      const fetchSpy = stubSequence([json({ files: [] })])

      await expect(listFiles()).rejects.toThrow('Not authenticated with Google Drive')
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })
})
