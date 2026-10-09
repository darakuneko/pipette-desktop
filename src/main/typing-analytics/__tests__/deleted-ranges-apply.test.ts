// SPDX-License-Identifier: GPL-2.0-or-later
// This device applying the deleted ranges another device wrote for it:
// per-range cutoffs, several ranges at once, the applied-ids record, retry
// after a failed cache step, and the reset skip.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dirname, join } from 'node:path'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
vi.mock('node-machine-id', () => ({
  default: { machineId: async () => 'fixed-machine-id' },
  machineId: async () => 'fixed-machine-id',
}))
vi.mock('../jsonl/apply-to-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../jsonl/apply-to-cache')>()
  return { ...actual, applyRowsToCache: vi.fn(actual.applyRowsToCache) }
})

import { ipcMain } from 'electron'
import {
  setupTypingAnalyticsIpc,
  resetTypingAnalyticsForTests,
  flushTypingAnalyticsNowForTests,
  setTypingAnalyticsSyncNotifier,
  runOnFlushChain,
} from '../typing-analytics-service'
import { applyOwnDeletedRanges, applyOwnDeletedRangesForAllKeyboards } from '../deleted-ranges-apply'
import { deletedRangesAppliedPath, deletedRangesPath, deviceDayJsonlPath } from '../jsonl/paths'
import { readRows } from '../jsonl/jsonl-reader'
import { applyRowsToCache } from '../jsonl/apply-to-cache'
import { serializeDeletedRanges, type DeletedRangeEntry } from '../deleted-ranges'
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
const DAY_1 = '2026-04-13'
const DAY_2 = '2026-04-14'
const T1 = Date.UTC(2026, 3, 13, 10, 0)
const T2 = Date.UTC(2026, 3, 13, 11, 0)
const T3 = Date.UTC(2026, 3, 14, 10, 0)
const DAY_1_RANGE = { startMs: Date.UTC(2026, 3, 13), endMs: Date.UTC(2026, 3, 14) }
const DAY_2_RANGE = { startMs: Date.UTC(2026, 3, 14), endMs: Date.UTC(2026, 3, 15) }
const never = (): boolean => false

async function typeAt(...timestamps: number[]): Promise<void> {
  setupTypingAnalyticsIpc()
  const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
  for (const ts of timestamps) {
    vi.setSystemTime(ts)
    await handler({}, { kind: 'char', key: 'a', ts, keyboard })
  }
  await flushTypingAnalyticsNowForTests()
}

async function fileText(day: string): Promise<string> {
  return readFile(deviceDayJsonlPath(mockUserDataPath, keyboard.uid, await getMachineHash(), day), 'utf8')
}

