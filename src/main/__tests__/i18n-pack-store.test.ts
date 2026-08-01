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
import { tmpdir } from 'node:os'

// Real fs/promises for every export except `utimes`, which is wrapped in a
// `vi.fn` so individual tests can force it to reject (simulating a utimes
// failure) — `vi.spyOn` cannot patch a real ESM module's export (Node's
// `node:fs/promises` namespace is non-configurable), so the override has to
// happen at mock-definition time instead.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, utimes: vi.fn(actual.utimes) }
})

import { mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises'

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
  applySyncedPackBody,
  pinPackBodyMtime,
  statLocalPackMtime,
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

  // --- codex review follow-up: name-collision guard (issue 1) -------------

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

  // --- codex review follow-up: serialized RMW paths (issue 2) -------------

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

  // --- codex review follow-up: complete the sync exclusion (issue 3) ------

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

  // --- codex review follow-up: ensure recreates a missing body (issue 4) --

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

// --- Task-sync-unit-discovery bugfix plan: fixes 1-3 ------------------------

describe('i18n-pack-store sync robustness fixes (utimes degrade / pin CAS / malformed metas)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'i18n-pack-store-test-'))
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  // --- Fix 1: utimes failure degrades to accept-with-warn -------------------

  it('applySyncedPackBody: a utimes failure after a successful write still reports "applied" (never io-error)', async () => {
    vi.mocked(utimes).mockRejectedValueOnce(new Error('EPERM: operation not permitted'))

    const outcome = await applySyncedPackBody(
      'utimes-fail-pack',
      JSON.stringify({ name: 'UtimesFail', version: '1.0.0' }),
      '2026-01-01T00:00:00.000Z',
    )

    expect(outcome).toBe('applied')
    expect(utimes).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('i18n/packs/utimes-fail-pack'))

    // The body write itself must have landed despite the pin failure.
    // (applySyncedPackBody only writes the body file — no index entry
    // exists for this id, so read the file directly rather than via
    // getPack, which requires an index meta.)
    const body = await readFile(__testing.getPackPath('utimes-fail-pack'), 'utf-8')
    expect(JSON.parse(body)).toEqual({ name: 'UtimesFail', version: '1.0.0' })
  })

  it('pinPackBodyMtime: a utimes failure is swallowed (warn), never thrown', async () => {
    const saved = await savePack({ pack: makePack({ name: 'PinFail' }) })
    const id = saved.data!.id
    const mtime = await statLocalPackMtime(id)

    vi.mocked(utimes).mockRejectedValueOnce(new Error('EPERM'))
    await expect(pinPackBodyMtime(id, '2026-01-01T00:00:00.000Z', mtime)).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining(`i18n/packs/${id}`))
  })

  // --- Fix 2: post-upload pin is CAS-guarded ---------------------------------

  it('pinPackBodyMtime: skips the pin (no utimes call) when the local mtime no longer matches the upload snapshot', async () => {
    const saved = await savePack({ pack: makePack({ name: 'Racer' }) })
    const id = saved.data!.id
    const path = __testing.getPackPath(id)

    // Snapshot mtime as it was when uploadSyncUnit bundled the (old) content.
    const snapshotDate = new Date('2020-01-01T00:00:00.000Z')
    await utimes(path, snapshotDate, snapshotDate)
    const snapshot = snapshotDate.getTime()

    // A concurrent local save lands after the snapshot but before the pin
    // takes the store's write lock — simulated by advancing the file's
    // mtime well past both the snapshot and the (old) upload's Drive time.
    const raceDate = new Date('2026-06-01T00:00:00.000Z')
    await utimes(path, raceDate, raceDate)

    vi.mocked(utimes).mockClear() // discard the setup calls above
    await pinPackBodyMtime(id, '2020-01-01T00:00:05.000Z', snapshot)
    expect(utimes).not.toHaveBeenCalled()

    // The newer (raced) edit's mtime survives untouched, so it still wins
    // the next LWW comparison against the stale upload's Drive time.
    const finalMtime = (await statLocalPackMtime(id))!
    expect(finalMtime).toBe(raceDate.getTime())
    expect(finalMtime).toBeGreaterThan(new Date('2020-01-01T00:00:05.000Z').getTime())
  })

  it('pinPackBodyMtime: pins when the local mtime still matches the snapshot (no race)', async () => {
    const saved = await savePack({ pack: makePack({ name: 'NoRace' }) })
    const id = saved.data!.id
    const snapshot = await statLocalPackMtime(id)

    const remoteModifiedTime = '2026-07-01T00:00:00.000Z'
    await pinPackBodyMtime(id, remoteModifiedTime, snapshot)

    const path = __testing.getPackPath(id)
    const finalStat = await stat(path)
    expect(finalStat.mtime.getTime()).toBe(new Date(remoteModifiedTime).getTime())
  })

  it('pinPackBodyMtime: skips the pin when given no snapshot to compare (null)', async () => {
    const saved = await savePack({ pack: makePack({ name: 'NoSnapshot' }) })
    const id = saved.data!.id
    const before = await statLocalPackMtime(id)

    vi.mocked(utimes).mockClear()
    await pinPackBodyMtime(id, '2026-07-01T00:00:00.000Z', null)
    expect(utimes).not.toHaveBeenCalled()

    const after = await statLocalPackMtime(id)
    expect(after).toBe(before)
  })

  // --- Fix 3: meta validation must not crash on non-object entries ----------

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
