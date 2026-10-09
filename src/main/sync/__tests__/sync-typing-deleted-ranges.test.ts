// SPDX-License-Identifier: GPL-2.0-or-later
//
// The per-device deleted-ranges sync unit
// (`keyboards/{uid}/devices/{hash}/deleted-ranges`): bundling, collection,
// the merge through `mergeWithRemote`, hiding another device's ranges in
// the cache, the per-unit serialisation of a whole sync of the unit, and
// day-file replays that keep the ranges hidden.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join, dirname } from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

let mockUserDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? mockUserDataPath : `/mock/${name}`),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

// A Drive of one file per name: `uploadFile` replaces the content of the
// named file, `downloadFile` returns the content of the file with that id.
interface DriveSlot { id: string; name: string; content: string; modifiedTime: string }
const drive = new Map<string, DriveSlot>()
let driveRevision = 0
function putDrive(name: string, content: string): DriveSlot {
  const slot = { id: drive.get(name)?.id ?? `id-${name}`, name, content, modifiedTime: new Date(Date.UTC(2026, 0, 1) + ++driveRevision * 1000).toISOString() }
  drive.set(name, slot)
  return slot
}
const events: string[] = []
const mockDownloadFile = vi.fn(async (id: string): Promise<unknown> => {
  const slot = [...drive.values()].find((s) => s.id === id)
  if (!slot) throw new Error(`no file ${id}`)
  events.push(`download:${slot.content}`)
  return { ciphertext: slot.content }
})
const mockUploadFile = vi.fn(async (name: string, envelope: { ciphertext: string }) => {
  const slot = putDrive(name, envelope.ciphertext)
  events.push(`upload:${envelope.ciphertext}`)
  return { id: slot.id, modifiedTime: slot.modifiedTime }
})
vi.mock('../google-drive', async () => {
  const actual = await vi.importActual<typeof import('../google-drive')>('../google-drive')
  return {
    ...actual,
    listFiles: vi.fn(async () => []),
    downloadFile: (id: string) => mockDownloadFile(id),
    uploadFile: (name: string, envelope: { ciphertext: string }) => mockUploadFile(name, envelope),
  }
})

const mockEncrypt = vi.fn(async (plaintext: string, _pw: string, syncUnit: string) => ({ syncUnit, ciphertext: plaintext }))
vi.mock('../sync-crypto', () => ({
  encrypt: (plaintext: string, pw: string, syncUnit: string) => mockEncrypt(plaintext, pw, syncUnit),
  decrypt: vi.fn(async (envelope: { ciphertext: string }) => envelope.ciphertext),
}))

const OWN = 'own-hash'
vi.mock('../../typing-analytics/machine-hash', () => ({
  getMachineHash: vi.fn(async () => OWN),
}))

