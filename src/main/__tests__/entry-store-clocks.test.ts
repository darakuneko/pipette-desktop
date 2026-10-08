// SPDX-License-Identifier: GPL-2.0-or-later
//
// Which per-group clock each entry-store write path moves (sync format v2
// clocks, `sync/entry-clocks.ts`), revival on explicit overwrites, the
// fixed built-in entries, and the move of body files to id-carrying names.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

let mockUserDataPath = ''

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? mockUserDataPath : `/mock/${name}`) },
  ipcMain: { handle: vi.fn() },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
}))

vi.mock('../sync/sync-service', () => ({ notifyChange: vi.fn() }))

vi.mock('../ipc-guard', async () => {
  const { ipcMain } = await import('electron')
  return { secureHandle: ipcMain.handle }
})

vi.mock('../logger', () => ({ log: vi.fn() }))

import { ipcMain } from 'electron'
import { IpcChannels } from '../../shared/ipc/channels'
import { setupFavoriteStore } from '../favorite-store'
import { setupSnapshotStore } from '../snapshot-store'
import { setupAnalyzeFilterStore } from '../analyze-filter-store'
import * as keyLabels from '../key-label-store'
import * as texts from '../typing-test-text-store'
import * as themes from '../theme-pack-store'
import * as i18n from '../i18n-pack-store'
import { EPOCH_ISO, type EntryClocks } from '../sync/entry-clocks'
import { THEME_COLOR_KEYS } from '../../shared/types/theme-store'
import { BUILTIN_ENGLISH_PACK_ID } from '../../shared/types/i18n-store'

type Handler = (...args: unknown[]) => Promise<unknown>
type Result = { success: boolean; error?: string; entry?: { id: string; filename: string } }
interface StoredEntry { id: string; filename: string; label?: string; name?: string; clocks: EntryClocks; updatedAt: string; deletedAt?: string; savedAt: string; enabled?: boolean }

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-02-01T00:00:00.000Z'
const T2 = '2026-03-01T00:00:00.000Z'
const ev = { sender: {} }

function handler(channel: string): Handler {
  const match = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel)
  if (!match) throw new Error(`No handler for ${channel}`)
  return match[1] as Handler
}

async function readEntries(path: string, key: 'entries' | 'metas' = 'entries'): Promise<StoredEntry[]> {
  return (JSON.parse(await readFile(path, 'utf-8')) as Record<string, StoredEntry[]>)[key]
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value), 'utf-8')
}

function at(iso: string): void {
  vi.setSystemTime(new Date(iso))
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  at(T0)
  mockUserDataPath = await mkdtemp(join(tmpdir(), 'entry-store-clocks-'))
  setupFavoriteStore()
  setupSnapshotStore()
  setupAnalyzeFilterStore()
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(mockUserDataPath, { recursive: true, force: true })
})

