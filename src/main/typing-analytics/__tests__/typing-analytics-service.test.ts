// SPDX-License-Identifier: GPL-2.0-or-later

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

// app-config pulls in electron-store which needs `projectName` at
// import time. We never read the config in this suite (the analytics
// pipeline only consults it via getCurrentAppName, mocked below), so a
// minimal stub keeps the module load side-effect-free.
vi.mock('../../app-config', () => ({
  loadAppConfig: () => ({ typingMonitorAppEnabled: false }),
}))

// app-monitor would otherwise spawn the gdbus fallback for every flush
// and slow the suite. With Monitor App stubbed off via the app-config
// mock above this would already short-circuit, but pinning to null is
// clearer and isolates these tests from the platform.
vi.mock('../app-monitor', () => ({
  getCurrentAppName: vi.fn(async () => null),
}))

const mockMachineId = vi.fn<(original?: boolean) => Promise<string>>()

vi.mock('node-machine-id', () => ({
  default: { machineId: (original?: boolean) => mockMachineId(original) },
  machineId: (original?: boolean) => mockMachineId(original),
}))

import { existsSync } from 'node:fs'
import { ipcMain } from 'electron'
import {
  setupTypingAnalytics,
  setupTypingAnalyticsIpc,
  resetTypingAnalyticsForTests,
  getMinuteBufferForTests,
  flushTypingAnalyticsNowForTests,
  hasTypingAnalyticsPendingWork,
  flushTypingAnalyticsBeforeQuit,
  setTypingAnalyticsSyncNotifier,
  listTypingKeyboards,
  listTypingDailySummaries,
  deleteTypingDailySummaries,
  deleteAllTypingForKeyboard,
  getMatrixHeatmap,
} from '../typing-analytics-service'
import {
  deviceDayDir,
  deviceDayJsonlPath,
  listDeviceDays,
  readPointerKey,
} from '../jsonl/paths'
import { readRows } from '../jsonl/jsonl-reader'
import type { JsonlRow } from '../jsonl/jsonl-row'
import * as installationIdModule from '../installation-id'
import { getMachineHash, resetMachineHashCacheForTests } from '../machine-hash'
import {
  getTypingAnalyticsDB,
  resetTypingAnalyticsDBForTests,
} from '../db/typing-analytics-db'
import { IpcChannels } from '../../../shared/ipc/channels'

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>

function getHandler(channel: string): IpcHandler {
  const calls = vi.mocked(ipcMain.handle).mock.calls
  const match = calls.find(([ch]) => ch === channel)
  if (!match) throw new Error(`No handler registered for ${channel}`)
  return match[1] as IpcHandler
}

const fakeEvent = {} as Electron.IpcMainInvokeEvent

const sampleKeyboard = {
  uid: '0xAABB',
  vendorId: 0xFEED,
  productId: 0x0000,
  productName: 'Pipette Keyboard',
}

type CharRow = { scope_id: string; char: string; count: number; minute_ts: number }
type MatrixRow = { scope_id: string; row: number; col: number; layer: number; keycode: number; count: number }
type StatsRow = { scope_id: string; minute_ts: number; keystrokes: number; active_ms: number }
type SessionRow = { id: string; scope_id: string; start_ms: number; end_ms: number }
type ScopeRow = { id: string; keyboard_uid: string }