let currentDb: import('../../typing-analytics/db/typing-analytics-db').TypingAnalyticsDB | null = null
vi.mock('../../typing-analytics/db/typing-analytics-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../typing-analytics/db/typing-analytics-db')>()
  return { ...actual, getTypingAnalyticsDB: () => currentDb }
})
vi.mock('../../typing-analytics/jsonl/apply-to-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../typing-analytics/jsonl/apply-to-cache')>()
  return {
    ...actual,
    applyRowsToCache: vi.fn((...args: Parameters<typeof actual.applyRowsToCache>) => {
      events.push(`apply:inTransaction=${String(currentDb?.getConnection().inTransaction)}`)
      return actual.applyRowsToCache(...args)
    }),
  }
})
vi.mock('../../typing-analytics/sync-state', () => ({
  loadSyncState: vi.fn(async () => null),
  saveSyncState: vi.fn(async () => undefined),
  emptySyncState: (id: string) => ({ _rev: 3, my_device_id: id, uploaded: {}, reconciled_at: {}, last_synced_at: 0 }),
}))
vi.mock('../../logger', () => ({ log: vi.fn() }))
vi.mock('../../app-config', () => ({
  loadAppConfig: vi.fn(() => ({ autoSync: false })),
  saveAppConfig: vi.fn(async () => undefined),
  getAppConfigStore: vi.fn(() => ({ get: () => false })),
}))
vi.mock('../../utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }))
const mockNotifyChange = vi.fn()
vi.mock('../sync-flush', () => ({ notifyChange: (unit: string) => mockNotifyChange(unit) }))

import { mergeWithRemote, mergeDeviceDayBundle, syncOrUpload } from '../sync-merge-dispatch'
import { mergeRemoteDeletedRanges } from '../typing-deleted-ranges-merge'
import {
  bundleSyncUnit,
  collectAllSyncUnits,
  collectAnalyticsSyncUnitsForUid,
  isAnalyticsSyncUnit,
  isTypingDeletedRangesSyncUnit,
} from '../sync-bundle'
import { driveFileName, type DriveFile } from '../google-drive'
import { MalformedSyncBundleError } from '../merge'
import { withWriteLock } from '../../per-uid-write-lock'
import { TypingAnalyticsDB } from '../../typing-analytics/db/typing-analytics-db'
import { applyRowsToCache } from '../../typing-analytics/jsonl/apply-to-cache'
import { minuteStatsRowId, scopeRowId, type JsonlRow } from '../../typing-analytics/jsonl/jsonl-row'
import { deletedRangesPath, deviceDayJsonlPath } from '../../typing-analytics/jsonl/paths'
import { deletedRangeForAll, serializeDeletedRanges, unionDeletedRanges, type DeletedRangeEntry } from '../../typing-analytics/deleted-ranges'
import { rebuildCacheFromMasterFiles, truncateCache } from '../../typing-analytics/cache-rebuild'
import { readDeletedRanges, updateDeletedRanges } from '../../typing-analytics/deleted-ranges-store'
import { typingDeletedRangesSyncUnit } from '../../typing-analytics/sync'
import { runOnFlushChain } from '../../typing-analytics/typing-analytics-pipeline'
import { deletedRangesAppliedPath } from '../../typing-analytics/jsonl/paths'
import { syncRuntime } from '../sync-runtime-state'
import { deleteDeviceTypingData } from '../typing-device-delete'
import { localDayRangeMs } from '../../../shared/local-day-range'
import { existsSync } from 'node:fs'
import type { SyncBundle } from '../../../shared/types/sync'

const PW = 'pw'
const UID = 'kb1'
const REMOTE = 'remote-hash'
const DAY = '2026-04-19'
const MIN = Date.UTC(2026, 3, 19, 10, 0)
const unit = (hash = REMOTE): string => typingDeletedRangesSyncUnit(UID, hash)
const entry = (id: string, cutoffMs = MIN + 60_000): DeletedRangeEntry => ({ id, startMs: MIN, endMs: MIN + 60_000, cutoffMs })
const scopeId = (hash: string): string => `${hash}|linux|${UID}`

function rowsFor(hash: string): JsonlRow[] {
  return [
    {
      id: scopeRowId(scopeId(hash)), kind: 'scope', updated_at: 1_000,
      payload: {
        id: scopeId(hash), machineHash: hash, osPlatform: 'linux', osRelease: '6', osArch: 'x64',
        keyboardUid: UID, keyboardVendorId: 1, keyboardProductId: 1, keyboardProductName: 'Pipette',
      },
    },
    {
      id: minuteStatsRowId(scopeId(hash), MIN, ''), kind: 'minute-stats', updated_at: 1_000,
      payload: {
        scopeId: scopeId(hash), minuteTs: MIN, keystrokes: 5, activeMs: 1_000, intervalAvgMs: 100,
        intervalMinMs: 50, intervalP25Ms: 75, intervalP50Ms: 100, intervalP75Ms: 150, intervalMaxMs: 200,
      },
    },
  ]
}

function liveStats(hash: string): number {
  return (currentDb!.getConnection().prepare(
    'SELECT COUNT(*) AS n FROM typing_minute_stats WHERE scope_id = ? AND is_deleted = 0',
  ).get(scopeId(hash)) as { n: number }).n
}

function rangesBundle(hash: string, entries: unknown[]): string {
  const bundle: SyncBundle = {
    type: 'typing-deleted-ranges',
    key: `${UID}|${hash}`,
    index: { uid: UID, entries: [] },
    files: { 'deleted-ranges.json': JSON.stringify({ version: 1, entries }) },
  }
  return JSON.stringify(bundle)
}

async function writeLocalRanges(hash: string, entries: DeletedRangeEntry[]): Promise<void> {
  const path = deletedRangesPath(mockUserDataPath, UID, hash)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, serializeDeletedRanges(entries), 'utf-8')
}

