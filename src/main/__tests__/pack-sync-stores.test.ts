// SPDX-License-Identifier: GPL-2.0-or-later
//
// Pack sync (sync format v2) through the i18n / theme stores: the roster
// keeps local body fields, a body bundle's clock and fields are applied
// together, v1 bundles and metas fall back to Drive / file times, and a
// rename touches only the meta (the getters show the meta's name).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'

let mockUserDataPath = ''

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? mockUserDataPath : `/mock/${name}`) },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
}))
vi.mock('../sync/sync-service', () => ({ notifyChange: vi.fn() }))
vi.mock('../logger', () => ({ log: vi.fn() }))

import { notifyChange } from '../sync/sync-service'
import * as i18n from '../i18n-pack-store'
import * as themes from '../theme-pack-store'
import * as keyLabels from '../key-label-store'
import * as texts from '../typing-test-text-store'
import { PackMetaPendingError } from '../sync/pack-sync'
import { EPOCH_ISO } from '../sync/entry-clocks'
import { THEME_COLOR_KEYS } from '../../shared/types/theme-store'
import type { SyncBundle } from '../../shared/types/sync'

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-02-01T00:00:00.000Z'
const T2 = '2026-03-01T00:00:00.000Z'

const i18nDir = (): string => join(mockUserDataPath, 'sync', 'i18n')
const clocks = (body: string): Record<string, string> => ({ created: T0, body, name: T0, hub: T0, enabled: T0 })

function meta(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, filename: `packs/${id}.json`, name: `Pack ${id}`, version: '1.0.0', enabled: true, savedAt: T0, updatedAt: T0, clocks: clocks(T0), ...extra }
}

async function seedI18n(metas: Record<string, unknown>[], bodies: Record<string, unknown> = {}): Promise<void> {
  await mkdir(join(i18nDir(), 'packs'), { recursive: true })
  await writeFile(join(i18nDir(), 'index.json'), JSON.stringify({ metas }), 'utf-8')
  for (const [id, body] of Object.entries(bodies)) await writeFile(join(i18nDir(), 'packs', `${id}.json`), JSON.stringify(body), 'utf-8')
}

async function localMeta(id: string): Promise<Record<string, unknown> & { clocks: Record<string, string> }> {
  const index = JSON.parse(await readFile(join(i18nDir(), 'index.json'), 'utf-8')) as { metas: Array<Record<string, unknown> & { id: string; clocks: Record<string, string> }> }
  const found = index.metas.find((m) => m.id === id)
  if (!found) throw new Error(`no meta ${id}`)
  return found
}

function bodyBundle(id: string, body: unknown, clock?: { clock: string; fields: Record<string, unknown> }): SyncBundle {
  return { type: 'i18n-pack', key: id, index: { metas: [] }, files: { [`${id}.json`]: JSON.stringify(body) }, ...(clock ? { body: clock } : {}) }
}

beforeEach(async () => {
  vi.clearAllMocks()
  mockUserDataPath = await mkdtemp(join(tmpdir(), 'pack-sync-stores-'))
})

afterEach(async () => {
  await rm(mockUserDataPath, { recursive: true, force: true })
})

describe('roster merge', () => {
  it('never takes remote body fields over a local body, and does not send for a body-only difference', async () => {
    await seedI18n([meta('p1', { coverage: { totalKeys: 10, coveredKeys: 10 } })], { p1: { name: 'x', version: '1.0.0' } })
    const result = await i18n.mergeSyncedIndex([meta('p1', { version: '2.0.0', coverage: { totalKeys: 10, coveredKeys: 3 }, clocks: clocks(T2), updatedAt: T2 })])
    expect(result).toEqual({ applied: true, remoteNeedsUpdate: false, bodyFetchIds: [] })
    expect(await localMeta('p1')).toMatchObject({ version: '1.0.0', coverage: { coveredKeys: 10 }, clocks: { body: T0 } })
  })

  it('shows a remote-only pack with body clock 0 and asks for its body', async () => {
    await seedI18n([])
    const result = await i18n.mergeSyncedIndex([meta('p2', { version: '2.0.0', clocks: clocks(T2) })])
    expect(result.bodyFetchIds).toEqual(['p2'])
    expect(await localMeta('p2')).toMatchObject({ version: '2.0.0', clocks: { body: EPOCH_ISO } })
  })

  it('moves a v1 meta to a body clock from its body file mtime, keeping its body fields', async () => {
    const v1 = { id: 'p1', filename: 'packs/p1.json', name: 'P', version: '1.0.0', enabled: true, coverage: { totalKeys: 5, coveredKeys: 5 }, savedAt: T0, updatedAt: T0 }
    await seedI18n([v1], { p1: { name: 'P', version: '1.0.0' } })
    await utimes(join(i18nDir(), 'packs', 'p1.json'), new Date(T1), new Date(T1))
    expect((await i18n.readIndex()).metas[0]).toMatchObject({ coverage: { coveredKeys: 5 }, clocks: { body: T1 } })
    expect((await i18n.bundleSyncedPackBody('p1'))?.body).toEqual({ clock: T1, fields: { version: '1.0.0', coverage: { totalKeys: 5, coveredKeys: 5 } } })
  })

  it('never takes the mtime of a leftover file for a v2 meta waiting for its body', async () => {
    await seedI18n([meta('p1', { clocks: clocks(EPOCH_ISO) })], { p1: { name: 'old', version: '0.1.0' } })
    await utimes(join(i18nDir(), 'packs', 'p1.json'), new Date(T2), new Date(T2))
    expect((await i18n.readIndex()).metas[0].clocks.body).toBe(EPOCH_ISO)
  })
})

