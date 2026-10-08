// SPDX-License-Identifier: GPL-2.0-or-later
//
// Focused store-level coverage for `i18n-pack-store.ts`'s `reorderActive`.
// Mirrors the equivalent `reorderActive` describe blocks in
// `key-label-store.test.ts` and `theme-pack-store.test.ts` — this file
// stays scoped to reorder rather than attempting full store coverage.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'

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

// The real logger is a module-level singleton (cached log directory) that
// doesn't play well with a fresh mkdtemp'd userData per test — mock it out,
// same as sync-bundle.run-log.test.ts does.
vi.mock('../logger', () => ({
  log: vi.fn(),
}))

import { notifyChange } from '../sync/sync-service'
import { log } from '../logger'
import {
  savePack,
  listMetas,
  listAllMetas,
  getPack,
  deletePack,
  renamePack,
  reorderActive,
  setHubPostId,
  mergeSyncedIndex,
  runGcUnderLock,
  __testing,
} from '../i18n-pack-store'
import { BUILTIN_ENGLISH_PACK_ID, I18N_INDEX_SYNC_UNIT } from '../../shared/types/i18n-store'

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

  // The order is per device (`mergeSyncedIndex` keeps the local order), so
  // a reorder must not give the metas a newer LWW timestamp: that would let
  // a drag win against another device's concurrent delete or edit.
  it('keeps updatedAt on reordered metas and persists the order', async () => {
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
    expect(metaA.updatedAt).toBe(origA)
    expect(metaB.updatedAt).toBe(origB)

    const onDisk = JSON.parse(await readFile(__testing.getIndexPath(), 'utf-8')) as { metas: { id: string }[] }
    const ids = onDisk.metas.map((m) => m.id)
    expect(ids.indexOf(b.data!.id)).toBeLessThan(ids.indexOf(a.data!.id))
  })

  it('a reorder does not override a remote delete made after the last save', async () => {
    const a = await savePack({ pack: makePack({ name: 'Deleted Elsewhere' }) })
    const b = await savePack({ pack: makePack({ name: 'Other' }) })
    const savedAt = Date.parse(a.data!.updatedAt)
    const remoteDeletedAt = new Date(savedAt + 1000).toISOString()

    try {
      vi.useFakeTimers()
      vi.setSystemTime(savedAt + 2000)
      await reorderActive([b.data!.id, a.data!.id])
    } finally {
      vi.useRealTimers()
    }

    const result = await mergeSyncedIndex([
      { ...a.data!, updatedAt: remoteDeletedAt, deletedAt: remoteDeletedAt },
    ])

    expect(result.applied).toBe(true)
    const merged = (await listAllMetas()).find((m) => m.id === a.data!.id)
    expect(merged?.deletedAt).toBe(remoteDeletedAt)
  })

  it('does not queue a sync — the order is not synced', async () => {
    const a = await savePack({ pack: makePack({ name: 'Notify' }) })
    vi.mocked(notifyChange).mockClear()

    await reorderActive([a.data!.id])

    expect(notifyChange).not.toHaveBeenCalled()
  })
})