const localIds = async (hash = REMOTE): Promise<string[]> =>
  (await readDeletedRanges(mockUserDataPath, UID, hash)).map((e) => e.id)

function driveIds(hash = REMOTE): string[] {
  const slot = drive.get(driveFileName(unit(hash)))
  if (!slot) return []
  const bundle = JSON.parse(slot.content) as SyncBundle
  return (JSON.parse(bundle.files['deleted-ranges.json']) as { entries: DeletedRangeEntry[] }).entries.map((e) => e.id)
}

function driveFile(hash = REMOTE): DriveFile {
  const slot = drive.get(driveFileName(unit(hash)))!
  return { id: slot.id, name: slot.name, modifiedTime: slot.modifiedTime }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

function within<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))])
}

beforeEach(async () => {
  vi.clearAllMocks()
  drive.clear()
  events.length = 0
  mockUserDataPath = await mkdtemp(join(tmpdir(), 'sync-deleted-ranges-'))
  currentDb = new TypingAnalyticsDB(join(mockUserDataPath, 'cache.db'))
  applyRowsToCache(currentDb, rowsFor(REMOTE))
  applyRowsToCache(currentDb, rowsFor(OWN))
  events.length = 0
})

afterEach(async () => {
  currentDb?.close()
  currentDb = null
  await rm(mockUserDataPath, { recursive: true, force: true })
})

describe('unit predicates', () => {
  it('is its own unit kind, not an analytics day', () => {
    expect(isTypingDeletedRangesSyncUnit(unit())).toBe(true)
    expect(isAnalyticsSyncUnit(unit())).toBe(false)
    expect(isTypingDeletedRangesSyncUnit(`keyboards/${UID}/devices/${REMOTE}/days/${DAY}`)).toBe(false)
  })
})

describe('bundleSyncUnit', () => {
  it('bundles the validated file, or nothing when there is none', async () => {
    expect(await bundleSyncUnit(unit())).toBeNull()
    await writeLocalRanges(REMOTE, [entry('a')])
    const bundle = await bundleSyncUnit(unit())
    expect(bundle).toMatchObject({ type: 'typing-deleted-ranges', key: `${UID}|${REMOTE}` })
    expect(JSON.parse(bundle!.files['deleted-ranges.json'])).toEqual({ version: 1, entries: [entry('a')] })
  })

  it('refuses an unsafe uid or hash', async () => {
    expect(await bundleSyncUnit(`keyboards/../devices/${REMOTE}/deleted-ranges`)).toBeNull()
    expect(await bundleSyncUnit(`keyboards/${UID}/devices/../deleted-ranges`)).toBeNull()
  })
})

describe('collection', () => {
  it('collects the ranges file of every hash, own included', async () => {
    await writeLocalRanges(REMOTE, [entry('a')])
    await writeLocalRanges(OWN, [entry('b')])
    await writeLocalRanges('third', [entry('c')])
    const all = await collectAllSyncUnits()
    expect(all).toEqual(expect.arrayContaining([unit(REMOTE), unit(OWN), unit('third')]))
    const forUid = await collectAnalyticsSyncUnitsForUid(UID)
    expect(forUid).toEqual(expect.arrayContaining([unit(REMOTE), unit(OWN), unit('third')]))
    expect(await collectAnalyticsSyncUnitsForUid('other')).toEqual([])
  })
})