describe('body unit', () => {
  it('applies a newer remote body together with its body fields and clock', async () => {
    await seedI18n([meta('p1', { coverage: { totalKeys: 10, coveredKeys: 10 } })], { p1: { name: 'x', version: '1.0.0' } })
    const outcome = await i18n.applySyncedPackBody('p1', bodyBundle('p1', { name: 'x', version: '2.0.0' }, {
      clock: T2, fields: { version: '2.0.0', coverage: { totalKeys: 10, coveredKeys: 8 } },
    }), T0, true)
    expect(outcome).toBe('applied')
    expect(await localMeta('p1')).toMatchObject({ version: '2.0.0', coverage: { coveredKeys: 8 }, clocks: { body: T2 } })
    expect(JSON.parse(await readFile(join(i18nDir(), 'packs', 'p1.json'), 'utf-8'))).toMatchObject({ version: '2.0.0' })
  })

  it('keeps a newer local body (local-wins) and an identical one (same)', async () => {
    await seedI18n([meta('p1', { clocks: clocks(T2) })], { p1: { name: 'x', version: '1.0.0' } })
    const older = await i18n.applySyncedPackBody('p1', bodyBundle('p1', { name: 'x', version: '0.9.0' }, { clock: T1, fields: { version: '0.9.0' } }), T0, true)
    expect(older).toBe('local-wins')
    const same = await i18n.applySyncedPackBody('p1', bodyBundle('p1', { name: 'x', version: '1.0.0' }, { clock: T2, fields: { version: '1.0.0' } }), T0, true)
    expect(same).toBe('same')
    expect(await localMeta('p1')).toMatchObject({ version: '1.0.0', clocks: { body: T2 } })
  })

  it('reads a v1 bundle with the Drive modifiedTime as its clock and drops index-only fields', async () => {
    await seedI18n([meta('p1', { coverage: { totalKeys: 10, coveredKeys: 10 } })], { p1: { name: 'x', version: '1.0.0' } })
    const outcome = await i18n.applySyncedPackBody('p1', bodyBundle('p1', { name: 'x', version: '3.0.0' }), T1, true)
    expect(outcome).toBe('applied')
    const m = await localMeta('p1')
    expect(m).toMatchObject({ version: '3.0.0', clocks: { body: T1 } })
    expect(m.coverage).toBeUndefined()
  })

  it('throws a retryable error for an unknown id before the roster was merged, and skips it after', async () => {
    await seedI18n([])
    await expect(i18n.applySyncedPackBody('p9', bodyBundle('p9', { name: 'x', version: '1.0.0' }), T1, false)).rejects.toBeInstanceOf(PackMetaPendingError)
    expect(await i18n.applySyncedPackBody('p9', bodyBundle('p9', { name: 'x', version: '1.0.0' }), T1, true)).toBe('skipped')
  })

  it('skips a tombstoned pack', async () => {
    await seedI18n([meta('p1', { deletedAt: T2, updatedAt: T2 })])
    expect(await i18n.applySyncedPackBody('p1', bodyBundle('p1', { name: 'x', version: '2.0.0' }, { clock: '2026-04-01T00:00:00.000Z', fields: {} }), T1, true)).toBe('skipped')
  })
})

