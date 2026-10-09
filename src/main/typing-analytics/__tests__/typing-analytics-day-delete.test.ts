// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

let mockUserDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserDataPath
      return `/mock/${name}`
    },
  },
  ipcMain: {
    handle: vi.fn(),
  },
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

vi.mock('../../logger', () => ({
  log: vi.fn(),
}))

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
  listTypingDailySummaries,
  deleteTypingDailySummaries,
  deleteAllTypingForKeyboard,
} from '../typing-analytics-service'
import { collectRowsToMark, utcDaysOverlapping } from '../typing-analytics-day-delete'
import { deviceDayJsonlPath } from '../jsonl/paths'
import { readRows } from '../jsonl/jsonl-reader'
import { parseRow, type JsonlRow } from '../jsonl/jsonl-row'
import { applyRowsToCache } from '../jsonl/apply-to-cache'
import { rebuildCacheFromMasterFiles, truncateCache } from '../cache-rebuild'
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

/** Types one key per timestamp (the clock pinned to it, see the same
 *  helper in typing-analytics-service.test.ts), then flushes. */
async function typeAt(...timestamps: number[]): Promise<void> {
  setupTypingAnalyticsIpc()
  const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
  for (const ts of timestamps) {
    vi.setSystemTime(ts)
    await handler({}, { kind: 'char', key: 'a', ts, keyboard })
  }
  await flushTypingAnalyticsNowForTests()
}

async function dayRows(utcDay: string): Promise<JsonlRow[]> {
  const path = deviceDayJsonlPath(mockUserDataPath, keyboard.uid, await getMachineHash(), utcDay)
  return (await readRows(path)).rows
}

/** minuteTs of the minute-stats rows in a day file, split by deleted or not. */
async function statsMinutes(utcDay: string): Promise<{ live: number[]; deleted: number[] }> {
  const live: number[] = []
  const deleted: number[] = []
  for (const row of await dayRows(utcDay)) {
    if (row.kind !== 'minute-stats') continue
    ;(row.is_deleted ? deleted : live).push(row.payload.minuteTs)
  }
  return { live, deleted }
}

function liveCacheMinutes(): number[] {
  const rows = getTypingAnalyticsDB().getConnection().prepare(
    'SELECT minute_ts FROM typing_minute_stats WHERE is_deleted = 0 ORDER BY minute_ts',
  ).all() as Array<{ minute_ts: number }>
  return rows.map((r) => r.minute_ts)
}

function liveSessionStarts(): number[] {
  const rows = getTypingAnalyticsDB().getConnection().prepare(
    'SELECT start_ms FROM typing_sessions WHERE is_deleted = 0 ORDER BY start_ms',
  ).all() as Array<{ start_ms: number }>
  return rows.map((r) => r.start_ms)
}