describe('mergeWithRemote', () => {
  it('takes in remote entries and hides them in the cache for another hash', async () => {
    putDrive(driveFileName(unit()), rangesBundle(REMOTE, [entry('a')]))
    expect(liveStats(REMOTE)).toBe(1)
    await mergeWithRemote(driveFile(), unit(), PW, [])
    expect(await localIds()).toEqual(['a'])
    expect(liveStats(REMOTE)).toBe(0)
    expect(liveStats(OWN)).toBe(1)
    expect(mockUploadFile).not.toHaveBeenCalled()
  })

  it('uploads the union when local holds entries Drive lacks', async () => {
    await writeLocalRanges(REMOTE, [entry('b')])
    putDrive(driveFileName(unit()), rangesBundle(REMOTE, [entry('a')]))
    await mergeWithRemote(driveFile(), unit(), PW, [])
    expect(await localIds()).toEqual(['a', 'b'])
    expect(driveIds()).toEqual(['a', 'b'])
  })

  it('drops invalid remote entries', async () => {
    putDrive(driveFileName(unit()), rangesBundle(REMOTE, [entry('a'), { id: 'x', startMs: -5 }]))
    await mergeWithRemote(driveFile(), unit(), PW, [])
    expect(await localIds()).toEqual(['a'])
  })

  it.each([
    ['entries not an array', JSON.stringify({ type: 'typing-deleted-ranges', key: 'k', index: {}, files: { 'deleted-ranges.json': '{"version":1,"entries":5}' } })],
    ['file not JSON', JSON.stringify({ type: 'typing-deleted-ranges', key: 'k', index: {}, files: { 'deleted-ranges.json': '{' } })],
    ['file missing', JSON.stringify({ type: 'typing-deleted-ranges', key: 'k', index: {}, files: {} })],
    ['no files', JSON.stringify({ type: 'typing-deleted-ranges', key: 'k', index: {} })],
  ])('throws MalformedSyncBundleError for a broken bundle (%s) and keeps local', async (_label, content) => {
    await writeLocalRanges(REMOTE, [entry('b')])
    putDrive(driveFileName(unit()), content)
    await expect(mergeWithRemote(driveFile(), unit(), PW, [])).rejects.toThrow(MalformedSyncBundleError)
    expect(await localIds()).toEqual(['b'])
    expect(mockUploadFile).not.toHaveBeenCalled()
  })

  it('stores the own hash\'s ranges without touching the cache', async () => {
    putDrive(driveFileName(unit(OWN)), rangesBundle(OWN, [entry('a')]))
    await mergeWithRemote(driveFile(OWN), unit(OWN), PW, [])
    expect(await localIds(OWN)).toEqual(['a'])
    expect(liveStats(OWN)).toBe(1)
    expect(mockDownloadFile).toHaveBeenCalled()
  })
})

