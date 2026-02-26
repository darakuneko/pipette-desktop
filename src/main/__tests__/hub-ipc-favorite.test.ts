// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron — includes app.getPath for buildFavoriteExportJson
vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      }),
      _handlers: handlers,
    },
    app: {
      getPath: vi.fn(() => '/mock/userData'),
    },
  }
})

// Mock ipc-guard — bypass origin check (tested in ipc-guard.test.ts)
vi.mock('../ipc-guard', async () => {
  const { ipcMain } = await import('electron')
  return { secureHandle: ipcMain.handle }
})

// Mock google-auth
vi.mock('../sync/google-auth', () => ({
  getIdToken: vi.fn(),
}))

// Mock hub-client
vi.mock('../hub/hub-client', async () => {
  const actual = await vi.importActual<typeof import('../hub/hub-client')>('../hub/hub-client')
  return {
    Hub401Error: actual.Hub401Error,
    Hub403Error: actual.Hub403Error,
    Hub409Error: actual.Hub409Error,
    Hub429Error: actual.Hub429Error,
    authenticateWithHub: vi.fn(),
    uploadPostToHub: vi.fn(),
    updatePostOnHub: vi.fn(),
    patchPostOnHub: vi.fn(),
    deletePostFromHub: vi.fn(),
    fetchMyPosts: vi.fn(),
    fetchMyPostsByKeyboard: vi.fn(),
    fetchAuthMe: vi.fn(),
    patchAuthMe: vi.fn(),
    getHubOrigin: vi.fn(() => 'https://pipette-hub-worker.keymaps.workers.dev'),
    uploadFeaturePostToHub: vi.fn(),
    updateFeaturePostOnHub: vi.fn(),
  }
})

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

// Mock keycodes serialize
vi.mock('../../shared/keycodes/keycodes', () => ({
  serialize: vi.fn((code: number) => `KC_${code}`),
}))

import { ipcMain } from 'electron'
import { getIdToken } from '../sync/google-auth'
import { authenticateWithHub, uploadFeaturePostToHub, updateFeaturePostOnHub } from '../hub/hub-client'
import { setupHubIpc, clearHubTokenCache } from '../hub/hub-ipc'
import { readFile } from 'node:fs/promises'
import type { FavoriteIndex } from '../../shared/types/favorite-store'

// --- Test fixtures ---

const MOCK_INDEX: FavoriteIndex = {
  type: 'tapDance',
  entries: [
    {
      id: 'entry-1',
      label: 'My Tap Dance',
      savedAt: '2025-01-01T00:00:00.000Z',
      filename: 'entry-1.json',
    },
    {
      id: 'deleted-entry',
      label: 'Deleted',
      savedAt: '2025-01-01T00:00:00.000Z',
      filename: 'deleted.json',
      deletedAt: '2025-06-01T00:00:00.000Z',
    },
  ],
}

const MOCK_TAP_DANCE_DATA = {
  type: 'tapDance',
  data: {
    onTap: 4,
    onHold: 5,
    onDoubleTap: 6,
    onTapHold: 7,
    tappingTerm: 200,
  },
}