describe('favorites', () => {
  const dir = (): string => join(mockUserDataPath, 'sync', 'favorites', 'macro')

  it('save names the body after the id; rename / hub / delete each move their own clock', async () => {
    const saved = await handler(IpcChannels.FAVORITE_STORE_SAVE)(ev, 'macro', '{"data":1}', 'M') as Result
    const id = saved.entry!.id
    expect(saved.entry!.filename.endsWith(`_${id}.json`)).toBe(true)
    let [e] = await readEntries(join(dir(), 'index.json'))
    expect(e.clocks).toEqual({ created: T0, body: T0, name: T0, hub: T0 })

    at(T1)
    await handler(IpcChannels.FAVORITE_STORE_RENAME)(ev, 'macro', id, 'M2')
    ;[e] = await readEntries(join(dir(), 'index.json'))
    expect(e.clocks).toEqual({ created: T0, body: T0, name: T1, hub: T0 })
    expect(e.updatedAt).toBe(T1)

    at(T2)
    await handler(IpcChannels.FAVORITE_STORE_SET_HUB_POST_ID)(ev, 'macro', id, 'post-1')
    ;[e] = await readEntries(join(dir(), 'index.json'))
    expect(e.clocks).toEqual({ created: T0, body: T0, name: T1, hub: T2 })

    at('2026-04-01T00:00:00.000Z')
    await handler(IpcChannels.FAVORITE_STORE_DELETE)(ev, 'macro', id)
    ;[e] = await readEntries(join(dir(), 'index.json'))
    expect(e.deletedAt).toBe('2026-04-01T00:00:00.000Z')
    expect(e.clocks.hub).toBe(T2)
    expect(e.updatedAt).toBe('2026-04-01T00:00:00.000Z')
  })

  it('import sets created to now and keeps the exported savedAt', async () => {
    const exportPath = join(mockUserDataPath, 'export.json')
    await writeFile(exportPath, JSON.stringify({
      app: 'pipette',
      version: 3,
      scope: 'fav',
      exportedAt: T0,
      vial_protocol: 6,
      categories: { macro: [{ label: 'Imported', savedAt: '2020-01-01T00:00:00.000Z', data: [] }] },
    }))
    const { dialog, BrowserWindow } = await import('electron')
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({} as Electron.BrowserWindow)
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [exportPath] })

    at(T1)
    const res = await handler(IpcChannels.FAVORITE_STORE_IMPORT)(ev) as { imported: number }
    expect(res.imported).toBe(1)
    const [e] = await readEntries(join(dir(), 'index.json'))
    expect(e.savedAt).toBe('2020-01-01T00:00:00.000Z')
    expect(e.clocks.created).toBe(T1)
    expect(e.filename.endsWith(`_${e.id}.json`)).toBe(true)
  })

  it('a locked write moves a v1 entry\'s legacy body file to an id-carrying name', async () => {
    await writeJson(join(dir(), 'index.json'), {
      type: 'macro',
      entries: [{ id: 'f1', label: 'L', filename: 'macro_ts_ab.json', savedAt: T0, updatedAt: T0 }],
    })
    await writeFile(join(dir(), 'macro_ts_ab.json'), '{"data":1}')

    at(T1)
    await handler(IpcChannels.FAVORITE_STORE_RENAME)(ev, 'macro', 'f1', 'L2')

    const [e] = await readEntries(join(dir(), 'index.json'))
    expect(e.filename).toBe('macro_ts_ab_f1.json')
    expect(e.clocks.body).toBe(T0)
    expect((await readdir(dir())).sort()).toEqual(['index.json', 'macro_ts_ab_f1.json'])
    const load = await handler(IpcChannels.FAVORITE_STORE_LOAD)(ev, 'macro', 'f1') as { data: string }
    expect(load.data).toBe('{"data":1}')
  })

  it('list reads a v1 index without writing it', async () => {
    const v1 = { type: 'macro', entries: [{ id: 'f1', label: 'L', filename: 'legacy.json', savedAt: T0 }] }
    await writeJson(join(dir(), 'index.json'), v1)
    const res = await handler(IpcChannels.FAVORITE_STORE_LIST)(ev, 'macro') as { entries: StoredEntry[] }
    expect(res.entries[0].clocks.created).toBe(T0)
    expect(JSON.parse(await readFile(join(dir(), 'index.json'), 'utf-8'))).toEqual(v1)
  })
})