describe('body unit and roster agree', () => {
  it('a v1 bundle with the same bytes keeps the local body fields (no coverage loss on the first v2 pass)', async () => {
    const body = { name: 'x', version: '1.0.0' }
    await seedI18n([meta('p1', { coverage: { totalKeys: 10, coveredKeys: 10 }, matchedBaseVersion: '0.1.0' })], { p1: body })
    const raw = await readFile(join(i18nDir(), 'packs', 'p1.json'), 'utf-8')
    const bundle: SyncBundle = { type: 'i18n-pack', key: 'p1', index: { metas: [] }, files: { 'p1.json': raw } }
    expect(await i18n.applySyncedPackBody('p1', bundle, T2, true)).toBe('same')
    expect(await localMeta('p1')).toMatchObject({ coverage: { coveredKeys: 10 }, matchedBaseVersion: '0.1.0', clocks: { body: T0 } })
  })

  it('after applying a newer body, the roster merge sends the new body fields to Drive', async () => {
    await seedI18n([meta('p1')], { p1: { name: 'x', version: '1.0.0' } })
    await i18n.applySyncedPackBody('p1', bodyBundle('p1', { name: 'x', version: '2.0.0' }, { clock: T2, fields: { version: '2.0.0' } }), T0, true)
    const stale = await i18n.mergeSyncedIndex([meta('p1')])
    expect(stale.remoteNeedsUpdate).toBe(true)
    const caughtUp = await i18n.mergeSyncedIndex([meta('p1', { version: '2.0.0', clocks: clocks(T2), updatedAt: T2 })])
    expect(caughtUp.remoteNeedsUpdate).toBe(false)
  })

  it('refreshCoverage stores coverage on the meta without moving any clock', async () => {
    await seedI18n([meta('p1')], { p1: { name: 'x', version: '1.0.0' } })
    const before = await localMeta('p1')
    await i18n.refreshCoverage('p1', { matchedBaseVersion: '0.2.0', coverage: { totalKeys: 3, coveredKeys: 3 }, measuredBodyClock: T0 })
    const after = await localMeta('p1')
    expect(after).toMatchObject({ matchedBaseVersion: '0.2.0', coverage: { coveredKeys: 3 } })
    expect(after.clocks).toEqual(before.clocks)
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(notifyChange).not.toHaveBeenCalled()
  })

  it('refreshCoverage writes nothing when the body changed after it was measured', async () => {
    await seedI18n([meta('p1', { clocks: clocks(T2) })], { p1: { name: 'x', version: '2.0.0' } })
    const res = await i18n.refreshCoverage('p1', { matchedBaseVersion: '0.2.0', coverage: { totalKeys: 3, coveredKeys: 1 }, measuredBodyClock: T0 })
    expect(res.success).toBe(false)
    expect((await localMeta('p1')).coverage).toBeUndefined()
  })

  it('a v1 bundle of the same version keeps the roster-supplied body fields on a new device', async () => {
    // The roster brought the meta (body clock 0); no local body yet.
    await seedI18n([meta('p1', { clocks: clocks(EPOCH_ISO), coverage: { totalKeys: 10, coveredKeys: 10 }, matchedBaseVersion: '0.1.0' })])
    expect(await i18n.applySyncedPackBody('p1', bodyBundle('p1', { name: 'x', version: '1.0.0' }), T1, true)).toBe('applied')
    expect(await localMeta('p1')).toMatchObject({ coverage: { coveredKeys: 10 }, matchedBaseVersion: '0.1.0', clocks: { body: T1 } })
  })

  it('a v1 bundle of the same version with other bytes drops the derived fields so coverage is checked again', async () => {
    await seedI18n([meta('p1', { coverage: { totalKeys: 10, coveredKeys: 10 }, matchedBaseVersion: '0.1.0' })], { p1: { name: 'x', version: '1.0.0', a: '1' } })
    expect(await i18n.applySyncedPackBody('p1', bodyBundle('p1', { name: 'x', version: '1.0.0', a: '2' }), T2, true)).toBe('applied')
    const m = await localMeta('p1')
    expect(m.version).toBe('1.0.0')
    expect(m.coverage).toBeUndefined()
    expect(m.matchedBaseVersion).toBeUndefined()
  })

  it('a roster index that exists without a metas array is not overwritten', async () => {
    await mkdir(i18nDir(), { recursive: true })
    await writeFile(join(i18nDir(), 'index.json'), '{"something":1}', 'utf-8')
    const res = await i18n.mergeSyncedIndex([meta('p1')])
    expect(res.applied).toBe(false)
    expect(await readFile(join(i18nDir(), 'index.json'), 'utf-8')).toBe('{"something":1}')
  })

  it('two devices with the same untouched v1 packs converge and go quiet', async () => {
    const v1 = { id: 'p1', filename: 'packs/p1.json', name: 'P', version: '1.0.0', enabled: true, coverage: { totalKeys: 5, coveredKeys: 5 }, savedAt: T0, updatedAt: T0 }
    const devA = mockUserDataPath
    const devB = await mkdtemp(join(tmpdir(), 'pack-sync-stores-b-'))
    try {
      for (const [dev, mtime] of [[devA, T1], [devB, T2]] as const) {
        mockUserDataPath = dev
        await seedI18n([v1], { p1: { name: 'P', version: '1.0.0' } })
        await utimes(join(i18nDir(), 'packs', 'p1.json'), new Date(mtime), new Date(mtime))
      }
      // Drive still holds the roster a v1 app uploaded.
      let drive: unknown[] = [v1]
      const pass = async (dev: string): Promise<boolean> => {
        mockUserDataPath = dev
        const r = await i18n.mergeSyncedIndex(drive)
        if (r.remoteNeedsUpdate) drive = ((await i18n.bundleSyncedIndex())!.index as { metas: unknown[] }).metas
        return r.remoteNeedsUpdate
      }
      const first = [await pass(devA), await pass(devB)]
      expect(first[0]).toBe(true)
      const later = [await pass(devA), await pass(devB), await pass(devA), await pass(devB)]
      expect(later).toEqual([false, false, false, false])
      // Both wrote their metas in v2 form once.
      for (const dev of [devA, devB]) {
        mockUserDataPath = dev
        expect((await localMeta('p1')).clocks).toBeDefined()
      }
    } finally {
      mockUserDataPath = devA
      await rm(devB, { recursive: true, force: true })
    }
  })
})