async function deletedStats(day: string): Promise<number[]> {
  const path = deviceDayJsonlPath(mockUserDataPath, keyboard.uid, await getMachineHash(), day)
  return (await readRows(path)).rows.flatMap((r) => (r.kind === 'minute-stats' && r.is_deleted ? [r.payload.minuteTs] : []))
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

const entry = (id: string, range: { startMs: number; endMs: number }, cutoffMs: number): DeletedRangeEntry =>
  ({ id, ...range, cutoffMs })

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.clearAllMocks()
  mockUserDataPath = await mkdtemp(join(tmpdir(), 'pipette-ranges-apply-'))
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

describe('applyOwnDeletedRanges', () => {
  it('removes the rows up to each range\'s own cutoff and keeps later ones', async () => {
    await typeAt(T1, T2, T3)
    await applyOwnDeletedRanges(keyboard.uid, [
      entry('a', DAY_1_RANGE, T1 + MINUTE - 1),
      entry('b', DAY_2_RANGE, T3 + MINUTE),
    ], never)
    expect(liveCacheMinutes()).toEqual([T2])
    expect(await deletedStats(DAY_1)).toEqual([T1])
    expect(await deletedStats(DAY_2)).toEqual([T3])
    expect(await appliedIds()).toEqual(['a', 'b'])
  })

  it('applies several waiting ranges in one task and announces each touched day once', async () => {
    await typeAt(T1, T3)
    const notifier = vi.fn()
    setTypingAnalyticsSyncNotifier(notifier)
    await applyOwnDeletedRanges(keyboard.uid, [
      entry('a', DAY_1_RANGE, T3 + MINUTE),
      entry('b', DAY_2_RANGE, T3 + MINUTE),
      entry('c', { startMs: 0, endMs: T1 + 1 }, T1),
    ], never)
    expect(liveCacheMinutes()).toEqual([])
    const hash = await getMachineHash()
    expect(notifier.mock.calls.map((c) => c[0]).sort()).toEqual([
      `keyboards/${keyboard.uid}/devices/${hash}/days/${DAY_1}`,
      `keyboards/${keyboard.uid}/devices/${hash}/days/${DAY_2}`,
    ])
  })

  it('is idempotent: recorded ids are skipped and a second run writes nothing', async () => {
    await typeAt(T1)
    const ranges = [entry('a', DAY_1_RANGE, T2)]
    await applyOwnDeletedRanges(keyboard.uid, ranges, never)
    const after = await fileText(DAY_1)
    // Typed after the first apply but inside the range and before its cutoff:
    // a recorded id is not applied again.
    await typeAt(T1 + 30 * MINUTE)
    const afterTyping = await fileText(DAY_1)
    await applyOwnDeletedRanges(keyboard.uid, ranges, never)
    expect(await fileText(DAY_1)).toBe(afterTyping)
    expect(afterTyping.startsWith(after)).toBe(true)
    expect(liveCacheMinutes()).toEqual([T1 + 30 * MINUTE])
  })

  it('records nothing when the task fails, and the retry repairs the cache from the marks already written', async () => {
    await typeAt(T1, T2)
    vi.mocked(applyRowsToCache).mockImplementationOnce(() => { throw new Error('cache down') })
    await expect(applyOwnDeletedRanges(keyboard.uid, [entry('a', DAY_1_RANGE, T2 + MINUTE)], never)).rejects.toThrow('cache down')
    expect(await appliedIds()).toBeNull()
    // The marks reached the file, the cache did not get them.
    expect(await deletedStats(DAY_1)).toEqual([T1, T2])
    expect(liveCacheMinutes()).toEqual([T1, T2])
    const before = await fileText(DAY_1)

    await applyOwnDeletedRanges(keyboard.uid, [entry('a', DAY_1_RANGE, T2 + MINUTE)], never)

    expect(liveCacheMinutes()).toEqual([])
    expect(await fileText(DAY_1)).toBe(before)
    expect(await appliedIds()).toEqual(['a'])
  })

  it.skipIf(process.getuid?.() === 0)('fails and records nothing when a listed day file cannot be read', async () => {
    await typeAt(T1)
    const path = deviceDayJsonlPath(mockUserDataPath, keyboard.uid, await getMachineHash(), DAY_1)
    await chmod(path, 0o000)
    try {
      await expect(applyOwnDeletedRanges(keyboard.uid, [entry('a', DAY_1_RANGE, T2)], never)).rejects.toThrow()
      expect(await appliedIds()).toBeNull()
    } finally {
      await chmod(path, 0o644)
    }
    await applyOwnDeletedRanges(keyboard.uid, [entry('a', DAY_1_RANGE, T2)], never)
    expect(liveCacheMinutes()).toEqual([])
    expect(await appliedIds()).toEqual(['a'])
  })

  it('a skipped apply is done by the next run from the local ranges file', async () => {
    await typeAt(T1)
    const hash = await getMachineHash()
    const path = deletedRangesPath(mockUserDataPath, keyboard.uid, hash)
    await writeFile(path, serializeDeletedRanges([entry('a', DAY_1_RANGE, T2)]))
    await applyOwnDeletedRanges(keyboard.uid, [entry('a', DAY_1_RANGE, T2)], () => true)
    expect(liveCacheMinutes()).toEqual([T1])

    await applyOwnDeletedRangesForAllKeyboards(mockUserDataPath, hash, () => false)

    expect(liveCacheMinutes()).toEqual([])
    expect(await appliedIds()).toEqual(['a'])
  })

  it('does nothing while a reset holds the keyboard', async () => {
    await typeAt(T1)
    const before = await fileText(DAY_1)
    await applyOwnDeletedRanges(keyboard.uid, [entry('a', DAY_1_RANGE, T2)], () => true)
    expect(await fileText(DAY_1)).toBe(before)
    expect(liveCacheMinutes()).toEqual([T1])
    expect(await appliedIds()).toBeNull()
  })

  it('checks the reset again when its task starts on the flush chain', async () => {
    await typeAt(T1)
    let resetting = false
    let release: (() => void) | undefined
    const blocker = runOnFlushChain(() => new Promise<void>((r) => { release = r }))
    const apply = applyOwnDeletedRanges(keyboard.uid, [entry('a', DAY_1_RANGE, T2)], () => resetting)
    resetting = true
    while (!release) await new Promise((r) => setImmediate(r))
    release()
    await blocker
    await apply
    expect(liveCacheMinutes()).toEqual([T1])
  })

  it('applies a delete-all range to the existing day files', async () => {
    await typeAt(T1)
    await applyOwnDeletedRanges(keyboard.uid, [entry('all', { startMs: 0, endMs: T2 + 1 }, T2)], never)
    expect(liveCacheMinutes()).toEqual([])
    expect(await deletedStats(DAY_1)).toEqual([T1])
  })
})

describe('applyOwnDeletedRangesForAllKeyboards', () => {
  it('applies the own-hash ranges file of every keyboard', async () => {
    await typeAt(T1, T3)
    const hash = await getMachineHash()
    const path = deletedRangesPath(mockUserDataPath, keyboard.uid, hash)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, serializeDeletedRanges([entry('a', DAY_1_RANGE, T3)]))
    // Another device's ranges file is not this device's to apply.
    const otherPath = deletedRangesPath(mockUserDataPath, keyboard.uid, 'other-hash')
    await mkdir(dirname(otherPath), { recursive: true })
    await writeFile(otherPath, serializeDeletedRanges([entry('x', DAY_2_RANGE, T3 + MINUTE)]))

    await applyOwnDeletedRangesForAllKeyboards(mockUserDataPath, hash, never)

    expect(liveCacheMinutes()).toEqual([T3])
  })
})