describe('snapshots', () => {
  const dir = (): string => join(mockUserDataPath, 'sync', 'keyboards', 'uid1', 'snapshots')

  async function saveOne(): Promise<string> {
    const saved = await handler(IpcChannels.SNAPSHOT_STORE_SAVE)(ev, 'uid1', '{"v":1}', 'KB', 'L', 1) as Result
    return saved.entry!.id
  }

  it('UPDATE is an explicit overwrite: created and body move, name and hub stay', async () => {
    const id = await saveOne()
    at(T1)
    await handler(IpcChannels.SNAPSHOT_STORE_UPDATE)(ev, 'uid1', id, '{"v":2}', 2)
    const [e] = await readEntries(join(dir(), 'index.json'))
    expect(e.clocks).toEqual({ created: T1, body: T1, name: T0, hub: T0 })
  })

  it('the v1 → v2 migration update moves body 1 ms past its old value and only over the body it read', async () => {
    const id = await saveOne()
    at(T2)
    const ok = await handler(IpcChannels.SNAPSHOT_STORE_UPDATE)(ev, 'uid1', id, '{"v":2}', 2, { migrateFrom: '{"v":1}' }) as Result
    expect(ok.success).toBe(true)
    let [e] = await readEntries(join(dir(), 'index.json'))
    expect(e.clocks).toEqual({ created: T0, body: '2026-01-01T00:00:00.001Z', name: T0, hub: T0 })

    // The stored body is no longer the one the migration read.
    const stale = await handler(IpcChannels.SNAPSHOT_STORE_UPDATE)(ev, 'uid1', id, '{"v":3}', 2, { migrateFrom: '{"v":1}' }) as Result
    expect(stale.success).toBe(false)
    ;[e] = await readEntries(join(dir(), 'index.json'))
    expect(e.clocks.body).toBe('2026-01-01T00:00:00.001Z')
    expect(await readFile(join(dir(), e.filename), 'utf-8')).toBe('{"v":2}')
  })

  it('a user UPDATE of an entry deleted meanwhile brings it back', async () => {
    const id = await saveOne()
    at(T1)
    await handler(IpcChannels.SNAPSHOT_STORE_DELETE)(ev, 'uid1', id)
    at(T2)
    const res = await handler(IpcChannels.SNAPSHOT_STORE_UPDATE)(ev, 'uid1', id, '{"v":2}', 2) as Result
    expect(res.success).toBe(true)
    const [e] = await readEntries(join(dir(), 'index.json'))
    expect(e.deletedAt).toBeUndefined()
    expect(e.clocks.created).toBe(T2)
    expect(await readFile(join(dir(), e.filename), 'utf-8')).toBe('{"v":2}')
  })

  it('the migration update never revives a deleted entry', async () => {
    const id = await saveOne()
    at(T1)
    await handler(IpcChannels.SNAPSHOT_STORE_DELETE)(ev, 'uid1', id)
    const res = await handler(IpcChannels.SNAPSHOT_STORE_UPDATE)(ev, 'uid1', id, '{"v":2}', 2, { migrateFrom: '{"v":1}' }) as Result
    expect(res.success).toBe(false)
    const [e] = await readEntries(join(dir(), 'index.json'))
    expect(e.deletedAt).toBe(T1)
  })

  it('a locked write migrates a pre-id snapshot filename', async () => {
    await writeJson(join(dir(), 'index.json'), {
      uid: 'uid1',
      entries: [{ id: 's1', label: 'L', filename: 'KB_2025-01-01T00-00-00.000Z.pipette', savedAt: T0 }],
    })
    await writeFile(join(dir(), 'KB_2025-01-01T00-00-00.000Z.pipette'), 'BODY')
    await handler(IpcChannels.SNAPSHOT_STORE_RENAME)(ev, 'uid1', 's1', 'L2')
    const [e] = await readEntries(join(dir(), 'index.json'))
    expect(e.filename).toBe('KB_2025-01-01T00-00-00.000Z_s1.pipette')
    expect(await readFile(join(dir(), e.filename), 'utf-8')).toBe('BODY')
  })
})

describe('analyze filters', () => {
  const dir = (): string => join(mockUserDataPath, 'sync', 'keyboards', 'uid1', 'analyze_filters')

  it('save names the body after the id; UPDATE moves created and body; hub setter moves hub', async () => {
    const saved = await handler(IpcChannels.ANALYZE_FILTER_STORE_SAVE)(ev, 'uid1', '{}', 'L') as Result
    const id = saved.entry!.id
    expect(saved.entry!.filename.endsWith(`_${id}.json`)).toBe(true)
    at(T1)
    await handler(IpcChannels.ANALYZE_FILTER_STORE_UPDATE)(ev, 'uid1', id, '{"a":1}')
    at(T2)
    await handler(IpcChannels.ANALYZE_FILTER_STORE_SET_HUB_POST_ID)(ev, 'uid1', id, 'post')
    const [e] = await readEntries(join(dir(), 'index.json'))
    expect(e.clocks).toEqual({ created: T1, body: T1, name: T0, hub: T2 })
  })
})