describe('serialising a sync of the unit', () => {
  it('runs a merge only after an upload that bundled before it has finished', async () => {
    // Local holds a and c, Drive holds a. The first sync bundles {a, c}
    // and stops before its upload; another device then publishes {a, b, c};
    // a second merge of the unit is started.
    await writeLocalRanges(REMOTE, [entry('a'), entry('c')])
    putDrive(driveFileName(unit()), rangesBundle(REMOTE, [entry('a')]))
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    mockEncrypt.mockImplementationOnce(async (plaintext, _pw, syncUnit) => {
      events.push('bundled')
      await gate
      return { syncUnit, ciphertext: plaintext }
    })
    const first = syncOrUpload(unit(), PW, [driveFile()])
    while (!events.includes('bundled')) await tick()
    putDrive(driveFileName(unit()), rangesBundle(REMOTE, [entry('a'), entry('b'), entry('c')]))
    const second = mergeWithRemote(driveFile(), unit(), PW, [])
    await tick()
    const downloadsWhileHeld = events.filter((e) => e.startsWith('download:')).length
    release()
    await within(Promise.all([first, second]))
    expect(downloadsWhileHeld).toBe(1)
    // The second merge read Drive after the first upload, so nothing this
    // device holds is missing from Drive.
    const order = events.filter((e) => e.startsWith('download:') || e.startsWith('upload:'))
    expect(order.map((e) => e.split(':')[0])).toEqual(['download', 'upload', 'download'])
    const local = await localIds()
    const remote = driveIds()
    expect(local.every((id) => remote.includes(id))).toBe(true)
    // The device that published b still holds it, so its next merge sees
    // Drive lacking it and uploads it again.
    const other = unionDeletedRanges([entry('a'), entry('b'), entry('c')], remote.map((id) => entry(id)))
    expect(other.remoteNeedsUpdate).toBe(true)
  })

  it('does not serialise other units on the same lock', async () => {
    let release!: () => void
    const held = withWriteLock(`sync:${unit(REMOTE)}`, () => new Promise<void>((r) => { release = r }))
    putDrive(driveFileName(unit('third')), rangesBundle('third', [entry('a')]))
    await within(mergeWithRemote(driveFile('third'), unit('third'), PW, []))
    release()
    await held
  })
})

describe('no deadlock', () => {
  it('syncOrUpload with the file listed completes', async () => {
    await writeLocalRanges(REMOTE, [entry('b')])
    putDrive(driveFileName(unit()), rangesBundle(REMOTE, [entry('a')]))
    await within(syncOrUpload(unit(), PW, [driveFile()]))
    expect(driveIds()).toEqual(['a', 'b'])
  })

  it('syncOrUpload without a listed file uploads', async () => {
    await writeLocalRanges(REMOTE, [entry('b')])
    await within(syncOrUpload(unit(), PW, []))
    expect(driveIds()).toEqual(['b'])
  })

  it('a merge and a local update queued together both finish and both entries stay', async () => {
    putDrive(driveFileName(unit()), rangesBundle(REMOTE, [entry('a')]))
    await within(Promise.all([
      mergeWithRemote(driveFile(), unit(), PW, []),
      updateDeletedRanges(mockUserDataPath, UID, REMOTE, (local) => unionDeletedRanges(local, [entry('z')])),
    ]))
    expect(await localIds()).toEqual(['a', 'z'])
  })

  it('a merge waits for a store-lock holder and then finishes', async () => {
    let release!: () => void
    const held = withWriteLock(unit(), () => new Promise<void>((r) => { release = r }))
    putDrive(driveFileName(unit()), rangesBundle(REMOTE, [entry('a')]))
    const merge = mergeWithRemote(driveFile(), unit(), PW, [])
    await tick()
    expect(await Promise.race([merge.then(() => 'done'), tick().then(() => 'pending')])).toBe('pending')
    release()
    await held
    await within(merge)
    expect(liveStats(REMOTE)).toBe(0)
  })
})

describe('own-hash ranges', () => {
  it('a merge returns while the flush chain is busy, and the ranges are applied once it frees up', async () => {
    let release: (() => void) | undefined
    const blocker = runOnFlushChain(() => new Promise<void>((r) => { release = r }))
    putDrive(driveFileName(unit(OWN)), rangesBundle(OWN, [entry('a')]))
    await within(mergeWithRemote(driveFile(OWN), unit(OWN), PW, []))
    const record = deletedRangesAppliedPath(mockUserDataPath, UID, OWN)
    expect(existsSync(record)).toBe(false)
    while (!release) await tick()
    release()
    await blocker
    await within(runOnFlushChain(() => undefined))
    expect(JSON.parse(await readFile(record, 'utf-8'))).toEqual(['a'])
  })

  it('does not apply while a reset holds the keyboard', async () => {
    syncRuntime.resetKeyboards = new Set([UID])
    try {
      putDrive(driveFileName(unit(OWN)), rangesBundle(OWN, [entry('a')]))
      await mergeWithRemote(driveFile(OWN), unit(OWN), PW, [])
      await runOnFlushChain(() => undefined)
      expect(existsSync(deletedRangesAppliedPath(mockUserDataPath, UID, OWN))).toBe(false)
    } finally {
      syncRuntime.resetKeyboards = null
    }
  })
})