describe('typing-analytics-service', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'pipette-typing-analytics-service-test-'))
    resetTypingAnalyticsForTests()
    resetTypingAnalyticsDBForTests()
    installationIdModule.resetInstallationIdCacheForTests()
    resetMachineHashCacheForTests()
    mockMachineId.mockReset()
    mockMachineId.mockResolvedValue('fixed-machine-id')
  })

  afterEach(async () => {
    resetTypingAnalyticsDBForTests()
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  describe('setupTypingAnalytics', () => {
    it('shares a single in-flight initialization across concurrent callers', async () => {
      const spy = vi.spyOn(installationIdModule, 'getInstallationId')
      await Promise.all([setupTypingAnalytics(), setupTypingAnalytics(), setupTypingAnalytics()])
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('reuses the completed initialization on subsequent calls', async () => {
      const spy = vi.spyOn(installationIdModule, 'getInstallationId')
      await setupTypingAnalytics()
      await setupTypingAnalytics()
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('allows retry after an initialization failure', async () => {
      const spy = vi
        .spyOn(installationIdModule, 'getInstallationId')
        .mockRejectedValueOnce(new Error('boom'))

      await expect(setupTypingAnalytics()).rejects.toThrow('boom')

      spy.mockResolvedValueOnce('11111111-2222-3333-4444-555555555555')
      await expect(setupTypingAnalytics()).resolves.toBeUndefined()
      expect(spy).toHaveBeenCalledTimes(2)
    })

    it('does not leave unhandled rejections when called as fire-and-forget', async () => {
      vi
        .spyOn(installationIdModule, 'getInstallationId')
        .mockRejectedValueOnce(new Error('boom'))

      const handler = vi.fn()
      process.on('unhandledRejection', handler)
      try {
        setupTypingAnalytics().catch(() => {
          // Simulates the main-process `.catch(...)` wrapper that logs the failure.
        })
        await new Promise((resolve) => setImmediate(resolve))
      } finally {
        process.off('unhandledRejection', handler)
      }
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('setupTypingAnalyticsIpc', () => {
    it('registers the event handler exactly once', () => {
      setupTypingAnalyticsIpc()
      setupTypingAnalyticsIpc()
      const registered = vi.mocked(ipcMain.handle).mock.calls
        .filter(([ch]) => ch === IpcChannels.TYPING_ANALYTICS_EVENT)
      expect(registered).toHaveLength(1)
    })

    it('aggregates char events into a minute bucket', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      await handler(fakeEvent, { kind: 'char', key: 'a', ts: 1_000, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'char', key: 'a', ts: 1_001, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'char', key: 'b', ts: 1_002, keyboard: sampleKeyboard })

      // Live minute buffer holds exactly one entry for minute 0.
      expect(getMinuteBufferForTests().isEmpty()).toBe(false)
    })

    it('persists per-minute char counts to SQLite on flush', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      const ts = Date.UTC(2026, 3, 14, 10, 0, 0)
      await handler(fakeEvent, { kind: 'char', key: 'a', ts, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'char', key: 'a', ts: ts + 100, keyboard: sampleKeyboard })
      await handler(fakeEvent, {
        kind: 'matrix', row: 0, col: 3, layer: 0, keycode: 0x04, ts: ts + 200, keyboard: sampleKeyboard,
      })

      await flushTypingAnalyticsNowForTests()

      const conn = getTypingAnalyticsDB().getConnection()
      const chars = conn.prepare('SELECT scope_id, char, count, minute_ts FROM typing_char_minute ORDER BY char').all() as CharRow[]
      expect(chars).toHaveLength(1)
      expect(chars[0].char).toBe('a')
      expect(chars[0].count).toBe(2)

      const matrices = conn.prepare('SELECT scope_id, row, col, layer, keycode, count FROM typing_matrix_minute').all() as MatrixRow[]
      expect(matrices).toHaveLength(1)
      expect(matrices[0]).toMatchObject({ row: 0, col: 3, layer: 0, keycode: 0x04, count: 1 })

      const stats = conn.prepare('SELECT scope_id, minute_ts, keystrokes, active_ms FROM typing_minute_stats').all() as StatsRow[]
      expect(stats).toHaveLength(1)
      expect(stats[0].keystrokes).toBe(3)

      expect(getMinuteBufferForTests().isEmpty()).toBe(true)
    })

    it('emits bigram-minute rows when consecutive matrix events flush', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      const ts = Date.UTC(2026, 3, 14, 10, 0, 0)
      // Three matrix events in the same minute → two bigrams (a→h, h→d).
      await handler(fakeEvent, { kind: 'matrix', row: 0, col: 0, layer: 0, keycode: 0x04, ts, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'matrix', row: 0, col: 1, layer: 0, keycode: 0x0B, ts: ts + 120, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'matrix', row: 0, col: 2, layer: 0, keycode: 0x07, ts: ts + 280, keyboard: sampleKeyboard })

      await flushTypingAnalyticsNowForTests()

      const conn = getTypingAnalyticsDB().getConnection()
      const rows = conn
        .prepare('SELECT bigram_id, count FROM typing_bigram_minute ORDER BY bigram_id')
        .all() as { bigram_id: string; count: number }[]
      expect(rows).toEqual([
        { bigram_id: '11_7', count: 1 },
        { bigram_id: '4_11', count: 1 },
      ])
    })

    it('does not emit a bigram-minute row when only char events flush', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      const ts = Date.UTC(2026, 3, 14, 10, 0, 0)
      await handler(fakeEvent, { kind: 'char', key: 'a', ts, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'char', key: 'b', ts: ts + 100, keyboard: sampleKeyboard })

      await flushTypingAnalyticsNowForTests()

      const conn = getTypingAnalyticsDB().getConnection()
      const count = conn.prepare('SELECT COUNT(*) AS n FROM typing_bigram_minute').get() as { n: number }
      expect(count.n).toBe(0)
    })

    it('inserts a session row when the flush IPC closes the session', async () => {
      setupTypingAnalyticsIpc()
      const eventHandler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const flushHandler = getHandler(IpcChannels.TYPING_ANALYTICS_FLUSH)

      const start = Date.UTC(2026, 3, 14, 10, 0, 0)
      const end = Date.UTC(2026, 3, 14, 10, 0, 5)
      await eventHandler(fakeEvent, { kind: 'char', key: 'a', ts: start, keyboard: sampleKeyboard })
      await eventHandler(fakeEvent, { kind: 'char', key: 'b', ts: end, keyboard: sampleKeyboard })

      await flushHandler(fakeEvent, sampleKeyboard.uid)

      const conn = getTypingAnalyticsDB().getConnection()
      const sessions = conn.prepare('SELECT id, scope_id, start_ms, end_ms FROM typing_sessions').all() as SessionRow[]
      expect(sessions).toHaveLength(1)
      expect(sessions[0].start_ms).toBe(start)
      expect(sessions[0].end_ms).toBe(end)
    })

    it('routes events from different keyboards to separate scope rows', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const otherKeyboard = { ...sampleKeyboard, uid: '0xCCDD', vendorId: 0x1234 }

      await handler(fakeEvent, { kind: 'char', key: 'a', ts: 1_000, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'char', key: 'a', ts: 1_000, keyboard: otherKeyboard })

      await flushTypingAnalyticsNowForTests()

      const conn = getTypingAnalyticsDB().getConnection()
      const scopes = conn.prepare('SELECT id, keyboard_uid FROM typing_scopes ORDER BY keyboard_uid').all() as ScopeRow[]
      expect(scopes.map((s) => s.keyboard_uid)).toEqual(['0xAABB', '0xCCDD'])
    })

    it('reports pending work while only an active session exists', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      await handler(fakeEvent, { kind: 'char', key: 'a', ts: 1_000, keyboard: sampleKeyboard })
      await flushTypingAnalyticsNowForTests()

      // After a successful flush the buffer and queued sessions are empty,
      // but the active session is still open and must be picked up by the
      // before-quit finalizer.
      expect(getMinuteBufferForTests().isEmpty()).toBe(true)
      expect(hasTypingAnalyticsPendingWork()).toBe(true)
    })

    it('persists the active session via flushTypingAnalyticsBeforeQuit', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
      await handler(fakeEvent, { kind: 'char', key: 'a', ts, keyboard: sampleKeyboard })
      await flushTypingAnalyticsNowForTests()
      await flushTypingAnalyticsBeforeQuit()

      const conn = getTypingAnalyticsDB().getConnection()
      const sessions = conn.prepare('SELECT start_ms, end_ms FROM typing_sessions').all() as Array<{ start_ms: number; end_ms: number }>
      expect(sessions).toHaveLength(1)
      expect(sessions[0].start_ms).toBe(ts)
      expect(hasTypingAnalyticsPendingWork()).toBe(false)
    })

    it('reports pending work while a flush is mid-write so before-quit waits', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      await handler(fakeEvent, { kind: 'char', key: 'a', ts: 1_000, keyboard: sampleKeyboard })

      // Kick off a flush but don't await — the chain holds the in-flight pass.
      const inflight = flushTypingAnalyticsNowForTests()

      // While the flush is mid-write the live state is already cleared by
      // the snapshot, but the in-flight counter must still surface as work.
      expect(hasTypingAnalyticsPendingWork()).toBe(true)

      await inflight
      // After the flush settles the still-open active session keeps the
      // pending flag true, exercising the post-snapshot path.
      expect(hasTypingAnalyticsPendingWork()).toBe(true)
    })

    it('serializes concurrent flush callers so quit waits for the in-flight pass', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      await handler(fakeEvent, { kind: 'char', key: 'a', ts: 1_000, keyboard: sampleKeyboard })

      const a = flushTypingAnalyticsNowForTests()
      const b = flushTypingAnalyticsNowForTests()
      await Promise.all([a, b])

      const conn = getTypingAnalyticsDB().getConnection()
      const stats = conn.prepare('SELECT COUNT(*) as n FROM typing_minute_stats').get() as { n: number }
      expect(stats.n).toBe(1)
    })

    it('notifies the sync layer per touched keyboard after a successful commit', async () => {
      const notifier = vi.fn()
      setTypingAnalyticsSyncNotifier(notifier)
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const otherKeyboard = { ...sampleKeyboard, uid: '0xCCDD', vendorId: 0x1234 }

      await handler(fakeEvent, { kind: 'char', key: 'a', ts: 1_000, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'char', key: 'a', ts: 1_000, keyboard: otherKeyboard })
      await flushTypingAnalyticsNowForTests()

      const machineHash = await getMachineHash()
      const units = notifier.mock.calls.map((c) => c[0]).sort()
      // ts=1000 falls in UTC day 1970-01-01; one notify per
      // (uid, hash, day) triple.
      expect(units).toEqual([
        `keyboards/${sampleKeyboard.uid}/devices/${machineHash}/days/1970-01-01`,
        `keyboards/${otherKeyboard.uid}/devices/${machineHash}/days/1970-01-01`,
      ])
    })

    it('suppresses notification when the DB transaction fails', async () => {
      const notifier = vi.fn()
      setTypingAnalyticsSyncNotifier(notifier)
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      await handler(fakeEvent, { kind: 'char', key: 'a', ts: 1_000, keyboard: sampleKeyboard })
      // Force the open DB into a bad state so the transaction throws.
      getTypingAnalyticsDB().close()
      await flushTypingAnalyticsNowForTests()

      expect(notifier).not.toHaveBeenCalled()
      resetTypingAnalyticsDBForTests()
    })

    describe('data modal API', () => {
      async function seedKeyboardData(keyboard: typeof sampleKeyboard, ts: number, key = 'a'): Promise<void> {
        setupTypingAnalyticsIpc()
        const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
        await handler(fakeEvent, { kind: 'char', key, ts, keyboard })
        await flushTypingAnalyticsNowForTests()
      }

      it('listTypingKeyboards returns keyboards with live data after a flush', async () => {
        const otherKeyboard = { ...sampleKeyboard, uid: '0xCCDD' }
        await seedKeyboardData(sampleKeyboard, Date.UTC(2026, 3, 14, 10, 0, 0))
        await seedKeyboardData(otherKeyboard, Date.UTC(2026, 3, 14, 11, 0, 0), 'b')

        const keyboards = listTypingKeyboards().map((k) => k.uid).sort()
        expect(keyboards).toEqual(['0xAABB', '0xCCDD'])
      })

      it('listTypingDailySummaries returns day-aggregated counts for a uid', async () => {
        // Two events, same local day, different minutes.
        const day = new Date(2026, 3, 14, 12, 0, 0).getTime()
        await seedKeyboardData(sampleKeyboard, day)
        await seedKeyboardData(sampleKeyboard, day + 5 * 60_000, 'b')

        const summaries = listTypingDailySummaries(sampleKeyboard.uid)
        expect(summaries).toHaveLength(1)
        expect(summaries[0].keystrokes).toBe(2)
      })

      it('deleteTypingDailySummaries tombstones matching rows and notifies sync', async () => {
        const notifier = vi.fn()
        setTypingAnalyticsSyncNotifier(notifier)
        const d = new Date(2026, 3, 14, 12, 0, 0)
        await seedKeyboardData(sampleKeyboard, d.getTime())

        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        const result = await deleteTypingDailySummaries(sampleKeyboard.uid, [date])

        expect(result.minuteStats).toBeGreaterThan(0)
        expect(listTypingDailySummaries(sampleKeyboard.uid)).toEqual([])
        const machineHash = await getMachineHash()
        expect(notifier).toHaveBeenCalledWith(`keyboards/${sampleKeyboard.uid}/devices/${machineHash}`)
      })

      it('deleteAllTypingForKeyboard wipes every live row for the uid', async () => {
        const notifier = vi.fn()
        setTypingAnalyticsSyncNotifier(notifier)
        await seedKeyboardData(sampleKeyboard, Date.UTC(2026, 3, 10, 12, 0, 0))
        await seedKeyboardData(sampleKeyboard, Date.UTC(2026, 3, 14, 12, 0, 0), 'b')

        const result = await deleteAllTypingForKeyboard(sampleKeyboard.uid)
        expect(result.charMinutes).toBeGreaterThan(0)
        expect(listTypingKeyboards().map((k) => k.uid)).not.toContain(sampleKeyboard.uid)
        const machineHash = await getMachineHash()
        expect(notifier).toHaveBeenCalledWith(`keyboards/${sampleKeyboard.uid}/devices/${machineHash}`)
      })

      it('deleteTypingDailySummaries is a no-op when the dates array is empty', async () => {
        const notifier = vi.fn()
        setTypingAnalyticsSyncNotifier(notifier)
        await seedKeyboardData(sampleKeyboard, Date.UTC(2026, 3, 14, 12, 0, 0))
        notifier.mockClear() // forget the seed's own flush notification

        const result = await deleteTypingDailySummaries(sampleKeyboard.uid, [])
        expect(result).toEqual({ charMinutes: 0, matrixMinutes: 0, minuteStats: 0, sessions: 0 })
        expect(notifier).not.toHaveBeenCalled()
        expect(listTypingDailySummaries(sampleKeyboard.uid)).toHaveLength(1)
      })

      describe('getMatrixHeatmap', () => {
        async function ingestMatrix(
          keyboard: typeof sampleKeyboard,
          row: number,
          col: number,
          layer: number,
          ts: number,
        ): Promise<void> {
          setupTypingAnalyticsIpc()
          const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
          await handler(fakeEvent, { kind: 'matrix', row, col, layer, keycode: 0x04, ts, keyboard })
        }

        it('combines flushed DB rows with the live in-memory current minute', async () => {
          const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
          // One press lands in the DB via the flush.
          await ingestMatrix(sampleKeyboard, 1, 2, 0, ts)
          await flushTypingAnalyticsNowForTests()
          // Second press stays in the buffer (not flushed), so only
          // the peekMatrixCountsForUid path can see it.
          await ingestMatrix(sampleKeyboard, 1, 2, 0, ts + 500)

          const heat = await getMatrixHeatmap(sampleKeyboard.uid, 0, ts - 60_000)
          expect(heat['1,2']?.total).toBe(2)
        })

        it('floors sinceMs to the minute boundary so partial minutes are not dropped', async () => {
          const floored = Date.UTC(2026, 3, 14, 12, 0, 0) // minute start
          // Press at the very start of that minute must be included even
          // when sinceMs is mid-minute.
          await ingestMatrix(sampleKeyboard, 3, 4, 0, floored)
          await flushTypingAnalyticsNowForTests()

          const heat = await getMatrixHeatmap(sampleKeyboard.uid, 0, floored + 30_000)
          expect(heat['3,4']?.total).toBe(1)
        })

        it('excludes other layers', async () => {
          const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
          await ingestMatrix(sampleKeyboard, 1, 2, 0, ts)
          await ingestMatrix(sampleKeyboard, 1, 2, 1, ts + 100)
          await flushTypingAnalyticsNowForTests()

          const heat = await getMatrixHeatmap(sampleKeyboard.uid, 0, ts - 60_000)
          expect(heat['1,2']?.total).toBe(1)
        })

        it('returns an empty object when no matrix events fall in the window', async () => {
          const heat = await getMatrixHeatmap(sampleKeyboard.uid, 0, Date.now() - 3600_000)
          expect(heat).toEqual({})
        })
      })
    })

    describe('getBigramAggregateForRange', () => {
      async function ingestThree(ts: number): Promise<void> {
        setupTypingAnalyticsIpc()
        const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
        // Three matrix events → two bigrams (4→11 and 11→7).
        await handler(fakeEvent, { kind: 'matrix', row: 0, col: 0, layer: 0, keycode: 0x04, ts, keyboard: sampleKeyboard })
        await handler(fakeEvent, { kind: 'matrix', row: 0, col: 1, layer: 0, keycode: 0x0B, ts: ts + 80, keyboard: sampleKeyboard })
        await handler(fakeEvent, { kind: 'matrix', row: 0, col: 2, layer: 0, keycode: 0x07, ts: ts + 280, keyboard: sampleKeyboard })
        await flushTypingAnalyticsNowForTests()
      }

      it('returns top-ranked entries for view=top with all-scope', async () => {
        const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
        await ingestThree(ts)
        const handler = getHandler(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        const result = await handler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'top', 'all', undefined)
        expect(result.view).toBe('top')
        expect(result.entries.map((e: { bigramId: string }) => e.bigramId).sort()).toEqual(['11_7', '4_11'])
        expect(result.entries.every((e: { count: number }) => e.count === 1)).toBe(true)
      })

      it('returns slow entries with p95 for view=slow', async () => {
        const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
        await ingestThree(ts)
        const handler = getHandler(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        // minSampleCount: 1 — both pairs are single-sample so they're kept.
        const result = await handler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'slow', 'all', { minSampleCount: 1 })
        expect(result.view).toBe('slow')
        expect(result.entries).toHaveLength(2)
        expect(typeof result.entries[0].p95).toBe('number')
      })

      it('drops entries below minSampleCount on view=slow', async () => {
        const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
        await ingestThree(ts)
        const handler = getHandler(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        // Default minSample = 5 — none of the single-sample pairs qualify.
        const result = await handler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'slow', 'all', undefined)
        expect(result.view).toBe('slow')
        expect(result.entries).toEqual([])
      })

      it('returns an empty top result for an unknown view', async () => {
        setupTypingAnalyticsIpc()
        const handler = getHandler(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        const result = await handler(fakeEvent, sampleKeyboard.uid, 0, 60_000, 'unknown', 'all', undefined)
        expect(result).toEqual({ view: 'top', entries: [] })
      })

      it('returns an empty result when sinceMs >= untilMs', async () => {
        setupTypingAnalyticsIpc()
        const handler = getHandler(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        const result = await handler(fakeEvent, sampleKeyboard.uid, 60_000, 60_000, 'top', 'all', undefined)
        expect(result).toEqual({ view: 'top', entries: [] })
      })

      it('returns an empty result when uid is invalid', async () => {
        setupTypingAnalyticsIpc()
        const handler = getHandler(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        const result = await handler(fakeEvent, '', 0, 60_000, 'top', 'all', undefined)
        expect(result).toEqual({ view: 'top', entries: [] })
      })

      it('honours scope=own by filtering to the local machine_hash', async () => {
        const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
        await ingestThree(ts)
        const handler = getHandler(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        const result = await handler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'top', 'own', undefined)
        expect(result.view).toBe('top')
        // The own machineHash is the only one in test data — same as 'all'.
        expect(result.entries).toHaveLength(2)
      })
    })

    it('silently drops malformed payloads', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      await handler(fakeEvent, null)
      await handler(fakeEvent, 'not-an-object')
      await handler(fakeEvent, { kind: 'char', ts: 1_000, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'char', key: 'a', keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'matrix', row: 0, col: 0, layer: 0, keycode: 1, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'unknown', key: 'a', ts: 1_000, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'matrix', row: -1, col: 0, layer: 0, keycode: 1, ts: 1_000, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'char', key: 'a', ts: 1_000 })
      await handler(fakeEvent, { kind: 'char', key: 'a', ts: 1_000, keyboard: { uid: '', vendorId: 0, productId: 0, productName: '' } })

      expect(getMinuteBufferForTests().isEmpty()).toBe(true)
    })
  })

  describe('v7 per-day JSONL output', () => {
    async function readDayRows(uid: string, machineHash: string, utcDay: string): Promise<JsonlRow[]> {
      const path = deviceDayJsonlPath(mockUserDataPath, uid, machineHash, utcDay)
      const { rows } = await readRows(path)
      return rows
    }
    const charsOnDay = (rows: JsonlRow[]): string[] =>
      rows.flatMap((r) => (r.kind === 'char-minute' ? [r.payload.char] : []))

    it('writes each flush to {hash}/{utcDay}.jsonl and no longer mirrors the v6 flat path', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const ts = Date.UTC(2026, 3, 14, 10, 0, 0)
      await handler(fakeEvent, { kind: 'char', key: 'a', ts, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'char', key: 'a', ts: ts + 100, keyboard: sampleKeyboard })
      await flushTypingAnalyticsNowForTests()

      const hash = await getMachineHash()
      const dayPath = deviceDayJsonlPath(mockUserDataPath, sampleKeyboard.uid, hash, '2026-04-14')
      expect(existsSync(dayPath)).toBe(true)

      // Mirror write is dropped — flat `{hash}.jsonl` only exists
      // for legacy v6 imports, never from a fresh v7 flush.
      const legacyPath = join(deviceDayDir(mockUserDataPath, sampleKeyboard.uid, hash), '..', `${hash}.jsonl`)
      expect(existsSync(legacyPath)).toBe(false)

      const rows = await readDayRows(sampleKeyboard.uid, hash, '2026-04-14')
      expect(rows.some((r) => r.kind === 'scope')).toBe(true)
      expect(rows.some((r) => r.kind === 'char-minute')).toBe(true)
      expect(rows.some((r) => r.kind === 'minute-stats')).toBe(true)
    })

    it('does not populate sync_state.uploaded at flush time (cloud confirmation required)', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const dayOne = Date.UTC(2026, 3, 14, 10, 0, 0)
      const dayTwo = Date.UTC(2026, 3, 15, 10, 0, 0)
      await handler(fakeEvent, { kind: 'char', key: 'a', ts: dayOne, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'char', key: 'b', ts: dayTwo, keyboard: sampleKeyboard })
      await flushTypingAnalyticsNowForTests()

      const hash = await getMachineHash()
      const { loadSyncState } = await import('../sync-state')
      const state = await loadSyncState(mockUserDataPath)
      // `uploaded` tracks cloud-confirmed days and is bumped by the
      // sync layer after uploadSyncUnit succeeds — flush alone leaves
      // it untouched so reconcile can still distinguish "never
      // uploaded" from "uploaded then remotely deleted".
      expect(state?.uploaded[readPointerKey(sampleKeyboard.uid, hash)]).toBeUndefined()
    })

    it('partitions a flush that spans 00:00 UTC into two day files', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      const eveningMinute = Date.UTC(2026, 3, 14, 23, 30, 0)
      const morningMinute = Date.UTC(2026, 3, 15, 0, 30, 0)
      await handler(fakeEvent, { kind: 'char', key: 'x', ts: eveningMinute, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'char', key: 'y', ts: morningMinute, keyboard: sampleKeyboard })
      await flushTypingAnalyticsNowForTests()

      const hash = await getMachineHash()
      const days = await listDeviceDays(mockUserDataPath, sampleKeyboard.uid, hash)
      expect(days).toEqual(['2026-04-14', '2026-04-15'])

      const eveningRows = await readDayRows(sampleKeyboard.uid, hash, '2026-04-14')
      const morningRows = await readDayRows(sampleKeyboard.uid, hash, '2026-04-15')
      expect(charsOnDay(eveningRows)).toEqual(['x'])
      expect(charsOnDay(morningRows)).toEqual(['y'])
      expect(eveningRows.some((r) => r.kind === 'scope')).toBe(true)
      expect(morningRows.some((r) => r.kind === 'scope')).toBe(true)
    })

    it('pins a session row to its startMs UTC day even when endMs crosses midnight', async () => {
      setupTypingAnalyticsIpc()
      const eventHandler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const flushHandler = getHandler(IpcChannels.TYPING_ANALYTICS_FLUSH)

      const start = Date.UTC(2026, 3, 14, 23, 59, 50)
      const end = Date.UTC(2026, 3, 15, 0, 0, 5)
      await eventHandler(fakeEvent, { kind: 'char', key: 'a', ts: start, keyboard: sampleKeyboard })
      await eventHandler(fakeEvent, { kind: 'char', key: 'b', ts: end, keyboard: sampleKeyboard })
      await flushHandler(fakeEvent, sampleKeyboard.uid)

      const hash = await getMachineHash()
      const startDayRows = await readDayRows(sampleKeyboard.uid, hash, '2026-04-14')
      const endDayRows = await readDayRows(sampleKeyboard.uid, hash, '2026-04-15')
      expect(startDayRows.some((r) => r.kind === 'session')).toBe(true)
      expect(endDayRows.some((r) => r.kind === 'session')).toBe(false)
    })

    it('emits exactly one scope row per (uid, day) even with multiple snapshots', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      const minuteOne = Date.UTC(2026, 3, 14, 10, 0, 0)
      const minuteTwo = Date.UTC(2026, 3, 14, 10, 5, 0)
      await handler(fakeEvent, { kind: 'char', key: 'a', ts: minuteOne, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'char', key: 'b', ts: minuteTwo, keyboard: sampleKeyboard })
      await flushTypingAnalyticsNowForTests()

      const hash = await getMachineHash()
      const rows = await readDayRows(sampleKeyboard.uid, hash, '2026-04-14')
      expect(rows.filter((r) => r.kind === 'scope')).toHaveLength(1)
    })
  })
})