describe('analyze filters (deleted meanwhile)', () => {
  it('a user UPDATE brings the entry back', async () => {
    const saved = await handler(IpcChannels.ANALYZE_FILTER_STORE_SAVE)(ev, 'uid1', '{}', 'L') as Result
    at(T1)
    await handler(IpcChannels.ANALYZE_FILTER_STORE_DELETE)(ev, 'uid1', saved.entry!.id)
    at(T2)
    expect((await handler(IpcChannels.ANALYZE_FILTER_STORE_UPDATE)(ev, 'uid1', saved.entry!.id, '{"a":2}') as Result).success).toBe(true)
    const [e] = await readEntries(join(mockUserDataPath, 'sync', 'keyboards', 'uid1', 'analyze_filters', 'index.json'))
    expect(e.deletedAt).toBeUndefined()
    expect(e.clocks.created).toBe(T2)
  })
})

describe('key labels', () => {
  const indexPath = (): string => join(mockUserDataPath, 'sync', 'key-labels', 'index.json')

  it('creates the built-in QWERTY entry identically on every device', async () => {
    at(T1)
    await keyLabels.listMetas()
    const first = await readEntries(indexPath())
    await rm(join(mockUserDataPath, 'sync'), { recursive: true, force: true })
    at(T2)
    await keyLabels.listMetas()
    const second = await readEntries(indexPath())
    expect(second).toEqual(first)
    expect(first[0]).toMatchObject({ id: 'qwerty', filename: 'qwerty_builtin.json', savedAt: EPOCH_ISO, updatedAt: EPOCH_ISO })
    expect(Object.values(first[0].clocks).every((c) => c === EPOCH_ISO)).toBe(true)
  })

  it('backfills the QWERTY uploaderName at the epoch hub clock', async () => {
    await writeJson(indexPath(), { entries: [{ id: 'qwerty', name: 'QWERTY', filename: 'qwerty_old.json', savedAt: T0, updatedAt: T1 }] })
    at(T2)
    await keyLabels.listMetas()
    const [e] = await readEntries(indexPath())
    expect(e).toMatchObject({ uploaderName: 'pipette', clocks: { hub: EPOCH_ISO, name: T1 } })
  })

  it('rename moves name only; a Hub sync that keeps the name moves body, created and hub', async () => {
    const saved = await keyLabels.saveRecord({ name: 'Mine', map: {}, hubPostId: 'post' })
    const id = saved.data!.id
    at(T1)
    await keyLabels.renameRecord(id, 'Renamed')
    let e = (await readEntries(indexPath())).find((x) => x.id === id)!
    expect(e.clocks).toEqual({ created: T0, body: T0, name: T1, hub: T0 })

    at(T2)
    await keyLabels.saveRecord({ id, name: 'Renamed', map: { a: 'b' }, hubPostId: 'post', hubUpdatedAt: T2 })
    e = (await readEntries(indexPath())).find((x) => x.id === id)!
    expect(e.clocks).toEqual({ created: T2, body: T2, name: T1, hub: T2 })
  })

  it('a refresh that keeps the current name does not undo a rename made meanwhile', async () => {
    const saved = await keyLabels.saveRecord({ name: 'Old', map: {}, hubPostId: 'post' })
    const id = saved.data!.id
    at(T1)
    await keyLabels.renameRecord(id, 'New')
    at(T2)
    // The Hub Sync captured 'Old' before its download finished.
    await keyLabels.saveRecord({ id, name: 'Old', keepCurrentName: true, map: { a: 'b' }, hubPostId: 'post' })
    const e = (await readEntries(indexPath())).find((x) => x.id === id)!
    expect(e.name).toBe('New')
    expect(e.clocks.name).toBe(T1)
    expect((await keyLabels.getRecord(id)).data?.data.name).toBe('New')
  })

  it('a Hub download over a deleted label brings it back past deletedAt', async () => {
    const saved = await keyLabels.saveRecord({ id: 'post-1', name: 'L', map: {}, hubPostId: 'post-1' })
    expect(saved.success).toBe(true)
    at(T2)
    await keyLabels.deleteRecord('post-1')
    at(T1) // this device's clock runs behind the delete
    await keyLabels.saveRecord({ id: 'post-1', name: 'L', map: {}, hubPostId: 'post-1' })
    const e = (await readEntries(indexPath())).find((x) => x.id === 'post-1')!
    expect(e.deletedAt).toBeUndefined()
    expect(e.clocks.created).toBe('2026-03-01T00:00:00.001Z')
  })
})