describe('hub-ipc favorite handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearHubTokenCache()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ipcMain as any)._handlers.clear()
    setupHubIpc()
  })

  function getHandlerFor(channel: string): (...args: unknown[]) => Promise<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (ipcMain as any)._handlers.get(channel)
    expect(handler).toBeDefined()
    return handler
  }

  function mockHubAuth(): void {
    vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
    vi.mocked(authenticateWithHub).mockResolvedValueOnce({
      token: 'hub-jwt',
      user: { id: 'u1', email: 'test@example.com', display_name: null },
    })
  }

  /**
   * Configure readFile mock to serve the index and data files for a given
   * favorite type. Defaults to tapDance with MOCK_INDEX and MOCK_TAP_DANCE_DATA.
   */
  function mockFavoriteFs(
    type = 'tapDance',
    index: FavoriteIndex = MOCK_INDEX,
    data: unknown = MOCK_TAP_DANCE_DATA,
  ): void {
    vi.mocked(readFile).mockImplementation(async (path: string | URL) => {
      const p = String(path)
      if (p.endsWith(`/${type}/index.json`)) return JSON.stringify(index)
      if (p.includes(`/${type}/`)) return JSON.stringify(data)
      throw new Error(`ENOENT: ${p}`)
    })
  }

  // ----------------------------------------------------------------
  // HUB_UPLOAD_FAVORITE_POST
  // ----------------------------------------------------------------
  describe('HUB_UPLOAD_FAVORITE_POST', () => {
    function getHandler(): (...args: unknown[]) => Promise<unknown> {
      return getHandlerFor('hub:upload-favorite-post')
    }

    it('registers the handler', () => {
      expect(ipcMain.handle).toHaveBeenCalledWith(
        'hub:upload-favorite-post',
        expect.any(Function),
      )
    })

    it('uploads successfully with valid params', async () => {
      mockHubAuth()
      mockFavoriteFs()
      vi.mocked(uploadFeaturePostToHub).mockResolvedValueOnce({
        id: 'fav-post-1',
        title: 'My Tap Dance',
      })

      const handler = getHandler()
      const result = await handler({}, {
        type: 'tapDance',
        entryId: 'entry-1',
        title: 'My Tap Dance',
      })

      expect(result).toEqual({ success: true, postId: 'fav-post-1' })
      expect(uploadFeaturePostToHub).toHaveBeenCalledWith(
        'hub-jwt',
        'My Tap Dance',
        'td',
        expect.objectContaining({
          name: 'td.json',
          data: expect.any(Buffer),
        }),
      )
    })

    it('returns error for invalid favorite type', async () => {
      const handler = getHandler()
      const result = await handler({}, {
        type: 'invalidType',
        entryId: 'entry-1',
        title: 'Test',
      })

      expect(result).toEqual({ success: false, error: 'Invalid favorite type' })
      expect(getIdToken).not.toHaveBeenCalled()
    })

    it('returns error for missing title', async () => {
      const handler = getHandler()

      for (const title of ['', '   ', undefined, null, 123]) {
        const result = await handler({}, {
          type: 'tapDance',
          entryId: 'entry-1',
          title,
        })
        expect(result).toEqual(
          expect.objectContaining({ success: false }),
        )
      }
    })

    it('returns error for title too long', async () => {
      const handler = getHandler()
      const result = await handler({}, {
        type: 'tapDance',
        entryId: 'entry-1',
        title: 'a'.repeat(201),
      })

      expect(result).toEqual({ success: false, error: 'Title too long' })
    })

    it('returns error when entry not found', async () => {
      mockHubAuth()
      // Serve an index that has no matching entry
      const emptyIndex: FavoriteIndex = { type: 'tapDance', entries: [] }
      mockFavoriteFs('tapDance', emptyIndex)

      const handler = getHandler()
      const result = await handler({}, {
        type: 'tapDance',
        entryId: 'nonexistent',
        title: 'Test',
      })

      expect(result).toEqual({ success: false, error: 'Entry not found' })
    })

    it('returns error when entry is soft-deleted', async () => {
      mockHubAuth()
      mockFavoriteFs()

      const handler = getHandler()
      const result = await handler({}, {
        type: 'tapDance',
        entryId: 'deleted-entry',
        title: 'Test',
      })

      expect(result).toEqual({ success: false, error: 'Entry not found' })
    })

    it('serializes keycode fields in the export JSON', async () => {
      mockHubAuth()
      mockFavoriteFs()
      vi.mocked(uploadFeaturePostToHub).mockResolvedValueOnce({
        id: 'fav-post-2',
        title: 'My Tap Dance',
      })

      const handler = getHandler()
      await handler({}, {
        type: 'tapDance',
        entryId: 'entry-1',
        title: 'My Tap Dance',
      })

      // Verify the JSON sent contains serialized keycodes
      const call = vi.mocked(uploadFeaturePostToHub).mock.calls[0]
      const jsonFile = call[3] as { name: string; data: Buffer }
      const parsed = JSON.parse(jsonFile.data.toString('utf-8'))
      expect(parsed.app).toBe('pipette')
      expect(parsed.version).toBe(2)
      expect(parsed.scope).toBe('fav')
      expect(parsed.categories.td).toHaveLength(1)
      const entry = parsed.categories.td[0]
      expect(entry.label).toBe('My Tap Dance')
      // tapDance keycode fields should be serialized via serialize mock
      expect(entry.data.onTap).toBe('KC_4')
      expect(entry.data.onHold).toBe('KC_5')
      expect(entry.data.onDoubleTap).toBe('KC_6')
      expect(entry.data.onTapHold).toBe('KC_7')
      // Non-keycode field should remain as-is
      expect(entry.data.tappingTerm).toBe(200)
    })
  })

  // ----------------------------------------------------------------
  // HUB_UPDATE_FAVORITE_POST
  // ----------------------------------------------------------------
  describe('HUB_UPDATE_FAVORITE_POST', () => {
    function getHandler(): (...args: unknown[]) => Promise<unknown> {
      return getHandlerFor('hub:update-favorite-post')
    }

    it('registers the handler', () => {
      expect(ipcMain.handle).toHaveBeenCalledWith(
        'hub:update-favorite-post',
        expect.any(Function),
      )
    })

    it('updates successfully with valid params', async () => {
      mockHubAuth()
      mockFavoriteFs()
      vi.mocked(updateFeaturePostOnHub).mockResolvedValueOnce({
        id: 'fav-post-1',
        title: 'Updated Tap Dance',
      })

      const handler = getHandler()
      const result = await handler({}, {
        type: 'tapDance',
        entryId: 'entry-1',
        title: 'Updated Tap Dance',
        postId: 'fav-post-1',
      })

      expect(result).toEqual({ success: true, postId: 'fav-post-1' })
      expect(updateFeaturePostOnHub).toHaveBeenCalledWith(
        'hub-jwt',
        'fav-post-1',
        'Updated Tap Dance',
        'td',
        expect.objectContaining({
          name: 'td.json',
          data: expect.any(Buffer),
        }),
      )
    })

    it('returns error for invalid favorite type', async () => {
      const handler = getHandler()
      const result = await handler({}, {
        type: 'badType',
        entryId: 'entry-1',
        title: 'Test',
        postId: 'fav-post-1',
      })

      expect(result).toEqual({ success: false, error: 'Invalid favorite type' })
    })

    it('returns error for invalid postId', async () => {
      const handler = getHandler()

      for (const postId of ['', 'has spaces', 'has!special', undefined, null]) {
        const result = await handler({}, {
          type: 'tapDance',
          entryId: 'entry-1',
          title: 'Test',
          postId,
        })
        expect(result).toEqual(
          expect.objectContaining({ success: false, error: 'Invalid post ID' }),
        )
      }
    })

    it('returns error for missing title', async () => {
      const handler = getHandler()
      const result = await handler({}, {
        type: 'tapDance',
        entryId: 'entry-1',
        title: '',
        postId: 'fav-post-1',
      })

      expect(result).toEqual({ success: false, error: 'Title must not be empty' })
    })

    it('returns error when entry not found', async () => {
      mockHubAuth()
      mockFavoriteFs('tapDance', { type: 'tapDance', entries: [] })

      const handler = getHandler()
      const result = await handler({}, {
        type: 'tapDance',
        entryId: 'nonexistent',
        title: 'Test',
        postId: 'fav-post-1',
      })

      expect(result).toEqual({ success: false, error: 'Entry not found' })
    })
  })

  // ----------------------------------------------------------------
  // Security: path traversal and schema validation
  // ----------------------------------------------------------------
  describe('security', () => {
    it('rejects entries with unsafe filename (path traversal)', async () => {
      mockHubAuth()
      const maliciousIndex: FavoriteIndex = {
        type: 'tapDance',
        entries: [{
          id: 'evil-entry',
          label: 'Evil',
          savedAt: '2025-01-01T00:00:00.000Z',
          filename: '../../etc/passwd',
        }],
      }
      mockFavoriteFs('tapDance', maliciousIndex)

      const handler = getHandlerFor('hub:upload-favorite-post')
      const result = await handler({}, {
        type: 'tapDance',
        entryId: 'evil-entry',
        title: 'Test',
      })

      expect(result).toEqual({ success: false, error: 'Invalid filename' })
      expect(uploadFeaturePostToHub).not.toHaveBeenCalled()
    })

    it('rejects entries where stored type does not match requested type', async () => {
      mockHubAuth()
      const index: FavoriteIndex = {
        type: 'tapDance',
        entries: [{
          id: 'entry-1',
          label: 'Test',
          savedAt: '2025-01-01T00:00:00.000Z',
          filename: 'entry-1.json',
        }],
      }
      // Data file claims to be a different type
      const mismatchedData = { type: 'macro', data: [['tap', 4]] }
      mockFavoriteFs('tapDance', index, mismatchedData)

      const handler = getHandlerFor('hub:upload-favorite-post')
      const result = await handler({}, {
        type: 'tapDance',
        entryId: 'entry-1',
        title: 'Test',
      })

      expect(result).toEqual({ success: false, error: 'Entry type mismatch' })
      expect(uploadFeaturePostToHub).not.toHaveBeenCalled()
    })
  })

  // ----------------------------------------------------------------
  // post_type mapping
  // ----------------------------------------------------------------
  describe('post_type mapping', () => {
    const TYPE_MAP: Array<[string, string]> = [
      ['tapDance', 'td'],
      ['macro', 'macro'],
      ['combo', 'combo'],
      ['keyOverride', 'ko'],
      ['altRepeatKey', 'ark'],
    ]

    it.each(TYPE_MAP)(
      'maps %s to post_type %s',
      async (favType, expectedPostType) => {
        mockHubAuth()

        // Build type-specific index and data
        const index: FavoriteIndex = {
          type: favType as FavoriteIndex['type'],
          entries: [{
            id: 'e1',
            label: 'Test',
            savedAt: '2025-01-01T00:00:00.000Z',
            filename: 'e1.json',
          }],
        }

        const dataByType: Record<string, unknown> = {
          tapDance: { type: 'tapDance', data: { onTap: 1, onHold: 2, onDoubleTap: 3, onTapHold: 4, tappingTerm: 200 } },
          macro: { type: 'macro', data: [['tap', 4]] },
          combo: { type: 'combo', data: { key1: 1, key2: 2, key3: 0, key4: 0, output: 10 } },
          keyOverride: { type: 'keyOverride', data: { triggerKey: 1, replacementKey: 2, layers: 0, triggerMods: 0, negativeMods: 0, suppressedMods: 0, options: 0, enabled: true } },
          altRepeatKey: { type: 'altRepeatKey', data: { lastKey: 1, altKey: 2, allowedMods: 0, options: 0, enabled: true } },
        }

        mockFavoriteFs(favType, index, dataByType[favType])
        vi.mocked(uploadFeaturePostToHub).mockResolvedValueOnce({
          id: 'post-ok',
          title: 'Test',
        })

        const handler = getHandlerFor('hub:upload-favorite-post')
        const result = await handler({}, {
          type: favType,
          entryId: 'e1',
          title: 'Test',
        })

        expect(result).toEqual({ success: true, postId: 'post-ok' })
        expect(uploadFeaturePostToHub).toHaveBeenCalledWith(
          'hub-jwt',
          'Test',
          expectedPostType,
          expect.objectContaining({ name: `${expectedPostType}.json` }),
        )
      },
    )
  })
})