describe('rename and names', () => {
  it('an i18n rename writes only the meta: no body rewrite, no body-unit notify; getPack shows the new name', async () => {
    const saved = await i18n.savePack({ pack: { name: 'Lang', version: '1.0.0' } })
    const id = saved.data!.id
    const before = await readFile(join(i18nDir(), 'packs', `${id}.json`), 'utf-8')
    vi.mocked(notifyChange).mockClear()
    await i18n.renamePack(id, 'Renamed')
    expect(await readFile(join(i18nDir(), 'packs', `${id}.json`), 'utf-8')).toBe(before)
    expect(vi.mocked(notifyChange).mock.calls.map((c) => c[0])).toEqual(['i18n/index'])
    expect((await i18n.getPack(id)).data?.pack).toMatchObject({ name: 'Renamed' })
  })

  it('savePack over a renamed pack keeps the name and takes the new body', async () => {
    const saved = await i18n.savePack({ pack: { name: 'Lang', version: '1.0.0' } })
    await i18n.renamePack(saved.data!.id, 'Mine')
    const again = await i18n.savePack({ pack: { name: 'Lang', version: '2.0.0' }, id: saved.data!.id })
    expect(again.data).toMatchObject({ name: 'Mine', version: '2.0.0' })
  })

  it('a theme rename writes only the meta and getPack overlays it', async () => {
    const colors: Record<string, string> = {}
    for (const k of THEME_COLOR_KEYS) colors[k] = '#aabbcc'
    const saved = await themes.savePack({ raw: { name: 'Theme', version: '1.0.0', colorScheme: 'dark', colors } })
    const id = saved.data!.id
    vi.mocked(notifyChange).mockClear()
    await themes.renamePack(id, 'Theme 2')
    expect(vi.mocked(notifyChange).mock.calls.map((c) => c[0])).toEqual(['themes/index'])
    const file = JSON.parse(await readFile(join(mockUserDataPath, 'sync', 'themes', 'packs', `${id}.json`), 'utf-8')) as { name: string }
    expect(file.name).toBe('Theme')
    expect((await themes.getPack(id)).data?.pack.name).toBe('Theme 2')
  })

  it('key-label and text renames leave the body file alone; getRecord shows the meta name', async () => {
    const label = await keyLabels.saveRecord({ name: 'Label', map: {} })
    const labelFile = join(mockUserDataPath, 'sync', 'key-labels', label.data!.filename)
    const labelBefore = await readFile(labelFile, 'utf-8')
    await keyLabels.renameRecord(label.data!.id, 'Label 2')
    expect(await readFile(labelFile, 'utf-8')).toBe(labelBefore)
    expect((await keyLabels.getRecord(label.data!.id)).data?.data.name).toBe('Label 2')

    const text = await texts.saveRecord({ name: 'Text', text: 'a b' })
    const textFile = join(mockUserDataPath, 'sync', 'typing-test-texts', text.data!.filename)
    const textBefore = await readFile(textFile, 'utf-8')
    await texts.renameRecord(text.data!.id, 'Text 2')
    expect(await readFile(textFile, 'utf-8')).toBe(textBefore)
    expect((await texts.getRecord(text.data!.id)).data?.data.name).toBe('Text 2')
  })
})
