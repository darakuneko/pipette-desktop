// SPDX-License-Identifier: GPL-2.0-or-later
//
// importLocalData's plan/backup/write/rollback behavior. Real files
// under a temp userData dir — `writeFile`/`unlink` are wrapped so
// individual tests can inject a failure on a specific call while every
// other call still hits the real filesystem.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { dirname, join } from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

let mockUserDataPath = ''

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? mockUserDataPath : `/mock/${name}`) },
  ipcMain: { handle: vi.fn() },
}))

vi.mock('../sync-service', () => ({ notifyChange: vi.fn() }))

vi.mock('../../ipc-guard', async () => {
  const { ipcMain } = await import('electron')
  return { secureHandle: ipcMain.handle }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...actual, readFile: vi.fn(actual.readFile), writeFile: vi.fn(actual.writeFile), unlink: vi.fn(actual.unlink) }
})

import { unlink } from 'node:fs/promises'
import { importLocalData } from '../local-data-import'

let actualFs: typeof import('node:fs/promises')

beforeAll(async () => {
  actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
})

/** Makes the Nth call to `writeFile` (1-indexed) reject with `err`, every
 *  other call passing through to the real implementation. */
function failWriteFileOnCall(n: number, err: Error) {
  let count = 0
  vi.mocked(writeFile).mockImplementation(async (...args: Parameters<typeof actualFs.writeFile>) => {
    count += 1
    if (count === n) throw err
    return actualFs.writeFile(...args)
  })
}

function failUnlinkAlways(err: Error) {
  vi.mocked(unlink).mockImplementation(async () => { throw err })
}

/** Makes `readFile` reject with `err` only when called for `path`, every
 *  other call passing through to the real implementation. */