describe('mergeDeviceDayBundle', () => {
  const dayBundle = (hash: string): SyncBundle => ({
    type: 'typing-analytics-device',
    key: `${UID}|${hash}|${DAY}`,
    index: { uid: UID, entries: [] },
    files: { 'data.jsonl': rowsFor(hash).map((r) => JSON.stringify(r)).join('\n') + '\n' },
  })

  it('replays the rows and the ranges\' tombstones in one transaction', async () => {
    const fresh = 'fresh-hash'
    await writeLocalRanges(fresh, [entry('a')])
    const tombstone = vi.spyOn(currentDb!, 'tombstoneRowsForUidHashInRanges')
    const inTx: boolean[] = []
    tombstone.mockImplementation(function (this: TypingAnalyticsDB, ...args) {
      inTx.push(currentDb!.getConnection().inTransaction)
      return TypingAnalyticsDB.prototype.tombstoneRowsForUidHashInRanges.apply(currentDb!, args)
    })
    await mergeDeviceDayBundle(dayBundle(fresh), { uid: UID, machineHash: fresh, utcDay: DAY }, mockUserDataPath, OWN)
    expect(events).toContain('apply:inTransaction=true')
    expect(inTx).toEqual([true])
    expect(liveStats(fresh)).toBe(0)
    expect(await readFile(deviceDayJsonlPath(mockUserDataPath, UID, fresh, DAY), 'utf-8')).toContain('minute-stats')
  })

  it('replays without a transaction of its own when the hash has no ranges', async () => {
    const fresh = 'fresh-hash'
    await mergeDeviceDayBundle(dayBundle(fresh), { uid: UID, machineHash: fresh, utcDay: DAY }, mockUserDataPath, OWN)
    expect(liveStats(fresh)).toBe(1)
  })
})

