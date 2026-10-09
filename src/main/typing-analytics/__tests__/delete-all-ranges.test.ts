// SPDX-License-Identifier: GPL-2.0-or-later
// The Local tab's Delete All on the device that owns the data: the range it
// adds to its own deleted-ranges file for the other devices, the applied
// record that keeps it from applying that range to itself, and an import of
// an old export that must not bring the deleted typing back.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

let mockUserDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? mockUserDataPath : `/mock/${name}`),
  },
  ipcMain: { handle: vi.fn() },
}))
vi.mock('../../ipc-guard', async () => {
  const { ipcMain } = await import('electron')
  return { secureHandle: ipcMain.handle }
})
vi.mock('../../pipette-settings-store', () => ({
  readPipetteSettings: vi.fn().mockResolvedValue(null),
  setupPipetteSettingsStore: vi.fn(),
}))
vi.mock('../../app-config', () => ({
  loadAppConfig: () => ({ typingMonitorAppEnabled: false }),
}))
vi.mock('../app-monitor', () => ({
  getCurrentAppName: vi.fn(async () => null),
}))
vi.mock('../../logger', () => ({ log: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, unlink: vi.fn(actual.unlink) }
})
vi.mock('node-machine-id', () => ({
  default: { machineId: async () => 'fixed-machine-id' },
  machineId: async () => 'fixed-machine-id',
}))

import { ipcMain } from 'electron'
import {
  setupTypingAnalyticsIpc,
  resetTypingAnalyticsForTests,
  flushTypingAnalyticsNowForTests,
  setTypingAnalyticsSyncNotifier,
  deleteAllTypingForKeyboard,
  runOnFlushChain,
} from '../typing-analytics-service'
import { applyOwnDeletedRangesForAllKeyboards, prepareOwnDeletedRangesReapply } from '../deleted-ranges-apply'
import { readDeletedRanges } from '../deleted-ranges-store'
import { deletedRangesAppliedPath, deletedRangesPath, deviceDayJsonlPath } from '../jsonl/paths'
import { readRows } from '../jsonl/jsonl-reader'
import { exportFileNameFor, exportTypingDataForKeyboard, importTypingDataFiles } from '../import-export'
import { rebuildCacheFromMasterFiles, truncateCache } from '../cache-rebuild'
import { typingDeletedRangesSyncUnit } from '../sync'
import * as installationIdModule from '../installation-id'
import { getMachineHash, resetMachineHashCacheForTests } from '../machine-hash'
import { getTypingAnalyticsDB, resetTypingAnalyticsDBForTests } from '../db/typing-analytics-db'
import { IpcChannels } from '../../../shared/ipc/channels'

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>

function getHandler(channel: string): IpcHandler {
  const match = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel)
  if (!match) throw new Error(`No handler registered for ${channel}`)
  return match[1] as IpcHandler
}

const keyboard = { uid: '0xAABB', vendorId: 0xFEED, productId: 0x0000, productName: 'Pipette Keyboard' }
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY_1 = '2026-04-13'
const DAY_2 = '2026-04-14'
const T1 = Date.UTC(2026, 3, 13, 10, 0)
const T3 = Date.UTC(2026, 3, 14, 10, 0)

async function typeAt(...timestamps: number[]): Promise<void> {
  setupTypingAnalyticsIpc()
  const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
  for (const ts of timestamps) {
    vi.setSystemTime(ts)
    await handler({}, { kind: 'char', key: 'a', ts, keyboard })
  }
  await flushTypingAnalyticsNowForTests()
}

function liveCacheMinutes(): number[] {
  const rows = getTypingAnalyticsDB().getConnection().prepare(
    'SELECT minute_ts FROM typing_minute_stats WHERE is_deleted = 0 ORDER BY minute_ts',
  ).all() as Array<{ minute_ts: number }>
  return rows.map((r) => r.minute_ts)
}

async function appliedIds(): Promise<unknown> {
  const path = deletedRangesAppliedPath(mockUserDataPath, keyboard.uid, await getMachineHash())
  return existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : null
}

async function deleteAllAt(cutoffMs: number, scope: 'own' | 'all' = 'own'): Promise<void> {
  vi.setSystemTime(cutoffMs)
  await deleteAllTypingForKeyboard(keyboard.uid, cutoffMs, scope)
}