describe('typing-test texts', () => {
  const dir = (): string => join(mockUserDataPath, 'sync', 'typing-test-texts')

  it('caches romajiCapable by body filename', async () => {
    const saved = await texts.saveRecord({ name: 'Kana', text: 'あいう' })
    const id = saved.data!.id
    expect((await texts.getRecord(id)).data!.meta.romajiCapable).toBe(true)

    // Same filename, other content on disk: the cached value stays.
    const [e] = await readEntries(join(dir(), 'index.json'))
    await writeFile(join(dir(), e.filename), JSON.stringify({ name: 'Kana', text: 'abc' }))
    expect((await texts.listMetas())[0].romajiCapable).toBe(true)

    // A content save writes a new filename, so the value is recomputed.
    at(T1)
    await texts.saveRecord({ id, name: 'Kana', text: 'abc' })
    expect((await texts.listMetas())[0].romajiCapable).toBe(false)
  })

  it('a confirmed overwrite keeps a name given meanwhile', async () => {
    const saved = await texts.saveRecord({ name: 'T', text: 'a b' })
    at(T1)
    await texts.renameRecord(saved.data!.id, 'Renamed')
    at(T2)
    await texts.saveRecord({ id: saved.data!.id, name: 'T', text: 'c d', keepCurrentName: true })
    const [e] = await readEntries(join(dir(), 'index.json'))
    expect(e).toMatchObject({ name: 'Renamed', clocks: { name: T1, body: T2 } })
  })

  it('rename moves only the name clock', async () => {
    const saved = await texts.saveRecord({ name: 'T', text: 'a b' })
    at(T1)
    await texts.renameRecord(saved.data!.id, 'T2')
    const [e] = await readEntries(join(dir(), 'index.json'))
    expect(e.clocks).toEqual({ created: T0, body: T0, name: T1 })
  })

  it('an overwrite that keeps the name does not move the name clock', async () => {
    const saved = await texts.saveRecord({ name: 'T', text: 'a b' })
    at(T1)
    await texts.saveRecord({ id: saved.data!.id, name: 'T', text: 'c d' })
    const [e] = await readEntries(join(dir(), 'index.json'))
    expect(e.clocks).toEqual({ created: T1, body: T1, name: T0 })
  })
})

function themePack(name: string, version = '1.0.0'): Record<string, unknown> {
  const colors: Record<string, string> = {}
  for (const key of THEME_COLOR_KEYS) colors[key] = '#aabbcc'
  return { name, version, colorScheme: 'dark', colors }
}

describe('theme packs', () => {
  it('rename / hub / delete each move their own clock; a save over the tombstone revives it', async () => {
    const saved = await themes.savePack({ raw: themePack('Theme') })
    const id = saved.data!.id
    at(T1)
    await themes.renamePack(id, 'Theme 2')
    let [m] = (await themes.readIndex()).metas
    expect(m.clocks).toEqual({ created: T0, body: T0, name: T1, hub: T0 })

    at(T2)
    await themes.setHubPostId(id, 'post')
    await themes.deletePack(id)
    ;[m] = (await themes.readIndex()).metas
    expect(m.clocks.hub).toBe(T2)
    expect(m.deletedAt).toBe(T2)

    at('2026-04-01T00:00:00.000Z')
    await themes.savePack({ raw: themePack('Theme 3'), id })
    ;[m] = (await themes.readIndex()).metas
    expect(m.deletedAt).toBeUndefined()
    expect(m.clocks.created).toBe('2026-04-01T00:00:00.000Z')
    expect(m.name).toBe('Theme 3')
  })
})

