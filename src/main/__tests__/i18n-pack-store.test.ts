// SPDX-License-Identifier: GPL-2.0-or-later
//
// Focused store-level coverage for `i18n-pack-store.ts`'s `reorderActive`
// (Phase 2 of the pack-modal-unification plan). Mirrors the equivalent
// `reorderActive` describe blocks in `key-label-store.test.ts` and
// `theme-pack-store.test.ts` — no pre-existing test file covered this
// store before, so this file stays scoped to reorder rather than
// attempting full store coverage in the same pass.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
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
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
}))

vi.mock('../sync/sync-service', () => ({
  notifyChange: vi.fn(),
}))

import { notifyChange } from '../sync/sync-service'
import {
  savePack,
  listMetas,
  listAllMetas,
  deletePack,
  reorderActive,
  setHubPostId,
} from '../i18n-pack-store'
import { I18N_INDEX_SYNC_UNIT } from '../../shared/types/i18n-store'

function makePack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Test Pack',
    version: '0.1.0',
    common: { save: 'Save' },
    ...overrides,
  }
}

describe('i18n-pack-store reorderActive', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'i18n-pack-store-test-'))
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  it('reorders active metas by the given ID array', async () => {
    const a = await savePack({ pack: makePack({ name: 'Alpha' }) })
    const b = await savePack({ pack: makePack({ name: 'Beta' }) })
    const c = await savePack({ pack: makePack({ name: 'Gamma' }) })

    await reorderActive([c.data!.id, a.data!.id, b.data!.id])

    const metas = await listMetas()
    const names = metas.map((m) => m.name)
    expect(names.indexOf('Gamma')).toBeLessThan(names.indexOf('Alpha'))
    expect(names.indexOf('Alpha')).toBeLessThan(names.indexOf('Beta'))
  })

  it('keeps tombstones in the tail after reordered active metas', async () => {
    const a = await savePack({ pack: makePack({ name: 'Keep' }) })
    const b = await savePack({ pack: makePack({ name: 'Remove' }) })
    await deletePack(b.data!.id)

    await reorderActive([a.data!.id])

    const all = await listAllMetas()
    const tombstoned = all.find((m) => m.id === b.data!.id)
    expect(tombstoned).toBeDefined()
    expect(tombstoned!.deletedAt).toBeTruthy()

    const activeIds = all.filter((m) => !m.deletedAt).map((m) => m.id)
    const tombIdx = all.findIndex((m) => m.id === b.data!.id)
    const lastActiveIdx = all.findIndex((m) => m.id === activeIds[activeIds.length - 1])
    expect(tombIdx).toBeGreaterThan(lastActiveIdx)
  })

  it('appends unlisted active IDs at the end', async () => {
    const a = await savePack({ pack: makePack({ name: 'Listed' }) })
    await savePack({ pack: makePack({ name: 'Unlisted' }) })

    await reorderActive([a.data!.id])

    const metas = await listMetas()
    const names = metas.map((m) => m.name)
    expect(names.indexOf('Listed')).toBeLessThan(names.indexOf('Unlisted'))
  })

  it('bumps updatedAt on all reordered metas', async () => {
    const a = await savePack({ pack: makePack({ name: 'TimestampA' }) })
    const b = await savePack({ pack: makePack({ name: 'TimestampB' }) })
    const origA = a.data!.updatedAt
    const origB = b.data!.updatedAt

    try {
      vi.useFakeTimers()
      vi.setSystemTime(Date.parse(origB) + 1000)
      await reorderActive([b.data!.id, a.data!.id])
    } finally {
      vi.useRealTimers()
    }

    const metas = await listMetas()
    const metaA = metas.find((m) => m.id === a.data!.id)!
    const metaB = metas.find((m) => m.id === b.data!.id)!
    expect(metaA.updatedAt).not.toBe(origA)
    expect(metaB.updatedAt).not.toBe(origB)
  })

  it('only bumps I18N_INDEX_SYNC_UNIT — pack bodies are untouched', async () => {
    await savePack({ pack: makePack({ name: 'Notify' }) })
    vi.mocked(notifyChange).mockClear()

    await reorderActive([])

    expect(notifyChange).toHaveBeenCalledWith(I18N_INDEX_SYNC_UNIT)
    expect(notifyChange).toHaveBeenCalledTimes(1)
  })
})

describe('i18n-pack-store uploaderName / setHubPostId (Phase 3)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'i18n-pack-store-test-'))
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  it('savePack persists uploaderName on the meta', async () => {
    const saved = await savePack({ pack: makePack({ name: 'Authored' }), uploaderName: 'alice' })
    expect(saved.data!.uploaderName).toBe('alice')
  })

  it('legacy metas (saved before this field existed) have no uploaderName', async () => {
    const saved = await savePack({ pack: makePack({ name: 'Legacy' }) })
    expect(saved.data!.uploaderName).toBeUndefined()
  })

  it('setHubPostId sets uploaderName and hubUpdatedAt when both are provided (Upload)', async () => {
    const saved = await savePack({ pack: makePack({ name: 'Upload Me' }) })
    const result = await setHubPostId(saved.data!.id, 'hub-1', 'alice', '2026-05-01T00:00:00.000Z')
    expect(result.data!.hubPostId).toBe('hub-1')
    expect(result.data!.uploaderName).toBe('alice')
    expect(result.data!.hubUpdatedAt).toBe('2026-05-01T00:00:00.000Z')
  })

  it('setHubPostId leaves uploaderName untouched when omitted (Update)', async () => {
    const saved = await savePack({ pack: makePack({ name: 'Update Me' }) })
    await setHubPostId(saved.data!.id, 'hub-2', 'alice', '2026-05-01T00:00:00.000Z')
    const updated = await setHubPostId(saved.data!.id, 'hub-2', undefined, '2026-06-01T00:00:00.000Z')
    expect(updated.data!.uploaderName).toBe('alice')
    expect(updated.data!.hubUpdatedAt).toBe('2026-06-01T00:00:00.000Z')
  })

  it('detaching (hubPostId: null) drops hubUpdatedAt but keeps uploaderName', async () => {
    const saved = await savePack({ pack: makePack({ name: 'Detach Me' }) })
    await setHubPostId(saved.data!.id, 'hub-3', 'alice', '2026-05-01T00:00:00.000Z')
    const detached = await setHubPostId(saved.data!.id, null)
    expect(detached.data!.hubPostId).toBeUndefined()
    expect(detached.data!.hubUpdatedAt).toBeUndefined()
    expect(detached.data!.uploaderName).toBe('alice')
  })
})