describe('deleting local days of this device', () => {
  const originalTz = process.env.TZ

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.clearAllMocks()
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'pipette-typing-day-delete-test-'))
    resetTypingAnalyticsForTests()
    resetTypingAnalyticsDBForTests()
    installationIdModule.resetInstallationIdCacheForTests()
    resetMachineHashCacheForTests()
  })

  afterEach(async () => {
    resetTypingAnalyticsDBForTests()
    await rm(mockUserDataPath, { recursive: true, force: true })
    vi.useRealTimers()
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
  })

  describe('in Asia/Tokyo (UTC+9)', () => {
    beforeEach(() => { process.env.TZ = 'Asia/Tokyo' })

    // Local 2026-04-14 is [2026-04-13 15:00Z, 2026-04-14 15:00Z).
    const before = Date.UTC(2026, 3, 13, 14, 0) // local 04-13 23:00
    const inEarly = Date.UTC(2026, 3, 13, 23, 30) // local 04-14 08:30, UTC file 04-13
    const inLate = Date.UTC(2026, 3, 14, 1, 0) // local 04-14 10:00, UTC file 04-14
    const after = Date.UTC(2026, 3, 14, 23, 0) // local 04-15 08:00, UTC file 04-14

    it('marks the rows of the local day in both overlapping UTC files and keeps the rest', async () => {
      const notifier = vi.fn()
      setTypingAnalyticsSyncNotifier(notifier)
      await typeAt(before, inEarly, inLate, after)
      const linesBefore = (await readFile(deviceDayJsonlPath(mockUserDataPath, keyboard.uid, await getMachineHash(), '2026-04-13'), 'utf8')).split('\n')
      notifier.mockClear()

      const result = await deleteTypingDailySummaries(keyboard.uid, ['2026-04-14'])

      expect(result.minuteStats).toBe(2)
      expect(await statsMinutes('2026-04-13')).toEqual({ live: [before, inEarly], deleted: [inEarly] })
      expect(await statsMinutes('2026-04-14')).toEqual({ live: [inLate, after], deleted: [inLate] })
      // The marks are appended; every earlier line stays as it was.
      const linesAfter = (await readFile(deviceDayJsonlPath(mockUserDataPath, keyboard.uid, await getMachineHash(), '2026-04-13'), 'utf8')).split('\n')
      expect(linesAfter.slice(0, linesBefore.length - 1)).toEqual(linesBefore.slice(0, -1))

      expect(liveCacheMinutes()).toEqual([before, after])
      expect(listTypingDailySummaries(keyboard.uid).map((s) => s.date).sort()).toEqual(['2026-04-13', '2026-04-15'])
      const hash = await getMachineHash()
      expect(notifier.mock.calls.map((c) => c[0]).sort()).toEqual([
        `keyboards/${keyboard.uid}/devices/${hash}/days/2026-04-13`,
        `keyboards/${keyboard.uid}/devices/${hash}/days/2026-04-14`,
      ])
    })

    it('every mark is newer than the row it deletes and than the earlier flushes', async () => {
      await typeAt(inEarly, inLate)
      await deleteTypingDailySummaries(keyboard.uid, ['2026-04-14'])

      for (const day of ['2026-04-13', '2026-04-14']) {
        const rows = await dayRows(day)
        const newestLive = Math.max(...rows.filter((r) => !r.is_deleted).map((r) => r.updated_at))
        const marks = rows.filter((r) => r.is_deleted)
        expect(marks.length).toBeGreaterThan(0)
        for (const mark of marks) expect(mark.updated_at).toBeGreaterThan(newestLive)
      }
    })

    it('a rebuild from the files ends with the same cache', async () => {
      await typeAt(before, inEarly, inLate, after)
      await deleteTypingDailySummaries(keyboard.uid, ['2026-04-14'])
      const summaries = listTypingDailySummaries(keyboard.uid)

      await rebuildCacheFromMasterFiles(getTypingAnalyticsDB(), mockUserDataPath)

      expect(listTypingDailySummaries(keyboard.uid)).toEqual(summaries)
      expect(liveCacheMinutes()).toEqual([before, after])
    })

    it('another PC replaying the uploaded file over its earlier copy drops the deleted rows', async () => {
      await typeAt(before, inEarly, inLate, after)
      const earlier = [...await dayRows('2026-04-13'), ...await dayRows('2026-04-14')]
      await deleteTypingDailySummaries(keyboard.uid, ['2026-04-14'])
      const uploaded = [...await dayRows('2026-04-13'), ...await dayRows('2026-04-14')]

      const db = getTypingAnalyticsDB()
      truncateCache(db)
      applyRowsToCache(db, earlier)
      expect(liveCacheMinutes()).toEqual([before, inEarly, inLate, after])
      applyRowsToCache(db, uploaded)
      expect(liveCacheMinutes()).toEqual([before, after])
    })

    it('a second delete of the same day appends nothing and notifies nothing', async () => {
      await typeAt(inEarly)
      await deleteTypingDailySummaries(keyboard.uid, ['2026-04-14'])
      const rowsAfterFirst = await dayRows('2026-04-13')
      const notifier = vi.fn()
      setTypingAnalyticsSyncNotifier(notifier)

      const result = await deleteTypingDailySummaries(keyboard.uid, ['2026-04-14'])

      expect(result).toEqual({ charMinutes: 0, matrixMinutes: 0, minuteStats: 0, bigramMinutes: 0, trigramMinutes: 0, sessions: 0 })
      expect(await dayRows('2026-04-13')).toEqual(rowsAfterFirst)
      expect(notifier).not.toHaveBeenCalled()
    })

    it('marks written sessions by their start, closes and drops the active one, keeps one started before the day', async () => {
      const dayStart = Date.UTC(2026, 3, 13, 15, 0)
      const s1 = dayStart - 2 * MINUTE // starts on local 04-13, runs into 04-14
      const s3 = dayStart + 60 * MINUTE
      const s4 = dayStart + 120 * MINUTE
      // s1 + its next key, then idle gaps close s1 and s3; s4 stays active.
      await typeAt(s1, dayStart + MINUTE, s3, s4)
      expect(liveSessionStarts()).toEqual([s1, s3])

      const result = await deleteTypingDailySummaries(keyboard.uid, ['2026-04-14'])
      expect(result.sessions).toBe(1)
      // The flush IPC closes active sessions; s4 is already closed and dropped.
      await getHandler(IpcChannels.TYPING_ANALYTICS_FLUSH)({}, keyboard.uid)

      expect(liveSessionStarts()).toEqual([s1])
      const sessionRows = (await dayRows('2026-04-13')).filter((r) => r.kind === 'session')
      expect(sessionRows.map((r) => [r.kind === 'session' ? r.payload.startMs : 0, r.is_deleted ?? false])).toEqual([
        [s1, false], [s3, false], [s3, true],
      ])
    })

    it('keeps what is typed after the cutoff in the deleted day', async () => {
      await typeAt(inEarly)
      const cutoffMs = inEarly + 10 * MINUTE
      await typeAt(inEarly + 20 * MINUTE)

      await deleteTypingDailySummaries(keyboard.uid, ['2026-04-14'], cutoffMs)

      expect(liveCacheMinutes()).toEqual([inEarly + 20 * MINUTE])
    })
  })

  describe('in America/Bogota (UTC-5)', () => {
    beforeEach(() => { process.env.TZ = 'America/Bogota' })

    it('marks the rows of the local day in both overlapping UTC files', async () => {
      // Local 2026-01-10 is [2026-01-10 05:00Z, 2026-01-11 05:00Z).
      const morning = Date.UTC(2026, 0, 10, 11, 0) // local 01-10 06:00, UTC file 01-10
      const evening = Date.UTC(2026, 0, 11, 3, 0) // local 01-10 22:00, UTC file 01-11
      const nextDay = Date.UTC(2026, 0, 11, 6, 0) // local 01-11 01:00, UTC file 01-11
      const dayBefore = Date.UTC(2026, 0, 10, 4, 0) // local 01-09 23:00, UTC file 01-10
      await typeAt(dayBefore, morning, evening, nextDay)

      await deleteTypingDailySummaries(keyboard.uid, ['2026-01-10'])

      expect(await statsMinutes('2026-01-10')).toEqual({ live: [dayBefore, morning], deleted: [morning] })
      expect(await statsMinutes('2026-01-11')).toEqual({ live: [evening, nextDay], deleted: [evening] })
      expect(listTypingDailySummaries(keyboard.uid).map((s) => s.date).sort()).toEqual(['2026-01-09', '2026-01-11'])
    })
  })

  describe('in America/New_York on the day summer time starts', () => {
    beforeEach(() => { process.env.TZ = 'America/New_York' })

    it('uses the 23-hour local day', async () => {
      // Local 2026-03-08 is [2026-03-08 05:00Z, 2026-03-09 04:00Z).
      const lastBefore = Date.UTC(2026, 2, 8, 4, 30) // local 03-07 23:30 EST
      const firstIn = Date.UTC(2026, 2, 8, 5, 30) // local 03-08 00:30 EST
      const lastIn = Date.UTC(2026, 2, 9, 3, 30) // local 03-08 23:30 EDT
      const firstAfter = Date.UTC(2026, 2, 9, 4, 30) // local 03-09 00:30 EDT
      await typeAt(lastBefore, firstIn, lastIn, firstAfter)

      await deleteTypingDailySummaries(keyboard.uid, ['2026-03-08'])

      expect(await statsMinutes('2026-03-08')).toEqual({ live: [lastBefore, firstIn], deleted: [firstIn] })
      expect(await statsMinutes('2026-03-09')).toEqual({ live: [lastIn, firstAfter], deleted: [lastIn] })
      expect(liveCacheMinutes()).toEqual([lastBefore, firstAfter])
    })
  })

  describe('delete all of the Local tab', () => {
    it('removes this device\'s files and rows and keeps the other devices\' rows', async () => {
      const ts = Date.UTC(2026, 3, 14, 10, 0)
      await typeAt(ts)
      const db = getTypingAnalyticsDB()
      applyRowsToCache(db, [
        {
          id: 'scope|remote', kind: 'scope', updated_at: 1,
          payload: {
            id: 'remote-scope', machineHash: 'other-machine', osPlatform: 'linux', osRelease: '6', osArch: 'x64',
            keyboardUid: keyboard.uid, keyboardVendorId: keyboard.vendorId, keyboardProductId: keyboard.productId,
            keyboardProductName: keyboard.productName,
          },
        },
        {
          id: 'stats|remote', kind: 'minute-stats', updated_at: 1,
          payload: {
            scopeId: 'remote-scope', minuteTs: ts, keystrokes: 4, activeMs: 100, intervalAvgMs: null, intervalMinMs: null,
            intervalP25Ms: null, intervalP50Ms: null, intervalP75Ms: null, intervalMaxMs: null,
          },
        },
      ])

      await deleteAllTypingForKeyboard(keyboard.uid, Date.now(), 'own')

      expect(existsSync(deviceDayJsonlPath(mockUserDataPath, keyboard.uid, await getMachineHash(), '2026-04-14'))).toBe(false)
      expect(listTypingDailySummaries(keyboard.uid)).toEqual([expect.objectContaining({ keystrokes: 4 })])
    })
  })
})