describe('i18n packs', () => {
  const pack = (name: string, version = '1.0.0'): Record<string, unknown> => ({ name, version, common: { save: 'S' } })

  it('creates the built-in English entry with epoch clocks', async () => {
    at(T1)
    await i18n.listMetas()
    const english = (await i18n.readIndex()).metas.find((m) => m.id === BUILTIN_ENGLISH_PACK_ID)!
    expect(english.updatedAt).toBe(EPOCH_ISO)
    expect(english.savedAt).toBe(EPOCH_ISO)
    expect(Object.values(english.clocks).every((c) => c === EPOCH_ISO)).toBe(true)
  })

  it('setEnabled moves enabled; delete disables and tombstones', async () => {
    const saved = await i18n.savePack({ pack: pack('Lang') })
    const id = saved.data!.id
    at(T1)
    await i18n.setEnabled(id, false)
    let m = (await i18n.readIndex()).metas.find((x) => x.id === id)!
    expect(m.clocks).toEqual({ created: T0, body: T0, name: T0, hub: T0, enabled: T1 })

    at(T2)
    await i18n.setEnabled(id, true)
    await i18n.deletePack(id)
    m = (await i18n.readIndex()).metas.find((x) => x.id === id)!
    expect(m).toMatchObject({ enabled: false, deletedAt: T2 })
  })

  it('a user save over a deleted pack revives it enabled', async () => {
    const saved = await i18n.savePack({ pack: pack('Lang') })
    const id = saved.data!.id
    at(T1)
    await i18n.deletePack(id)
    at(T2)
    await i18n.savePack({ pack: pack('Lang', '2.0.0'), id })
    const m = (await i18n.readIndex()).metas.find((x) => x.id === id)!
    expect(m.deletedAt).toBeUndefined()
    expect(m.enabled).toBe(true)
    expect(m.clocks.created).toBe(T2)
    expect(m.clocks.enabled).toBe(T2)
  })

  describe('unattended (Hub startup auto-update)', () => {
    async function linked(): Promise<string> {
      const saved = await i18n.savePack({ pack: pack('Hub Lang'), hubPostId: 'post' })
      at(T1)
      await i18n.renamePack(saved.data!.id, 'My Name')
      return saved.data!.id
    }

    it('keeps the local name and moves only body (and hub when it changed)', async () => {
      const id = await linked()
      at(T2)
      const res = await i18n.savePack({ pack: pack('Hub Lang', '2.0.0'), id, hubPostId: 'post', hubUpdatedAt: T2, unattended: true })
      expect(res.success).toBe(true)
      const m = (await i18n.readIndex()).metas.find((x) => x.id === id)!
      expect(m).toMatchObject({ name: 'My Name', version: '2.0.0' })
      expect(m.clocks).toEqual({ created: T0, body: T2, name: T1, hub: T2, enabled: T0 })
    })

    it('does nothing for a deleted pack', async () => {
      const id = await linked()
      await i18n.deletePack(id)
      at(T2)
      const res = await i18n.savePack({ pack: pack('Hub Lang', '2.0.0'), id, hubPostId: 'post', unattended: true })
      expect(res.success).toBe(false)
      const m = (await i18n.readIndex()).metas.find((x) => x.id === id)!
      expect(m.deletedAt).toBe(T1)
      expect(m.version).toBe('1.0.0')
    })

    it('does nothing for a pack linked to another post', async () => {
      const id = await linked()
      await i18n.setHubPostId(id, 'other')
      const res = await i18n.savePack({ pack: pack('Hub Lang', '2.0.0'), id, hubPostId: 'post', unattended: true })
      expect(res.success).toBe(false)
    })
  })
})