async function rebuild(): Promise<void> {
  const db = getTypingAnalyticsDB()
  truncateCache(db)
  await rebuildCacheFromMasterFiles(db, mockUserDataPath, await getMachineHash())
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.clearAllMocks()
  const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(unlink).mockReset().mockImplementation(actualFs.unlink)
  mockUserDataPath = await mkdtemp(join(tmpdir(), 'pipette-delete-all-ranges-'))
  resetTypingAnalyticsForTests()
  resetTypingAnalyticsDBForTests()
  installationIdModule.resetInstallationIdCacheForTests()
  resetMachineHashCacheForTests()
})

afterEach(async () => {
  resetTypingAnalyticsDBForTests()
  await rm(mockUserDataPath, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('Delete All of the Local tab', () => {
  it('adds one range up to the cutoff to the own-hash file, records it as applied and announces the unit', async () => {
    await typeAt(T1)
    const notifier = vi.fn()
    setTypingAnalyticsSyncNotifier(notifier)
    const cutoffMs = T1 + HOUR

    await deleteAllAt(cutoffMs)

    const hash = await getMachineHash()
    const entries = await readDeletedRanges(mockUserDataPath, keyboard.uid, hash)
    expect(entries).toEqual([{ id: expect.any(String), startMs: 0, endMs: cutoffMs + 1, cutoffMs }])
    expect(await appliedIds()).toEqual([entries[0].id])
    expect(notifier).toHaveBeenCalledWith(typingDeletedRangesSyncUnit(keyboard.uid, hash))
    expect(liveCacheMinutes()).toEqual([])
  })

  it('does the same when this device holds no days or rows of the keyboard', async () => {
    const notifier = vi.fn()
    setTypingAnalyticsSyncNotifier(notifier)

    await deleteAllAt(T1)

    const hash = await getMachineHash()
    const entries = await readDeletedRanges(mockUserDataPath, keyboard.uid, hash)
    expect(entries).toEqual([{ id: expect.any(String), startMs: 0, endMs: T1 + 1, cutoffMs: T1 }])
    expect(await appliedIds()).toEqual([entries[0].id])
    expect(notifier.mock.calls).toEqual([[typingDeletedRangesSyncUnit(keyboard.uid, hash)]])
  })

  it('appends to the ranges already in the file', async () => {
    await deleteAllAt(T1)
    await deleteAllAt(T1 + HOUR)
    const entries = await readDeletedRanges(mockUserDataPath, keyboard.uid, await getMachineHash())
    expect(entries.map((e) => e.cutoffMs)).toEqual([T1, T1 + HOUR])
    expect(await appliedIds()).toEqual(entries.map((e) => e.id).sort())
  })

  it('writes no range for the reset scope', async () => {
    await typeAt(T1)
    const notifier = vi.fn()
    setTypingAnalyticsSyncNotifier(notifier)

    await deleteAllAt(T1 + HOUR, 'all')

    const hash = await getMachineHash()
    expect(existsSync(deletedRangesPath(mockUserDataPath, keyboard.uid, hash))).toBe(false)
    expect(await appliedIds()).toBeNull()
    expect(notifier).not.toHaveBeenCalledWith(typingDeletedRangesSyncUnit(keyboard.uid, hash))
  })

  it('keeps typing of the click minute typed after the delete through the next apply', async () => {
    await typeAt(T1)
    await deleteAllAt(T1 + 10_000)
    await typeAt(T1 + 20_000)
    expect(liveCacheMinutes()).toEqual([T1])
    const hash = await getMachineHash()

    await applyOwnDeletedRangesForAllKeyboards(mockUserDataPath, hash, () => false)
    expect(liveCacheMinutes()).toEqual([T1])

    // Without the applied record the range would remove that minute.
    await unlink(deletedRangesAppliedPath(mockUserDataPath, keyboard.uid, hash))
    await applyOwnDeletedRangesForAllKeyboards(mockUserDataPath, hash, () => false)
    expect(liveCacheMinutes()).toEqual([])
  })

  it('leaves the range unapplied when a day file cannot be removed, so the next apply marks that file', async () => {
    await typeAt(T1, T3)
    const hash = await getMachineHash()
    const stuck = deviceDayJsonlPath(mockUserDataPath, keyboard.uid, hash, DAY_1)
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(unlink).mockImplementation(async (path) => {
      if (path === stuck) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return actualFs.unlink(path)
    })
    const notifier = vi.fn()
    setTypingAnalyticsSyncNotifier(notifier)

    await deleteAllAt(T3 + HOUR)

    expect(existsSync(stuck)).toBe(true)
    expect(existsSync(deviceDayJsonlPath(mockUserDataPath, keyboard.uid, hash, DAY_2))).toBe(false)
    const entries = await readDeletedRanges(mockUserDataPath, keyboard.uid, hash)
    expect(entries).toHaveLength(1)
    expect(await appliedIds()).toBeNull()
    expect(notifier).toHaveBeenCalledWith(typingDeletedRangesSyncUnit(keyboard.uid, hash))

    await applyOwnDeletedRangesForAllKeyboards(mockUserDataPath, hash, () => false)

    expect(await appliedIds()).toEqual([entries[0].id])
    const { rows } = await readRows(stuck)
    expect(rows.some((r) => r.kind === 'minute-stats' && r.is_deleted === true && r.payload.minuteTs === T1)).toBe(true)
    await rebuild()
    expect(liveCacheMinutes()).toEqual([])
  })

  it('keeps typing of later minutes', async () => {
    await typeAt(T1)
    await deleteAllAt(T1 + 10_000)
    await typeAt(T1 + MINUTE)
    await applyOwnDeletedRangesForAllKeyboards(mockUserDataPath, await getMachineHash(), () => false)
    await rebuild()
    expect(liveCacheMinutes()).toEqual([T1 + MINUTE])
  })
})

describe('importing an export taken before Delete All', () => {
  async function importDay1(): Promise<Awaited<ReturnType<typeof importTypingDataFiles>>> {
    const hash = await getMachineHash()
    return importTypingDataFiles(mockUserDataPath, [join(mockUserDataPath, 'export', exportFileNameFor(keyboard.uid, hash, DAY_1))], {
      cloudHasFile: null,
      now: () => T1 + 48 * HOUR,
      runExclusive: runOnFlushChain,
      prepareReplace: prepareOwnDeletedRangesReapply,
    })
  }

  async function exportNow(): Promise<void> {
    await exportTypingDataForKeyboard(mockUserDataPath, keyboard.uid, await getMachineHash(), join(mockUserDataPath, 'export'))
  }

  it('leaves the restored rows deleted when the day was typed on again', async () => {
    await typeAt(T1)
    await exportNow()
    await deleteAllAt(T1 + HOUR)
    // Typed again on the same UTC day, so the day file exists to import onto.
    await typeAt(T1 + 2 * HOUR)

    const result = await importDay1()
    await rebuild()

    expect(result.imported).toBe(1)
    // The import replaces the day file, re-typed rows included; what it
    // brings back from before the delete stays deleted.
    expect(liveCacheMinutes()).toEqual([])
    const { rows } = await readRows(deviceDayJsonlPath(mockUserDataPath, keyboard.uid, await getMachineHash(), DAY_1))
    expect(rows.some((r) => r.kind === 'minute-stats' && r.is_deleted === true && r.payload.minuteTs === T1)).toBe(true)
  })

  it('restores the rows when no range covers them', async () => {
    await typeAt(T1)
    await exportNow()
    await typeAt(T1 + 2 * HOUR)

    await importDay1()
    await rebuild()

    expect(liveCacheMinutes()).toEqual([T1])
  })

  it('leaves the file as it is and rejects it when the ranges file cannot be read', async () => {
    await typeAt(T1)
    await exportNow()
    await deleteAllAt(T1 + HOUR)
    await typeAt(T1 + 2 * HOUR)
    const hash = await getMachineHash()
    await writeFile(deletedRangesPath(mockUserDataPath, keyboard.uid, hash), '{broken')
    const dayPath = deviceDayJsonlPath(mockUserDataPath, keyboard.uid, hash, DAY_1)
    const before = await readFile(dayPath, 'utf8')

    const result = await importDay1()

    expect(result.imported).toBe(0)
    expect(result.rejections).toEqual([{ fileName: exportFileNameFor(keyboard.uid, hash, DAY_1), reason: 'deleted-ranges-unreadable' }])
    expect(await readFile(dayPath, 'utf8')).toBe(before)
  })
})

describe('prepareOwnDeletedRangesReapply', () => {
  it('reads nothing and marks nothing for another device\'s file', async () => {
    await typeAt(T1)
    // Unreadable, so a read of it would throw.
    await writeFile(deletedRangesPath(mockUserDataPath, keyboard.uid, await getMachineHash()), '{broken')
    const step = await prepareOwnDeletedRangesReapply({ uid: keyboard.uid, machineHash: 'other-hash', utcDay: DAY_1 })
    await runOnFlushChain(step)
    expect(liveCacheMinutes()).toEqual([T1])
  })
})