function failReadFileFor(path: string, err: Error) {
  vi.mocked(readFile).mockImplementation(async (...args: Parameters<typeof actualFs.readFile>) => {
    if (args[0] === path) throw err
    return actualFs.readFile(...args)
  })
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf-8'))
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await actualFs.writeFile(path, JSON.stringify(value, null, 2), 'utf-8')
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

/** Builds the `snapshots.{uid}` bundle shape repeated across most cases
 *  below — an index of entries plus their payload files. */
function snapshotExport(entries: Array<{ id: string; label: string; filename: string; savedAt: string }>, files: Record<string, string>) {
  return { index: { entries }, files }
}

/** Same shape as `snapshotExport`, for `favorites.{type}` bundles. */
function favoritesExport(entries: Array<{ id: string; label: string; filename: string; savedAt: string }>, files: Record<string, string>) {
  return { index: { entries }, files }
}

describe('importLocalData', () => {
  beforeEach(async () => {
    vi.mocked(readFile).mockImplementation(actualFs.readFile)
    vi.mocked(writeFile).mockImplementation(actualFs.writeFile)
    vi.mocked(unlink).mockImplementation(actualFs.unlink)
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'local-data-import-test-'))
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  it('A1: writes all three categories and reports the changed units', async () => {
    const exportObj = {
      version: 1,
      snapshots: {
        uid1: snapshotExport(
          [{ id: 'e1', label: 'L1', filename: 's_e1.pipette', savedAt: '2020-01-01T00:00:00.000Z' }],
          { 's_e1.pipette': '{"vil":true}' },
        ),
      },
      favorites: {
        macro: favoritesExport(
          [{ id: 'f1', label: 'F1', filename: 'm_f1.json', savedAt: '2020-01-01T00:00:00.000Z' }],
          { 'm_f1.json': '{"data":1}' },
        ),
      },
      settings: {
        uid1: { files: { 'pipette_settings.json': JSON.stringify({ _updatedAt: '2020-01-01T00:00:00.000Z', foo: 1 }) } },
      },
    }

    const result = await importLocalData(exportObj, mockUserDataPath)

    expect(result.changedUnits.slice().sort()).toEqual(
      ['favorites/macro', 'keyboards/uid1/settings', 'keyboards/uid1/snapshots'].sort(),
    )

    const snapDir = join(mockUserDataPath, 'sync', 'keyboards', 'uid1', 'snapshots')
    const snapIndex = await readJson(join(snapDir, 'index.json')) as { uid: string; entries: { id: string }[] }
    expect(snapIndex.uid).toBe('uid1')
    expect(snapIndex.entries).toHaveLength(1)
    expect(await readFile(join(snapDir, 's_e1.pipette'), 'utf-8')).toBe('{"vil":true}')

    const favDir = join(mockUserDataPath, 'sync', 'favorites', 'macro')
    const favIndex = await readJson(join(favDir, 'index.json')) as { type: string; entries: { id: string }[] }
    expect(favIndex.type).toBe('macro')
    expect(favIndex.entries).toHaveLength(1)
    expect(await readFile(join(favDir, 'm_f1.json'), 'utf-8')).toBe('{"data":1}')

    const settingsPath = join(mockUserDataPath, 'sync', 'keyboards', 'uid1', 'pipette_settings.json')
    expect(await readJson(settingsPath)).toEqual({ _updatedAt: '2020-01-01T00:00:00.000Z', foo: 1 })
  })

  it('A2: a failed 2nd payload write unlinks the 1st payload and leaves the index untouched', async () => {
    const snapDir = join(mockUserDataPath, 'sync', 'keyboards', 'uid1', 'snapshots')
    const originalIndex = { uid: 'uid1', entries: [{ id: 'e0', label: 'Existing', filename: 's_e0.pipette', savedAt: '2019-01-01T00:00:00.000Z' }] }
    await writeJson(join(snapDir, 'index.json'), originalIndex)
    await actualFs.writeFile(join(snapDir, 's_e0.pipette'), 'ORIGINAL', 'utf-8')

    const exportObj = {
      version: 1,
      snapshots: {
        uid1: snapshotExport(
          [
            { id: 'e1', label: 'New1', filename: 's_e1.pipette', savedAt: '2020-01-01T00:00:00.000Z' },
            { id: 'e2', label: 'New2', filename: 's_e2.pipette', savedAt: '2020-01-02T00:00:00.000Z' },
          ],
          { 's_e1.pipette': 'PAYLOAD1', 's_e2.pipette': 'PAYLOAD2' },
        ),
      },
    }

    failWriteFileOnCall(2, new Error('disk full'))

    await expect(importLocalData(exportObj, mockUserDataPath)).rejects.toThrow('disk full')

    expect(await exists(join(snapDir, 's_e1.pipette'))).toBe(false)
    expect(await exists(join(snapDir, 's_e2.pipette'))).toBe(false)
    expect(await readJson(join(snapDir, 'index.json'))).toEqual(originalIndex)
    expect(await readFile(join(snapDir, 's_e0.pipette'), 'utf-8')).toBe('ORIGINAL')
  })

  it('A3: a failed settings write rolls back the snapshots written earlier in the same import', async () => {
    const snapDir = join(mockUserDataPath, 'sync', 'keyboards', 'uid1', 'snapshots')
    const originalIndex = { uid: 'uid1', entries: [] as unknown[] }
    await writeJson(join(snapDir, 'index.json'), originalIndex)

    const settingsDir = join(mockUserDataPath, 'sync', 'keyboards', 'uid1')
    const settingsPath = join(settingsDir, 'pipette_settings.json')
    const originalSettings = { _updatedAt: '2019-01-01T00:00:00.000Z', foo: 'old' }
    await writeJson(settingsPath, originalSettings)

    const exportObj = {
      version: 1,
      snapshots: {
        uid1: snapshotExport(
          [{ id: 'e1', label: 'New1', filename: 's_e1.pipette', savedAt: '2020-01-01T00:00:00.000Z' }],
          { 's_e1.pipette': 'PAYLOAD1' },
        ),
      },
      settings: {
        uid1: { files: { 'pipette_settings.json': JSON.stringify({ _updatedAt: '2020-01-01T00:00:00.000Z', foo: 'new' }) } },
      },
    }

    // Write order: snapshot payload (1), snapshot index (2), settings (3) — fail the settings write.
    failWriteFileOnCall(3, new Error('write failed'))

    await expect(importLocalData(exportObj, mockUserDataPath)).rejects.toThrow('write failed')

    expect(await exists(join(snapDir, 's_e1.pipette'))).toBe(false)
    expect(await readJson(join(snapDir, 'index.json'))).toEqual(originalIndex)
    expect(await readJson(settingsPath)).toEqual(originalSettings)
  })

  it('A4: a corrupted existing index throws without writing anything, and the index is left as-is', async () => {
    const snapDir = join(mockUserDataPath, 'sync', 'keyboards', 'uid1', 'snapshots')
    await mkdir(snapDir, { recursive: true })
    await actualFs.writeFile(join(snapDir, 'index.json'), '{not valid json', 'utf-8')

    const exportObj = {
      version: 1,
      snapshots: {
        uid1: snapshotExport(
          [{ id: 'e1', label: 'New1', filename: 's_e1.pipette', savedAt: '2020-01-01T00:00:00.000Z' }],
          { 's_e1.pipette': 'PAYLOAD1' },
        ),
      },
    }

    await expect(importLocalData(exportObj, mockUserDataPath)).rejects.toThrow(/Corrupted index/)

    expect(await readFile(join(snapDir, 'index.json'), 'utf-8')).toBe('{not valid json')
    expect(await exists(join(snapDir, 's_e1.pipette'))).toBe(false)
  })

  it('F3: a non-ENOENT index read failure is reported distinctly from a parse failure', async () => {
    const snapDir = join(mockUserDataPath, 'sync', 'keyboards', 'uid1', 'snapshots')
    const indexPath = join(snapDir, 'index.json')
    await writeJson(indexPath, { uid: 'uid1', entries: [] })

    const exportObj = {
      version: 1,
      snapshots: {
        uid1: snapshotExport(
          [{ id: 'e1', label: 'New1', filename: 's_e1.pipette', savedAt: '2020-01-01T00:00:00.000Z' }],
          { 's_e1.pipette': 'PAYLOAD1' },
        ),
      },
    }

    failReadFileFor(indexPath, Object.assign(new Error('permission denied'), { code: 'EACCES' }))

    await expect(importLocalData(exportObj, mockUserDataPath)).rejects.toThrow(
      /Cannot read index: .*permission denied/,
    )
    expect(await exists(join(snapDir, 's_e1.pipette'))).toBe(false)
  })

  it('A5: an existing active entry with the same id is skipped (local wins)', async () => {
    const snapDir = join(mockUserDataPath, 'sync', 'keyboards', 'uid1', 'snapshots')
    const originalIndex = { uid: 'uid1', entries: [{ id: 'e1', label: 'Local', filename: 's_e1.pipette', savedAt: '2019-01-01T00:00:00.000Z' }] }
    await writeJson(join(snapDir, 'index.json'), originalIndex)
    await actualFs.writeFile(join(snapDir, 's_e1.pipette'), 'ORIGINAL', 'utf-8')

    const exportObj = {
      version: 1,
      snapshots: {
        uid1: snapshotExport(
          [{ id: 'e1', label: 'Remote', filename: 's_e1.pipette', savedAt: '2020-01-01T00:00:00.000Z' }],
          { 's_e1.pipette': 'REMOTE_PAYLOAD' },
        ),
      },
    }

    const result = await importLocalData(exportObj, mockUserDataPath)

    expect(result.changedUnits).toEqual([])
    expect(await readJson(join(snapDir, 'index.json'))).toEqual(originalIndex)
    expect(await readFile(join(snapDir, 's_e1.pipette'), 'utf-8')).toBe('ORIGINAL')
  })

  it('A6: a failed rollback combines the original and rollback errors into the thrown message', async () => {
    const snapDir = join(mockUserDataPath, 'sync', 'keyboards', 'uid1', 'snapshots')

    const exportObj = {
      version: 1,
      snapshots: {
        uid1: snapshotExport(
          [
            { id: 'e1', label: 'New1', filename: 's_e1.pipette', savedAt: '2020-01-01T00:00:00.000Z' },
            { id: 'e2', label: 'New2', filename: 's_e2.pipette', savedAt: '2020-01-02T00:00:00.000Z' },
          ],
          { 's_e1.pipette': 'PAYLOAD1', 's_e2.pipette': 'PAYLOAD2' },
        ),
      },
    }

    failWriteFileOnCall(2, new Error('disk full'))
    failUnlinkAlways(new Error('unlink denied'))

    let caught: unknown = null
    try {
      await importLocalData(exportObj, mockUserDataPath)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toMatch(/disk full/)
    expect(message).toMatch(/unlink denied/)

    // The write that failed rollback is left behind — the caller is told
    // rather than silently losing track of it.
    expect(await exists(join(snapDir, 's_e1.pipette'))).toBe(true)
  })

  it('A7: an older-_updatedAt settings payload is not written', async () => {
    const settingsDir = join(mockUserDataPath, 'sync', 'keyboards', 'uid1')
    const settingsPath = join(settingsDir, 'pipette_settings.json')
    const originalSettings = { _updatedAt: '2024-01-01T00:00:00.000Z', foo: 'newer' }
    await writeJson(settingsPath, originalSettings)

    const exportObj = {
      version: 1,
      settings: {
        uid1: { files: { 'pipette_settings.json': JSON.stringify({ _updatedAt: '2020-01-01T00:00:00.000Z', foo: 'older' }) } },
      },
    }

    const result = await importLocalData(exportObj, mockUserDataPath)

    expect(result.changedUnits).toEqual([])
    expect(await readJson(settingsPath)).toEqual(originalSettings)
  })

  it('F1: a non-ENOENT read error on local settings aborts the import without writing anything', async () => {
    const settingsDir = join(mockUserDataPath, 'sync', 'keyboards', 'uid1')
    const settingsPath = join(settingsDir, 'pipette_settings.json')
    const originalSettings = { _updatedAt: '2019-01-01T00:00:00.000Z', foo: 'old' }
    await writeJson(settingsPath, originalSettings)

    const exportObj = {
      version: 1,
      settings: {
        uid1: { files: { 'pipette_settings.json': JSON.stringify({ _updatedAt: '2020-01-01T00:00:00.000Z', foo: 'new' }) } },
      },
    }

    failReadFileFor(settingsPath, Object.assign(new Error('permission denied'), { code: 'EACCES' }))

    await expect(importLocalData(exportObj, mockUserDataPath)).rejects.toThrow('permission denied')

    // The mocked failure above only targets the import's own read — verify
    // the file itself with the real filesystem, not the still-installed mock.
    expect(JSON.parse(await actualFs.readFile(settingsPath, 'utf-8'))).toEqual(originalSettings)
  })

  it('F2: an invalid-JSON remote settings payload aborts the import instead of overwriting a healthy local file', async () => {
    const settingsDir = join(mockUserDataPath, 'sync', 'keyboards', 'uid1')
    const settingsPath = join(settingsDir, 'pipette_settings.json')
    const originalSettings = { _updatedAt: '2019-01-01T00:00:00.000Z', foo: 'old' }
    await writeJson(settingsPath, originalSettings)

    const exportObj = {
      version: 1,
      settings: {
        uid1: { files: { 'pipette_settings.json': '{not valid json' } },
      },
    }

    await expect(importLocalData(exportObj, mockUserDataPath)).rejects.toThrow('Invalid export file format')
    expect(await readJson(settingsPath)).toEqual(originalSettings)
  })

  it('F4: a bundle whose index.entries is missing throws Invalid export file format and writes nothing', async () => {
    const exportObj = {
      version: 1,
      snapshots: {
        uid1: { index: {}, files: {} },
      },
    }

    await expect(importLocalData(exportObj, mockUserDataPath)).rejects.toThrow('Invalid export file format')
    expect(await exists(join(mockUserDataPath, 'sync', 'keyboards', 'uid1', 'snapshots', 'index.json'))).toBe(false)
  })

  it('F4: an entry with a non-string filename is skipped and never lands in the index', async () => {
    const exportObj = {
      version: 1,
      snapshots: {
        uid1: snapshotExport(
          [
            { id: 'e1', label: 'Bad', filename: undefined, savedAt: '2020-01-01T00:00:00.000Z' } as unknown as { id: string; label: string; filename: string; savedAt: string },
            { id: 'e2', label: 'Good', filename: 's_e2.pipette', savedAt: '2020-01-02T00:00:00.000Z' },
          ],
          { 's_e2.pipette': 'PAYLOAD2' },
        ),
      },
    }

    const result = await importLocalData(exportObj, mockUserDataPath)

    expect(result.changedUnits).toEqual(['keyboards/uid1/snapshots'])
    const snapDir = join(mockUserDataPath, 'sync', 'keyboards', 'uid1', 'snapshots')
    const index = await readJson(join(snapDir, 'index.json')) as { entries: { id: string }[] }
    expect(index.entries.map((e) => e.id)).toEqual(['e2'])
  })

  describe('v2 clocks and id-carrying filenames', () => {
    const snapDir = (): string => join(mockUserDataPath, 'sync', 'keyboards', 'uid1', 'snapshots')
    type Stored = { id: string; filename: string; label: string; deletedAt?: string; clocks: Record<string, string> }

    it('revives a local tombstone past its deletedAt, even one from a clock running ahead', async () => {
      const deletedAt = new Date(Date.now() + 60_000).toISOString()
      await writeJson(join(snapDir(), 'index.json'), {
        uid: 'uid1',
        entries: [{ id: 'e1', label: 'Gone', filename: 's_e1.pipette', savedAt: '2019-01-01T00:00:00.000Z', deletedAt }],
      })

      await importLocalData({
        version: 1,
        snapshots: { uid1: snapshotExport([{ id: 'e1', label: 'Back', filename: 's_e1.pipette', savedAt: '2019-01-01T00:00:00.000Z' }], { 's_e1.pipette': 'BACKUP' }) },
      }, mockUserDataPath)

      const [e] = (await readJson(join(snapDir(), 'index.json')) as { entries: Stored[] }).entries
      expect(e.deletedAt).toBeUndefined()
      expect(e.label).toBe('Back')
      expect(new Date(e.clocks.created).getTime()).toBeGreaterThan(new Date(deletedAt).getTime())
      expect(await readFile(join(snapDir(), 's_e1.pipette'), 'utf-8')).toBe('BACKUP')
    })

    it('gives an entry the store lacks a new created, so an older delete elsewhere does not remove it', async () => {
      const before = Date.now()
      await importLocalData({
        version: 1,
        snapshots: { uid1: snapshotExport([{ id: 'e1', label: 'Back', filename: 's_e1.pipette', savedAt: '2019-01-01T00:00:00.000Z' }], { 's_e1.pipette': 'BACKUP' }) },
      }, mockUserDataPath)
      const [e] = (await readJson(join(snapDir(), 'index.json')) as { entries: Stored[] }).entries
      expect(new Date(e.clocks.created).getTime()).toBeGreaterThanOrEqual(before)
      // The other clocks stay the backup's.
      expect(e.clocks.name).toBe('2019-01-01T00:00:00.000Z')
    })

    it('never replaces a live local entry with a backup tombstone', async () => {
      const local = { uid: 'uid1', entries: [{ id: 'e1', label: 'Live', filename: 's_e1.pipette', savedAt: '2019-01-01T00:00:00.000Z' }] }
      await writeJson(join(snapDir(), 'index.json'), local)

      const result = await importLocalData({
        version: 1,
        snapshots: { uid1: snapshotExport([{ id: 'e1', label: 'Dead', filename: 's_e1.pipette', savedAt: '2019-01-01T00:00:00.000Z', deletedAt: '2030-01-01T00:00:00.000Z' } as never], {}) },
      }, mockUserDataPath)

      expect(result.changedUnits).toEqual([])
      expect(await readJson(join(snapDir(), 'index.json'))).toEqual(local)
    })

    it('saves backup bodies and migrates local bodies under id-carrying names', async () => {
      const favDir = join(mockUserDataPath, 'sync', 'favorites', 'macro')
      await writeJson(join(favDir, 'index.json'), {
        type: 'macro',
        entries: [
          { id: 'l1', label: 'A', filename: 'shared.json', savedAt: '2019-01-01T00:00:00.000Z' },
          { id: 'l2', label: 'B', filename: 'shared.json', savedAt: '2019-01-01T00:00:00.000Z' },
        ],
      })
      await actualFs.writeFile(join(favDir, 'shared.json'), 'LOCAL', 'utf-8')

      await importLocalData({
        version: 1,
        favorites: { macro: favoritesExport([{ id: 'b1', label: 'C', filename: 'macro_ts.json', savedAt: '2019-01-01T00:00:00.000Z' }], { 'macro_ts.json': 'BACKUP' }) },
      }, mockUserDataPath)

      const entries = (await readJson(join(favDir, 'index.json')) as { entries: Stored[] }).entries
      expect(entries.map((e) => e.filename)).toEqual(['shared_l1.json', 'shared_l2.json', 'macro_ts_b1.json'])
      expect(await readFile(join(favDir, 'shared_l1.json'), 'utf-8')).toBe('LOCAL')
      expect(await readFile(join(favDir, 'shared_l2.json'), 'utf-8')).toBe('LOCAL')
      expect(await readFile(join(favDir, 'macro_ts_b1.json'), 'utf-8')).toBe('BACKUP')
      expect(await exists(join(favDir, 'shared.json'))).toBe(false)
    })
  })

  describe('A8: concurrent snapshot-store save for the same uid', () => {
    it('serializes against importLocalData instead of racing it', async () => {
      const { ipcMain } = await import('electron')
      const { setupSnapshotStore } = await import('../../snapshot-store')
      setupSnapshotStore()
      const saveCall = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === 'snapshot-store:save')
      if (!saveCall) throw new Error('snapshot-store:save handler not registered')
      const saveHandler = saveCall[1] as (...args: unknown[]) => Promise<{ success: boolean; entry?: { id: string } }>

      const exportObj = {
        version: 1,
        snapshots: {
          uid1: snapshotExport(
            [{ id: 'imported-1', label: 'Imported', filename: 'imported-1.pipette', savedAt: '2020-01-01T00:00:00.000Z' }],
            { 'imported-1.pipette': 'IMPORTED_PAYLOAD' },
          ),
        },
      }

      // Both calls are issued synchronously (before either awaits its own
      // lock), so the per-uid write-lock chain queues the save strictly
      // after the import instead of interleaving their read-modify-writes.
      const importPromise = importLocalData(exportObj, mockUserDataPath)
      const savePromise = saveHandler({}, 'uid1', '{"live":true}', 'Live Keyboard', 'Live Save')

      const [, saveResult] = await Promise.all([importPromise, savePromise])
      expect(saveResult.success).toBe(true)

      const snapDir = join(mockUserDataPath, 'sync', 'keyboards', 'uid1', 'snapshots')
      const finalIndex = await readJson(join(snapDir, 'index.json')) as { entries: { id: string }[] }
      const ids = finalIndex.entries.map((e) => e.id).sort()
      expect(ids).toEqual(['imported-1', saveResult.entry!.id].sort())
    })
  })
})