describe('i18n-pack-store uploaderName / setHubPostId', () => {
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

describe('i18n-pack-store built-in English entry (ensureBuiltinEnglishEntry)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'i18n-pack-store-test-'))
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  it('creates the built-in English entry on first listMetas call, on a fresh store', async () => {
    const metas = await listMetas()
    const builtin = metas.find((m) => m.id === BUILTIN_ENGLISH_PACK_ID)
    expect(builtin).toBeDefined()
    expect(builtin!.name).toBe('English')
    expect(builtin!.enabled).toBe(true)
    expect(builtin!.uploaderName).toBe('pipette')
  })

  it('is idempotent — a second listMetas call does not duplicate or re-timestamp the entry', async () => {
    const first = await listMetas()
    const builtinFirst = first.find((m) => m.id === BUILTIN_ENGLISH_PACK_ID)!

    const second = await listMetas()
    const builtinMatches = second.filter((m) => m.id === BUILTIN_ENGLISH_PACK_ID)
    expect(builtinMatches).toHaveLength(1)
    expect(builtinMatches[0].savedAt).toBe(builtinFirst.savedAt)
    expect(builtinMatches[0].updatedAt).toBe(builtinFirst.updatedAt)
  })

  it('legacy migration: an index with existing packs but no built-in entry gets it ensured at position 0', async () => {
    // Simulate a pre-migration index: import real packs *before* any
    // listMetas/listAllMetas call has ever ensured the builtin entry.
    await savePack({ pack: makePack({ name: 'Alpha' }) })
    await savePack({ pack: makePack({ name: 'Beta' }) })

    const metas = await listMetas()
    expect(metas[0].id).toBe(BUILTIN_ENGLISH_PACK_ID)
    expect(metas.map((m) => m.name)).toEqual(['English', 'Alpha', 'Beta'])
  })

  it('also ensures the entry via listAllMetas (tombstones included)', async () => {
    const all = await listAllMetas()
    expect(all.some((m) => m.id === BUILTIN_ENGLISH_PACK_ID)).toBe(true)
  })

  it('deletePack rejects deleting the built-in English entry', async () => {
    await listMetas() // ensure it exists first
    const result = await deletePack(BUILTIN_ENGLISH_PACK_ID)
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('INVALID_NAME')

    const metas = await listMetas()
    expect(metas.some((m) => m.id === BUILTIN_ENGLISH_PACK_ID)).toBe(true)
  })

  it('reorderActive can move the built-in English entry like any other id', async () => {
    await listMetas() // ensure it exists at position 0
    const a = await savePack({ pack: makePack({ name: 'Alpha' }) })

    await reorderActive([a.data!.id, BUILTIN_ENGLISH_PACK_ID])

    const metas = await listMetas()
    expect(metas.map((m) => m.id)).toEqual([a.data!.id, BUILTIN_ENGLISH_PACK_ID])
  })

  it('rename and export are not store-level guarded (matching QWERTY precedent) — only delete is', async () => {
    await listMetas()
    // renamePack succeeds at the store level; the UI is what prevents
    // this in practice (LanguageInstalledRow's canRename gates on
    // `!row.isBuiltin`, independent of packId nullness).
    const renamed = await renamePack(BUILTIN_ENGLISH_PACK_ID, 'Renamed English')
    expect(renamed.success).toBe(true)
  })

  // --- name-collision guard -----------------------------------------------

  it('rejects a same-named import (case-insensitive, no explicit id) instead of silently overwriting the built-in entry', async () => {
    await listMetas() // ensure the built-in entry exists

    const result = await savePack({ pack: makePack({ name: 'english' }) })
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('DUPLICATE_NAME')

    // Builtin untouched.
    const metas = await listMetas()
    const builtin = metas.find((m) => m.id === BUILTIN_ENGLISH_PACK_ID)!
    expect(builtin.name).toBe('English')
    expect(builtin.version).toBe('0.0.0')
    const record = await getPack(BUILTIN_ENGLISH_PACK_ID)
    expect(record.data!.pack).toEqual({ name: 'English', version: '0.0.0' })
  })

  it('rejects a save that explicitly targets the built-in id, regardless of name', async () => {
    await listMetas()
    const result = await savePack({ id: BUILTIN_ENGLISH_PACK_ID, pack: makePack({ name: 'Hacked Name' }) })
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('INVALID_NAME')

    const metas = await listMetas()
    expect(metas.find((m) => m.id === BUILTIN_ENGLISH_PACK_ID)!.name).toBe('English')
  })

  // --- serialized RMW paths -----------------------------------------------

  it('two overlapping mutations (rename + reorder) are serialized — both land, neither clobbers the other', async () => {
    const a = await savePack({ pack: makePack({ name: 'Alpha' }) })
    const b = await savePack({ pack: makePack({ name: 'Beta' }) })

    const [renameResult, reorderResult] = await Promise.all([
      renamePack(a.data!.id, 'Alpha Renamed'),
      reorderActive([b.data!.id, a.data!.id]),
    ])

    expect(renameResult.success).toBe(true)
    expect(reorderResult.success).toBe(true)

    const metas = await listAllMetas()
    const metaA = metas.find((m) => m.id === a.data!.id)!
    expect(metaA.name).toBe('Alpha Renamed')
    const activeIds = metas.filter((m) => !m.deletedAt && m.id !== BUILTIN_ENGLISH_PACK_ID).map((m) => m.id)
    expect(activeIds.indexOf(b.data!.id)).toBeLessThan(activeIds.indexOf(a.data!.id))
  })

  // --- complete the sync exclusion ----------------------------------------

  it('renaming the built-in entry does not notifyChange its pack-body sync unit (only the index)', async () => {
    await listMetas()
    vi.mocked(notifyChange).mockClear()

    await renamePack(BUILTIN_ENGLISH_PACK_ID, 'Renamed English')

    const units = vi.mocked(notifyChange).mock.calls.map((c) => c[0])
    expect(units).not.toContain(`i18n/packs/${BUILTIN_ENGLISH_PACK_ID}`)
    expect(units).toContain(I18N_INDEX_SYNC_UNIT)
  })

  it('ensureBuiltinEnglishEntry never notifyChanges the pack-body sync unit on first creation', async () => {
    vi.mocked(notifyChange).mockClear()
    await listMetas() // first-ever call: creates the entry
    const units = vi.mocked(notifyChange).mock.calls.map((c) => c[0])
    expect(units).not.toContain(`i18n/packs/${BUILTIN_ENGLISH_PACK_ID}`)
  })

  // --- ensure recreates a missing body ------------------------------------

  it('self-heals a missing body file when the meta already exists (e.g. delivered by sync before the local body did)', async () => {
    // Simulate a synced index that delivered the meta with no local
    // body file ever written on this machine.
    await __testing.writeIndex({
      metas: [{
        id: BUILTIN_ENGLISH_PACK_ID,
        filename: 'packs/builtin-english.json',
        name: 'English',
        version: '0.0.0',
        enabled: true,
        uploaderName: 'pipette',
        savedAt: 'now',
        updatedAt: 'now',
      }],
    })
    const beforeGet = await getPack(BUILTIN_ENGLISH_PACK_ID)
    expect(beforeGet.success).toBe(false) // sanity: body genuinely absent

    await listMetas() // triggers ensureBuiltinEnglishEntry's self-heal

    const afterGet = await getPack(BUILTIN_ENGLISH_PACK_ID)
    expect(afterGet.success).toBe(true)
    expect(afterGet.data!.pack).toEqual({ name: 'English', version: '0.0.0' })
  })
})

describe('i18n-pack-store sync robustness fixes (utimes degrade / pin CAS / malformed metas)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'i18n-pack-store-test-'))
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  // --- Fix 1: utimes failure degrades to accept-with-warn -------------------

  it('mergeSyncedIndex drops non-object entries (e.g. null) instead of crashing, keeping valid siblings', async () => {
    const goodMeta = {
      id: 'good-1',
      filename: 'packs/good-1.json',
      name: 'Good',
      version: '1.0.0',
      enabled: true,
      savedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    const result = await mergeSyncedIndex([null, goodMeta])

    expect(result.applied).toBe(true)
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('dropped 1 unsafe remote meta id'))
    const all = await listAllMetas()
    expect(all.some((m) => m.id === 'good-1')).toBe(true)
  })
})