describe('collectRowsToMark', () => {
  const stats = (minuteTs: number, updatedAt: number, isDeleted?: boolean): JsonlRow => ({
    id: `stats|s|${minuteTs}|`, kind: 'minute-stats', updated_at: updatedAt, ...(isDeleted ? { is_deleted: true } : {}),
    payload: {
      scopeId: 's', minuteTs, keystrokes: 1, activeMs: 1, intervalAvgMs: null, intervalMinMs: null,
      intervalP25Ms: null, intervalP50Ms: null, intervalP75Ms: null, intervalMaxMs: null,
    },
  })
  const all = (): boolean => true

  it('keeps the copy the replay keeps and skips ids already deleted', () => {
    const found = collectRowsToMark([stats(0, 1), stats(0, 3), stats(0, 2), stats(MINUTE, 1), stats(MINUTE, 2, true)], all)
    expect(found.rows).toEqual([stats(0, 3)])
    expect(found.newestUpdatedAt).toBe(3)
  })

  it('marks each cache row when rows of different runs share one id', () => {
    const run = (runId: string): JsonlRow => {
      const row = stats(0, 1)
      if (row.kind !== 'minute-stats') throw new Error('not a stats row')
      return { ...row, payload: { ...row.payload, runId } }
    }
    const found = collectRowsToMark([run(''), run('run-1')], all)
    expect(found.rows).toEqual([run(''), run('run-1')])
  })

  it('leaves scope rows and rows outside the ranges alone', () => {
    const scope = parseRow(JSON.stringify({
      id: 'scope|s', kind: 'scope', updated_at: 9,
      payload: { id: 's', machineHash: 'h', osPlatform: 'p', osRelease: 'r', osArch: 'a', keyboardUid: 'u', keyboardVendorId: 1, keyboardProductId: 2, keyboardProductName: 'n' },
    }))
    if (!scope) throw new Error('scope row did not parse')
    const found = collectRowsToMark([scope, stats(0, 1), stats(MINUTE, 1)], (ms) => ms < MINUTE)
    expect(found.rows).toEqual([stats(0, 1)])
    expect(found.newestUpdatedAt).toBe(1)
  })

  it('marks every pair an n-gram minute ever held', () => {
    const bigram = (updatedAt: number, pairs: string[]): JsonlRow => ({
      id: 'bigram|s|0|', kind: 'bigram-minute', updated_at: updatedAt,
      payload: { scopeId: 's', minuteTs: 0, bigrams: Object.fromEntries(pairs.map((p) => [p, { c: 1, h: [1, 0, 0, 0, 0, 0, 0, 0] }])) },
    })
    const found = collectRowsToMark([bigram(1, ['4_5']), bigram(2, ['5_6'])], all)
    expect(found.rows).toHaveLength(1)
    const row = found.rows[0]
    expect(row.kind === 'bigram-minute' ? Object.keys(row.payload.bigrams).sort() : []).toEqual(['4_5', '5_6'])
  })
})

