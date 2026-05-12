// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'

let mockUserDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserDataPath
      return `/mock/${name}`
    },
  },
  ipcMain: { handle: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
}))

vi.mock('../sync/sync-service', () => ({
  notifyChange: vi.fn(),
}))

import { notifyChange } from '../sync/sync-service'
import {
  savePack,
  getPack,
  listMetas,
  listAllMetas,
  renamePack,
  deletePack,
  setHubPostId,
  hasActiveName,
  purgeExpiredTombstones,
  __testing,
} from '../theme-pack-store'
import {
  THEME_COLOR_KEYS,
  THEME_INDEX_SYNC_UNIT,
  THEME_PACK_TOMBSTONE_TTL_MS,
  THEME_PACK_LIMITS,
} from '../../shared/types/theme-store'

function makeValidPack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const colors: Record<string, string> = {}
  for (const key of THEME_COLOR_KEYS) {
    colors[key] = '#aabbcc'
  }
  return {
    name: 'Test Pack',
    version: '1.0.0',
    colorScheme: 'dark',
    colors,
    ...overrides,
  }
}

describe('theme-pack-store', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'theme-pack-store-test-'))
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  describe('Index I/O', () => {
    it('returns empty metas when index file does not exist', async () => {
      const index = await __testing.readIndex()
      expect(index).toEqual({ metas: [] })
    })

    it('returns empty metas when index file is corrupt JSON', async () => {
      const storeDir = __testing.getStoreDir()
      await mkdir(storeDir, { recursive: true })
      await writeFile(__testing.getIndexPath(), 'not-json!!!', 'utf-8')

      const index = await __testing.readIndex()
      expect(index).toEqual({ metas: [] })
    })

    it('returns empty metas when index is valid JSON but has no metas array', async () => {
      const storeDir = __testing.getStoreDir()
      await mkdir(storeDir, { recursive: true })
      await writeFile(__testing.getIndexPath(), JSON.stringify({ foo: 'bar' }), 'utf-8')

      const index = await __testing.readIndex()
      expect(index).toEqual({ metas: [] })
    })

    it('reads a valid index file', async () => {
      const meta = {
        id: 'abc-123',
        filename: 'packs/abc-123.json',
        name: 'My Theme',
        version: '1.0.0',
        savedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }
      const storeDir = __testing.getStoreDir()
      await mkdir(storeDir, { recursive: true })
      await writeFile(__testing.getIndexPath(), JSON.stringify({ metas: [meta] }), 'utf-8')

      const index = await __testing.readIndex()
      expect(index.metas).toHaveLength(1)
      expect(index.metas[0].name).toBe('My Theme')
    })

    it('writeIndex creates the store directory if missing', async () => {
      await __testing.writeIndex({ metas: [] })
      const raw = await readFile(__testing.getIndexPath(), 'utf-8')
      expect(JSON.parse(raw)).toEqual({ metas: [] })
    })
  })

  describe('savePack', () => {
    it('persists meta + pack body and notifies sync', async () => {
      const raw = makeValidPack({ name: 'Nord' })
      const result = await savePack({ raw })

      expect(result.success).toBe(true)
      expect(result.data?.name).toBe('Nord')
      expect(result.data?.version).toBe('1.0.0')
      expect(result.data?.id).toBeTruthy()
      expect(result.data?.savedAt).toBeTruthy()
      expect(result.data?.updatedAt).toBeTruthy()

      expect(notifyChange).toHaveBeenCalledWith(__testing.packSyncUnit(result.data!.id))
      expect(notifyChange).toHaveBeenCalledWith(THEME_INDEX_SYNC_UNIT)

      const packPath = __testing.getPackPath(result.data!.id)
      const diskRaw = await readFile(packPath, 'utf-8')
      const parsed = JSON.parse(diskRaw) as { name: string }
      expect(parsed.name).toBe('Nord')
    })

    it('overwrites an existing pack with the same name (auto-overwrite)', async () => {
      const raw1 = makeValidPack({ name: 'Dracula', version: '1.0.0' })
      const first = await savePack({ raw: raw1 })
      expect(first.success).toBe(true)

      const raw2 = makeValidPack({ name: 'Dracula', version: '2.0.0' })
      const second = await savePack({ raw: raw2 })
      expect(second.success).toBe(true)
      expect(second.data?.id).toBe(first.data!.id)
      expect(second.data?.version).toBe('2.0.0')

      const metas = await listMetas()
      expect(metas.filter((m) => m.name === 'Dracula')).toHaveLength(1)
    })

    it('overwrites when explicit id is provided', async () => {
      const raw1 = makeValidPack({ name: 'Solarized' })
      const first = await savePack({ raw: raw1 })
      expect(first.success).toBe(true)

      const raw2 = makeValidPack({ name: 'Solarized Updated', version: '2.0.0' })
      const second = await savePack({ raw: raw2, id: first.data!.id })
      expect(second.success).toBe(true)
      expect(second.data?.id).toBe(first.data!.id)
      expect(second.data?.name).toBe('Solarized Updated')
    })

    it('rejects invalid theme pack data', async () => {
      const result = await savePack({ raw: { name: 123, version: 'bad' } })
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('INVALID_FILE')
    })

    it('rejects a pack with missing colors', async () => {
      const result = await savePack({ raw: { name: 'X', version: '1.0.0', colorScheme: 'dark', colors: {} } })
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('INVALID_FILE')
    })

    it('preserves hubPostId when provided', async () => {
      const raw = makeValidPack({ name: 'Hub Theme' })
      const result = await savePack({ raw, hubPostId: 'hub-id-1' })
      expect(result.success).toBe(true)
      expect(result.data?.hubPostId).toBe('hub-id-1')
    })

    it('preserves hubUpdatedAt when provided', async () => {
      const raw = makeValidPack({ name: 'Hub Updated Theme' })
      const ts = '2026-01-15T10:00:00.000Z'
      const result = await savePack({ raw, hubPostId: 'hub-id-x', hubUpdatedAt: ts })
      expect(result.success).toBe(true)
      expect(result.data?.hubUpdatedAt).toBe(ts)
    })

    it('clears hubPostId when null is passed', async () => {
      const raw = makeValidPack({ name: 'Clear Hub' })
      const first = await savePack({ raw, hubPostId: 'hub-id-2' })
      expect(first.data?.hubPostId).toBe('hub-id-2')

      const raw2 = makeValidPack({ name: 'Clear Hub', version: '1.0.0' })
      const second = await savePack({ raw: raw2, id: first.data!.id, hubPostId: null })
      expect(second.success).toBe(true)
      expect(second.data?.hubPostId).toBeUndefined()
    })

    it('treats empty-string hubUpdatedAt as null (explicit clear)', async () => {
      const raw = makeValidPack({ name: 'Empty Updated' })
      const first = await savePack({ raw, hubPostId: 'hid', hubUpdatedAt: '2026-01-01T00:00:00Z' })
      expect(first.data?.hubUpdatedAt).toBe('2026-01-01T00:00:00Z')

      const raw2 = makeValidPack({ name: 'Empty Updated' })
      const second = await savePack({ raw: raw2, id: first.data!.id, hubUpdatedAt: '' })
      expect(second.success).toBe(true)
      expect(second.data?.hubUpdatedAt).toBeUndefined()
    })

    it('preserves savedAt across overwrites', async () => {
      const raw = makeValidPack({ name: 'Keep SavedAt' })
      const first = await savePack({ raw })
      const originalSavedAt = first.data!.savedAt

      const raw2 = makeValidPack({ name: 'Keep SavedAt', version: '2.0.0' })
      const second = await savePack({ raw: raw2 })
      expect(second.data?.savedAt).toBe(originalSavedAt)
    })

    it('returns DUPLICATE_NAME when another active pack has the same name and a different explicit id', async () => {
      const raw1 = makeValidPack({ name: 'UniqueA' })
      await savePack({ raw: raw1 })

      const raw2 = makeValidPack({ name: 'UniqueA' })
      const result = await savePack({ raw: raw2, id: 'different-explicit-id' })
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('DUPLICATE_NAME')
    })
  })

  describe('getPack', () => {
    it('retrieves a saved pack', async () => {
      const raw = makeValidPack({ name: 'Retrievable' })
      const saved = await savePack({ raw })

      const result = await getPack(saved.data!.id)
      expect(result.success).toBe(true)
      expect(result.data?.meta.name).toBe('Retrievable')
      expect(result.data?.pack.name).toBe('Retrievable')
      expect(result.data?.pack.colorScheme).toBe('dark')
    })

    it('returns NOT_FOUND for non-existent id', async () => {
      const result = await getPack('non-existent-id')
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('NOT_FOUND')
    })

    it('returns NOT_FOUND for deleted (tombstoned) pack', async () => {
      const raw = makeValidPack({ name: 'ToDelete' })
      const saved = await savePack({ raw })
      await deletePack(saved.data!.id)

      const result = await getPack(saved.data!.id)
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('NOT_FOUND')
    })

    it('returns NOT_FOUND for an unsafe pack id', async () => {
      const result = await getPack('../../../etc/passwd')
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('NOT_FOUND')
    })
  })

  describe('listMetas', () => {
    it('returns empty array when no packs exist', async () => {
      const metas = await listMetas()
      expect(metas).toEqual([])
    })

    it('excludes deleted entries', async () => {
      const a = await savePack({ raw: makeValidPack({ name: 'Alpha' }) })
      await savePack({ raw: makeValidPack({ name: 'Beta' }) })
      await deletePack(a.data!.id)

      const metas = await listMetas()
      expect(metas).toHaveLength(1)
      expect(metas[0].name).toBe('Beta')
    })

    it('returns all active entries in order', async () => {
      await savePack({ raw: makeValidPack({ name: 'First' }) })
      await savePack({ raw: makeValidPack({ name: 'Second' }) })
      await savePack({ raw: makeValidPack({ name: 'Third' }) })

      const metas = await listMetas()
      expect(metas.map((m) => m.name)).toEqual(['First', 'Second', 'Third'])
    })
  })

  describe('listAllMetas', () => {
    it('includes tombstoned entries', async () => {
      const a = await savePack({ raw: makeValidPack({ name: 'Alive' }) })
      await savePack({ raw: makeValidPack({ name: 'Also Alive' }) })
      await deletePack(a.data!.id)

      const all = await listAllMetas()
      expect(all).toHaveLength(2)

      const deleted = all.find((m) => m.name === 'Alive')
      expect(deleted?.deletedAt).toBeTruthy()

      const active = all.find((m) => m.name === 'Also Alive')
      expect(active?.deletedAt).toBeUndefined()
    })
  })

  describe('renamePack', () => {
    it('updates the index name and pack body on disk', async () => {
      const saved = await savePack({ raw: makeValidPack({ name: 'OldName' }) })
      const result = await renamePack(saved.data!.id, 'NewName')

      expect(result.success).toBe(true)
      expect(result.data?.name).toBe('NewName')

      const record = await getPack(saved.data!.id)
      expect(record.data?.meta.name).toBe('NewName')
      expect(record.data?.pack.name).toBe('NewName')

      expect(notifyChange).toHaveBeenCalledWith(__testing.packSyncUnit(saved.data!.id))
      expect(notifyChange).toHaveBeenCalledWith(THEME_INDEX_SYNC_UNIT)
    })

    it('rejects rename to an existing name (case-insensitive)', async () => {
      const a = await savePack({ raw: makeValidPack({ name: 'ThemeA' }) })
      await savePack({ raw: makeValidPack({ name: 'ThemeB' }) })

      const result = await renamePack(a.data!.id, 'themeb')
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('DUPLICATE_NAME')
    })

    it('allows renaming to own name with different casing', async () => {
      const saved = await savePack({ raw: makeValidPack({ name: 'myTheme' }) })
      const result = await renamePack(saved.data!.id, 'MyTheme')

      expect(result.success).toBe(true)
      expect(result.data?.name).toBe('MyTheme')
    })

    it('rejects empty name', async () => {
      const saved = await savePack({ raw: makeValidPack({ name: 'Valid' }) })
      const result = await renamePack(saved.data!.id, '   ')

      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('INVALID_NAME')
    })

    it('rejects name exceeding max length', async () => {
      const saved = await savePack({ raw: makeValidPack({ name: 'Valid' }) })
      const longName = 'x'.repeat(THEME_PACK_LIMITS.MAX_NAME_LENGTH + 1)
      const result = await renamePack(saved.data!.id, longName)

      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('INVALID_NAME')
    })

    it('returns NOT_FOUND for non-existent id', async () => {
      const result = await renamePack('no-such-id', 'Whatever')
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('NOT_FOUND')
    })

    it('returns NOT_FOUND for deleted pack', async () => {
      const saved = await savePack({ raw: makeValidPack({ name: 'Deleted' }) })
      await deletePack(saved.data!.id)

      const result = await renamePack(saved.data!.id, 'Renamed')
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('NOT_FOUND')
    })
  })

  describe('deletePack', () => {
    it('applies tombstone and excludes from listMetas', async () => {
      const saved = await savePack({ raw: makeValidPack({ name: 'Doomed' }) })
      const result = await deletePack(saved.data!.id)

      expect(result.success).toBe(true)

      const metas = await listMetas()
      expect(metas.find((m) => m.id === saved.data!.id)).toBeUndefined()

      const allMetas = await listAllMetas()
      const tombstoned = allMetas.find((m) => m.id === saved.data!.id)
      expect(tombstoned?.deletedAt).toBeTruthy()

      expect(notifyChange).toHaveBeenCalledWith(__testing.packSyncUnit(saved.data!.id))
      expect(notifyChange).toHaveBeenCalledWith(THEME_INDEX_SYNC_UNIT)
    })

    it('returns NOT_FOUND for non-existent id', async () => {
      const result = await deletePack('ghost-id')
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('NOT_FOUND')
    })

    it('pack body file remains on disk after soft-delete', async () => {
      const saved = await savePack({ raw: makeValidPack({ name: 'SoftDelete' }) })
      const packPath = __testing.getPackPath(saved.data!.id)

      await deletePack(saved.data!.id)

      const raw = await readFile(packPath, 'utf-8')
      expect(raw).toBeTruthy()
    })
  })

  describe('setHubPostId', () => {
    it('sets hubPostId on a pack', async () => {
      const saved = await savePack({ raw: makeValidPack({ name: 'HubSet' }) })
      const result = await setHubPostId(saved.data!.id, 'hub-post-123')

      expect(result.success).toBe(true)
      expect(result.data?.hubPostId).toBe('hub-post-123')
      expect(notifyChange).toHaveBeenCalledWith(THEME_INDEX_SYNC_UNIT)
    })

    it('clears hubPostId and hubUpdatedAt when null is passed', async () => {
      const saved = await savePack({
        raw: makeValidPack({ name: 'HubClear' }),
        hubPostId: 'hub-x',
        hubUpdatedAt: '2026-01-01T00:00:00Z',
      })
      expect(saved.data?.hubPostId).toBe('hub-x')
      expect(saved.data?.hubUpdatedAt).toBe('2026-01-01T00:00:00Z')

      const result = await setHubPostId(saved.data!.id, null)
      expect(result.success).toBe(true)
      expect(result.data?.hubPostId).toBeUndefined()
      expect(result.data?.hubUpdatedAt).toBeUndefined()
    })

    it('trims whitespace from hubPostId', async () => {
      const saved = await savePack({ raw: makeValidPack({ name: 'HubTrim' }) })
      const result = await setHubPostId(saved.data!.id, '  hub-trimmed  ')

      expect(result.success).toBe(true)
      expect(result.data?.hubPostId).toBe('hub-trimmed')
    })

    it('treats empty string as null (clears)', async () => {
      const saved = await savePack({
        raw: makeValidPack({ name: 'HubEmpty' }),
        hubPostId: 'existing',
      })
      const result = await setHubPostId(saved.data!.id, '   ')

      expect(result.success).toBe(true)
      expect(result.data?.hubPostId).toBeUndefined()
    })

    it('returns NOT_FOUND for non-existent id', async () => {
      const result = await setHubPostId('no-such-id', 'hub-post')
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('NOT_FOUND')
    })
  })

  describe('hasActiveName', () => {
    it('returns true for existing active name (case-insensitive)', async () => {
      await savePack({ raw: makeValidPack({ name: 'Monokai' }) })

      const result = await hasActiveName('MONOKAI')
      expect(result.success).toBe(true)
      expect(result.data).toBe(true)
    })

    it('returns false when name does not exist', async () => {
      const result = await hasActiveName('NonExistent')
      expect(result.success).toBe(true)
      expect(result.data).toBe(false)
    })

    it('returns false when the only match is excluded by id', async () => {
      const saved = await savePack({ raw: makeValidPack({ name: 'Catppuccin' }) })

      const result = await hasActiveName('Catppuccin', saved.data!.id)
      expect(result.success).toBe(true)
      expect(result.data).toBe(false)
    })

    it('returns true when excludeId does not match the found entry', async () => {
      const saved = await savePack({ raw: makeValidPack({ name: 'Gruvbox' }) })

      const result = await hasActiveName('Gruvbox', 'some-other-id')
      expect(result.success).toBe(true)
      expect(result.data).toBe(true)
      expect(saved.data?.id).not.toBe('some-other-id')
    })

    it('returns false for deleted pack name', async () => {
      const saved = await savePack({ raw: makeValidPack({ name: 'Deleted Theme' }) })
      await deletePack(saved.data!.id)

      const result = await hasActiveName('Deleted Theme')
      expect(result.success).toBe(true)
      expect(result.data).toBe(false)
    })
  })

  describe('purgeExpiredTombstones', () => {
    it('removes tombstones older than TTL and deletes pack body', async () => {
      const saved = await savePack({ raw: makeValidPack({ name: 'Expired' }) })
      const packPath = __testing.getPackPath(saved.data!.id)

      const index = await __testing.readIndex()
      const meta = index.metas.find((m) => m.id === saved.data!.id)!
      const expiredDate = new Date(Date.now() - THEME_PACK_TOMBSTONE_TTL_MS - 1000).toISOString()
      meta.deletedAt = expiredDate
      meta.updatedAt = expiredDate
      await __testing.writeIndex(index)

      vi.mocked(notifyChange).mockClear()

      await purgeExpiredTombstones()

      const afterIndex = await __testing.readIndex()
      expect(afterIndex.metas.find((m) => m.id === saved.data!.id)).toBeUndefined()

      expect(notifyChange).toHaveBeenCalledWith(THEME_INDEX_SYNC_UNIT)

      await expect(readFile(packPath, 'utf-8')).rejects.toThrow()
    })

    it('preserves non-expired tombstones', async () => {
      const saved = await savePack({ raw: makeValidPack({ name: 'Recent' }) })
      await deletePack(saved.data!.id)

      vi.mocked(notifyChange).mockClear()

      await purgeExpiredTombstones()

      const afterIndex = await __testing.readIndex()
      const meta = afterIndex.metas.find((m) => m.id === saved.data!.id)
      expect(meta).toBeTruthy()
      expect(meta?.deletedAt).toBeTruthy()

      expect(notifyChange).not.toHaveBeenCalled()
    })

    it('does nothing when there are no tombstones', async () => {
      await savePack({ raw: makeValidPack({ name: 'Alive' }) })

      vi.mocked(notifyChange).mockClear()

      await purgeExpiredTombstones()

      expect(notifyChange).not.toHaveBeenCalled()
    })

    it('preserves active entries when purging expired tombstones', async () => {
      await savePack({ raw: makeValidPack({ name: 'Keeper' }) })
      const doomed = await savePack({ raw: makeValidPack({ name: 'Doomed' }) })

      const index = await __testing.readIndex()
      const meta = index.metas.find((m) => m.id === doomed.data!.id)!
      meta.deletedAt = new Date(Date.now() - THEME_PACK_TOMBSTONE_TTL_MS - 1000).toISOString()
      await __testing.writeIndex(index)

      await purgeExpiredTombstones()

      const afterIndex = await __testing.readIndex()
      expect(afterIndex.metas).toHaveLength(1)
      expect(afterIndex.metas[0].name).toBe('Keeper')
    })
  })

  describe('packSyncUnit', () => {
    it('returns the expected sync unit path', () => {
      expect(__testing.packSyncUnit('abc-123')).toBe('themes/packs/abc-123')
    })
  })

  describe('getPackPath', () => {
    it('rejects unsafe pack ids', () => {
      expect(() => __testing.getPackPath('../escape')).toThrow('Invalid packId')
      expect(() => __testing.getPackPath('has spaces')).toThrow('Invalid packId')
      expect(() => __testing.getPackPath('')).toThrow('Invalid packId')
    })

    it('accepts valid pack ids', () => {
      expect(() => __testing.getPackPath('valid-id-123')).not.toThrow()
      expect(() => __testing.getPackPath('abc_def')).not.toThrow()
    })
  })
})