// Orphan-file removal itself is now shared body (sweepOrphanFiles,
// tested directly in sweep-orphan-pack-bodies.test.ts) — this file
// keeps only a thin lock-behavior test: runGcUnderLock must not be able
// to race a concurrent savePack's own read-modify-write of the index.
describe('i18n-pack-store runGcUnderLock (D.2/single-lock GC: wired post-pass, lock-held)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'i18n-pack-store-test-'))
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  it('sweeps an orphaned pack body file with no matching index entry', async () => {
    const kept = await savePack({ pack: makePack({ name: 'Kept' }) })
    await writeFile(join(__testing.getPacksDir(), 'orphan-id.json'), JSON.stringify(makePack()), 'utf-8')

    const result = await runGcUnderLock()

    expect(result.swept).toBe(1)
    const remaining = await readdir(__testing.getPacksDir())
    expect(remaining).toContain(`${kept.data!.id}.json`)
    expect(remaining).not.toContain('orphan-id.json')
  })

  it('serializes against a concurrent savePack instead of racing it (locked via withIndexWriteLock)', async () => {
    // A brand-new pack's body write and its index write happen inside the
    // same lock-held savePack call — runGcUnderLock's sweep must not be
    // able to observe the body without the index (which would
    // misclassify it as an orphan) by interleaving between the two. Run
    // both concurrently: whichever gets the lock first must complete
    // atomically before the other starts.
    const [saveResult] = await Promise.all([
      savePack({ pack: makePack({ name: 'Racer' }) }),
      runGcUnderLock(),
    ])

    const all = await listAllMetas()
    expect(all.some((m) => m.id === saveResult.data!.id)).toBe(true)
    const files = await readdir(__testing.getPacksDir())
    expect(files).toContain(`${saveResult.data!.id}.json`)
  })

  // A corrupt/missing index must not be treated as "legitimately
  // empty" when pack bodies still exist on disk — an empty-roster
  // fallback there would make the sweep delete every one of them.
  it('skips both purge and sweep when index.json is truncated/unparseable, keeping every pack body intact', async () => {
    const saved = await savePack({ pack: makePack({ name: 'Survivor' }) })
    await writeFile(__testing.getIndexPath(), '{ "metas": [ not valid json', 'utf-8')

    const result = await runGcUnderLock()

    expect(result).toEqual({ purged: 0, swept: 0 })
    const remaining = await readdir(__testing.getPacksDir())
    expect(remaining).toContain(`${saved.data!.id}.json`)
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining(I18N_INDEX_SYNC_UNIT))
  })

  it('skips both purge and sweep when index.json is missing but pack bodies exist', async () => {
    const saved = await savePack({ pack: makePack({ name: 'Orphaned-by-missing-index' }) })
    await rm(__testing.getIndexPath(), { force: true })

    const result = await runGcUnderLock()

    expect(result).toEqual({ purged: 0, swept: 0 })
    const remaining = await readdir(__testing.getPacksDir())
    expect(remaining).toContain(`${saved.data!.id}.json`)
  })

  it('treats a missing index as legitimately empty when the packs dir is also empty/missing', async () => {
    const result = await runGcUnderLock()

    expect(result).toEqual({ purged: 0, swept: 0 })
  })

  // options.skipSweep — set by pack-gc.ts when a sibling sync unit
  // for this store failed to merge this pass. Purge still runs (index
  // is trustworthy here — just possibly stale relative to a body still
  // in flight); only the sweep is withheld.
  it('skips only the sweep (not purge) when options.skipSweep is set, index-fails-body-succeeds scenario', async () => {
    const kept = await savePack({ pack: makePack({ name: 'Kept' }) })
    await writeFile(join(__testing.getPacksDir(), 'in-flight-body.json'), JSON.stringify(makePack()), 'utf-8')

    const result = await runGcUnderLock({ skipSweep: true })

    expect(result.swept).toBe(0)
    const remaining = await readdir(__testing.getPacksDir())
    expect(remaining).toContain(`${kept.data!.id}.json`)
    // The body for the sync unit that failed this pass must survive —
    // it has no index entry yet only because its own merge hasn't
    // landed, not because it's a genuine orphan.
    expect(remaining).toContain('in-flight-body.json')
  })
})