describe('a Delete All range written by the owner of the data', () => {
  const LATER = MIN + 60_000

  function liveStatMinutes(hash: string): number[] {
    return (currentDb!.getConnection().prepare(
      'SELECT minute_ts AS m FROM typing_minute_stats WHERE scope_id = ? AND is_deleted = 0 ORDER BY minute_ts',
    ).all(scopeId(hash)) as Array<{ m: number }>).map((r) => r.m)
  }

  it('hides that device\'s rows up to the cutoff once merged, through a rebuild, and keeps later minutes', async () => {
    const stats = rowsFor(REMOTE)[1] as Extract<JsonlRow, { kind: 'minute-stats' }>
    const later: JsonlRow = {
      ...stats,
      id: minuteStatsRowId(scopeId(REMOTE), LATER, ''),
      payload: { ...stats.payload, minuteTs: LATER },
    }
    const dayPath = deviceDayJsonlPath(mockUserDataPath, UID, REMOTE, DAY)
    await mkdir(dirname(dayPath), { recursive: true })
    await writeFile(dayPath, [...rowsFor(REMOTE), later].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
    applyRowsToCache(currentDb!, [later])
    // The click minute counts as deleted: its start is before the cutoff.
    putDrive(driveFileName(unit()), rangesBundle(REMOTE, [deletedRangeForAll(MIN + 10_000, 'all')]))

    await mergeWithRemote(driveFile(), unit(), PW, [])
    expect(liveStatMinutes(REMOTE)).toEqual([LATER])

    truncateCache(currentDb!)
    await rebuildCacheFromMasterFiles(currentDb!, mockUserDataPath, OWN)
    expect(liveStatMinutes(REMOTE)).toEqual([LATER])
  })
})

describe('deleteDeviceTypingData', () => {
  const localDay = new Date(MIN)
  const date = `${localDay.getFullYear()}-${String(localDay.getMonth() + 1).padStart(2, '0')}-${String(localDay.getDate()).padStart(2, '0')}`

  it('adds a range per run of local days, hides the rows at once and announces the unit', async () => {
    await deleteDeviceTypingData(UID, REMOTE, [date], MIN + 60_000)
    const entries = await readDeletedRanges(mockUserDataPath, UID, REMOTE)
    expect(entries).toEqual([{ id: expect.any(String), ...localDayRangeMs(date)!, cutoffMs: MIN + 60_000 }])
    expect(liveStats(REMOTE)).toBe(0)
    expect(liveStats(OWN)).toBe(1)
    expect(mockNotifyChange).toHaveBeenCalledWith(unit())
    expect(mockDownloadFile).not.toHaveBeenCalled()
    expect(mockUploadFile).not.toHaveBeenCalled()
  })

  it('keeps rows recorded after the cutoff', async () => {
    await deleteDeviceTypingData(UID, REMOTE, [date], MIN - 1)
    expect(liveStats(REMOTE)).toBe(1)
  })

  it('deletes everything up to the cutoff for \'all\'', async () => {
    await deleteDeviceTypingData(UID, REMOTE, 'all', MIN)
    expect(await readDeletedRanges(mockUserDataPath, UID, REMOTE)).toEqual([{ id: expect.any(String), startMs: 0, endMs: MIN + 1, cutoffMs: MIN }])
    expect(liveStats(REMOTE)).toBe(0)
  })

  it('appends to the ranges already in the file', async () => {
    await writeLocalRanges(REMOTE, [entry('old')])
    await deleteDeviceTypingData(UID, REMOTE, 'all', MIN)
    expect((await localIds()).length).toBe(2)
    expect(await localIds()).toContain('old')
  })

  it('refuses this device\'s own hash before writing anything', async () => {
    await expect(deleteDeviceTypingData(UID, OWN, 'all', MIN)).rejects.toThrow('sync.ownDeviceDeleteFromLocal')
    expect(existsSync(deletedRangesPath(mockUserDataPath, UID, OWN))).toBe(false)
    expect(liveStats(OWN)).toBe(1)
  })

  it('does nothing for no dates', async () => {
    await deleteDeviceTypingData(UID, REMOTE, [], MIN)
    expect(existsSync(deletedRangesPath(mockUserDataPath, UID, REMOTE))).toBe(false)
    expect(mockNotifyChange).not.toHaveBeenCalled()
  })
})

const rangeEntry = (id: string, cutoffMs = 100): DeletedRangeEntry => ({ id, startMs: 0, endMs: 50, cutoffMs })

describe('mergeRemoteDeletedRanges', () => {
  it('merges a remote file, dropping its invalid entries', () => {
    const result = mergeRemoteDeletedRanges([rangeEntry('a')], { version: 1, entries: [rangeEntry('b', 1), { id: 'x', startMs: 'no' }] }, unit())
    expect(result.entries).toEqual([rangeEntry('b', 1), rangeEntry('a')])
    expect(result.localChanged).toBe(true)
    expect(result.remoteNeedsUpdate).toBe(true)
  })

  it('throws MalformedSyncBundleError on a broken file shape', () => {
    expect(() => mergeRemoteDeletedRanges([], { version: 1, entries: 'x' }, unit())).toThrow(MalformedSyncBundleError)
    expect(() => mergeRemoteDeletedRanges([], 'nope', unit())).toThrow(MalformedSyncBundleError)
  })
})