describe('collectRowsToMark with n-gram copies', () => {
  const bigram = (updatedAt: number, pairs: string[], isDeleted?: boolean): JsonlRow => ({
    id: 'bigram|s|0|', kind: 'bigram-minute', updated_at: updatedAt, ...(isDeleted ? { is_deleted: true } : {}),
    payload: { scopeId: 's', minuteTs: 0, bigrams: Object.fromEntries(pairs.map((p) => [p, { c: 1, h: [1, 0, 0, 0, 0, 0, 0, 0] }])) },
  })
  const pairsOf = (rows: JsonlRow[]): string[] =>
    rows.flatMap((r) => (r.kind === 'bigram-minute' ? Object.keys(r.payload.bigrams) : [])).sort()

  it('marks a pair whose newest copy is live even when the newest row of the minute is deleted', () => {
    const found = collectRowsToMark([bigram(100, ['A', 'B']), bigram(200, ['A'], true)], () => true)
    expect(pairsOf(found.rows)).toEqual(['B'])
    expect(found.rows.every((r) => r.is_deleted !== true)).toBe(true)
  })

  it('marks nothing when every pair\'s newest copy is deleted', () => {
    const found = collectRowsToMark([bigram(100, ['A', 'B']), bigram(200, ['A', 'B'], true)], () => true)
    expect(found.rows).toEqual([])
  })

  it('keeps the first copy on an updated_at tie', () => {
    expect(pairsOf(collectRowsToMark([bigram(100, ['A']), bigram(100, ['A'], true)], () => true).rows)).toEqual(['A'])
    expect(collectRowsToMark([bigram(100, ['A'], true), bigram(100, ['A'])], () => true).rows).toEqual([])
  })
})

describe('utcDaysOverlapping', () => {
  it('lists every UTC day a range touches, end exclusive', () => {
    expect(utcDaysOverlapping([{ startMs: Date.UTC(2026, 3, 13, 15), endMs: Date.UTC(2026, 3, 14, 15) }])).toEqual(['2026-04-13', '2026-04-14'])
    expect(utcDaysOverlapping([{ startMs: Date.UTC(2026, 3, 14), endMs: Date.UTC(2026, 3, 15) }])).toEqual(['2026-04-14'])
  })
})
