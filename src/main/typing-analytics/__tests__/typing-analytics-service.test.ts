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

// The real logger memoizes its log directory (derived from
// app.getPath('userData')) at module scope on first use and never
// recomputes it — fine in production (one userData dir for the process
// lifetime) but incompatible with per-test mkdtemp directories: a test
// after the first one to log anything would ENOENT against an already
// mkdtemp mkdir/rm'd directory. Mocked out here since the flush-failure
// tests below deliberately trigger the service's error-path log call.
vi.mock('../../logger', () => ({
  log: vi.fn(),
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
  parseLayoutComparisonOptionsForTests,
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
import type { TypingBigramAggregateResult } from '../../../shared/types/typing-analytics'
import { DRAIN_CLOSE_GRACE_MS, MINUTE_MS, RETENTION_MS } from '../minute-buffer'
import { OBSERVATION_HOLE_MS } from '../../../shared/typing-analytics-timing'

type IpcHandler<R = unknown> = (event: unknown, ...args: unknown[]) => Promise<R>

function getHandler<R = unknown>(channel: string): IpcHandler<R> {
  const calls = vi.mocked(ipcMain.handle).mock.calls
  const match = calls.find(([ch]) => ch === channel)
  if (!match) throw new Error(`No handler registered for ${channel}`)
  return match[1] as IpcHandler<R>
}

const fakeEvent = {} as Electron.IpcMainInvokeEvent

/** Dispatch a TYPING_ANALYTICS_EVENT payload through the given handler,
 *  pinning the fake system clock to the payload's own `ts` first.
 *
 *  ingestEvent passes real `Date.now()` as MinuteBuffer.addEvent's `nowMs`
 *  — the retention/eviction guard needs the actual wall-clock moment an
 *  event is ingested, not its own `ts` (see minute-buffer.ts). In
 *  production those are always close together (an event is ingested at
 *  most a tapping-term-plus-jitter after it fires), but this suite's
 *  events are timestamped by scenario (arbitrary calendar dates, small
 *  relative offsets), independent of when the test actually runs. Pinning
 *  the clock to each event's own `ts` keeps every pre-existing scenario's
 *  "this is a normal, in-order event" assumption true without having to
 *  rewrite every literal timestamp in this file. Tests that specifically
 *  exercise retention/eviction pin the clock explicitly instead (see the
 *  "retention and eviction" describe block below). */
async function ingest(handler: IpcHandler, payload: Record<string, unknown>): Promise<void> {
  const ts = payload.ts
  if (typeof ts === 'number') vi.setSystemTime(ts)
  await handler(fakeEvent, payload)
}

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
    // Only Date is faked (never setTimeout/setInterval) — the flush
    // debounce timer and any real async I/O keep working normally; only
    // Date.now() / new Date() become controllable, via `ingest()` above,
    // so MinuteBuffer's retention guard sees a "now" consistent with each
    // test's own scenario timestamps instead of the real wall clock.
    vi.useFakeTimers({ toFake: ['Date'] })
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
    vi.useRealTimers()
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

      await ingest(handler, { kind: 'char', key: 'a', ts: 1_000, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'char', key: 'a', ts: 1_001, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'char', key: 'b', ts: 1_002, keyboard: sampleKeyboard })

      // Live minute buffer holds exactly one entry for minute 0.
      expect(getMinuteBufferForTests().isEmpty()).toBe(false)
    })

    it('persists per-minute char counts to SQLite on flush', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      const ts = Date.UTC(2026, 3, 14, 10, 0, 0)
      await ingest(handler, { kind: 'char', key: 'a', ts, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'char', key: 'a', ts: ts + 100, keyboard: sampleKeyboard })
      await ingest(handler, {
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
      await ingest(handler, { kind: 'matrix', row: 0, col: 0, layer: 0, keycode: 0x04, ts, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'matrix', row: 0, col: 1, layer: 0, keycode: 0x0B, ts: ts + 120, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'matrix', row: 0, col: 2, layer: 0, keycode: 0x07, ts: ts + 280, keyboard: sampleKeyboard })

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

    it('emits sum_iki / sumsq_iki alongside the bigram histogram', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      const ts = Date.UTC(2026, 3, 14, 10, 0, 0)
      // Same 3 events as above: iki(4->11)=120, iki(11->7)=160.
      await ingest(handler, { kind: 'matrix', row: 0, col: 0, layer: 0, keycode: 0x04, ts, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'matrix', row: 0, col: 1, layer: 0, keycode: 0x0B, ts: ts + 120, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'matrix', row: 0, col: 2, layer: 0, keycode: 0x07, ts: ts + 280, keyboard: sampleKeyboard })

      await flushTypingAnalyticsNowForTests()

      const conn = getTypingAnalyticsDB().getConnection()
      const rows = conn
        .prepare('SELECT bigram_id, sum_iki, sumsq_iki FROM typing_bigram_minute ORDER BY bigram_id')
        .all() as { bigram_id: string; sum_iki: number; sumsq_iki: number }[]
      expect(rows).toEqual([
        { bigram_id: '11_7', sum_iki: 160, sumsq_iki: 160 * 160 },
        { bigram_id: '4_11', sum_iki: 120, sumsq_iki: 120 * 120 },
      ])
    })

    it('emits a trigram-minute row when 3 consecutive matrix events flush', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      const ts = Date.UTC(2026, 3, 14, 10, 0, 0)
      // iki(4->11)=120, iki(11->7)=160 -> trigram value = (120+160)/2 = 140.
      await ingest(handler, { kind: 'matrix', row: 0, col: 0, layer: 0, keycode: 0x04, ts, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'matrix', row: 0, col: 1, layer: 0, keycode: 0x0B, ts: ts + 120, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'matrix', row: 0, col: 2, layer: 0, keycode: 0x07, ts: ts + 280, keyboard: sampleKeyboard })

      await flushTypingAnalyticsNowForTests()

      const conn = getTypingAnalyticsDB().getConnection()
      const rows = conn
        .prepare('SELECT trigram_id, count, sum_iki, sumsq_iki FROM typing_trigram_minute')
        .all() as { trigram_id: string; count: number; sum_iki: number; sumsq_iki: number }[]
      expect(rows).toEqual([
        { trigram_id: '4_11_7', count: 1, sum_iki: 140, sumsq_iki: 140 * 140 },
      ])
    })

    it('does not emit a trigram-minute row when fewer than 3 consecutive matrix events flush', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      const ts = Date.UTC(2026, 3, 14, 10, 0, 0)
      await ingest(handler, { kind: 'matrix', row: 0, col: 0, layer: 0, keycode: 0x04, ts, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'matrix', row: 0, col: 1, layer: 0, keycode: 0x0B, ts: ts + 120, keyboard: sampleKeyboard })

      await flushTypingAnalyticsNowForTests()

      const conn = getTypingAnalyticsDB().getConnection()
      const count = conn.prepare('SELECT COUNT(*) AS n FROM typing_trigram_minute').get() as { n: number }
      expect(count.n).toBe(0)
    })

    it('does not emit a bigram-minute row when only char events flush', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      const ts = Date.UTC(2026, 3, 14, 10, 0, 0)
      await ingest(handler, { kind: 'char', key: 'a', ts, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'char', key: 'b', ts: ts + 100, keyboard: sampleKeyboard })

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
      await ingest(eventHandler, { kind: 'char', key: 'a', ts: start, keyboard: sampleKeyboard })
      await ingest(eventHandler, { kind: 'char', key: 'b', ts: end, keyboard: sampleKeyboard })

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

      await ingest(handler, { kind: 'char', key: 'a', ts: 1_000, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'char', key: 'a', ts: 1_000, keyboard: otherKeyboard })

      await flushTypingAnalyticsNowForTests()

      const conn = getTypingAnalyticsDB().getConnection()
      const scopes = conn.prepare('SELECT id, keyboard_uid FROM typing_scopes ORDER BY keyboard_uid').all() as ScopeRow[]
      expect(scopes.map((s) => s.keyboard_uid)).toEqual(['0xAABB', '0xCCDD'])
    })

    it('reports pending work while only an active session exists', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      await ingest(handler, { kind: 'char', key: 'a', ts: 1_000, keyboard: sampleKeyboard })
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
      await ingest(handler, { kind: 'char', key: 'a', ts, keyboard: sampleKeyboard })
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

      await ingest(handler, { kind: 'char', key: 'a', ts: 1_000, keyboard: sampleKeyboard })

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

      await ingest(handler, { kind: 'char', key: 'a', ts: 1_000, keyboard: sampleKeyboard })

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

      await ingest(handler, { kind: 'char', key: 'a', ts: 1_000, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'char', key: 'a', ts: 1_000, keyboard: otherKeyboard })
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

      await ingest(handler, { kind: 'char', key: 'a', ts: 1_000, keyboard: sampleKeyboard })
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
        await ingest(handler, { kind: 'char', key, ts, keyboard })
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
        // Tombstone notify fires one per-day unit per affected UTC day.
        expect(notifier).toHaveBeenCalledWith(
          expect.stringMatching(
            new RegExp(`^keyboards/${sampleKeyboard.uid}/devices/${machineHash}/days/\\d{4}-\\d{2}-\\d{2}$`),
          ),
        )
      })

      it('deleteAllTypingForKeyboard wipes every live row for the uid', async () => {
        const notifier = vi.fn()
        setTypingAnalyticsSyncNotifier(notifier)
        await seedKeyboardData(sampleKeyboard, Date.UTC(2026, 3, 10, 12, 0, 0))
        await seedKeyboardData(sampleKeyboard, Date.UTC(2026, 3, 14, 12, 0, 0), 'b')
        // Forget the per-day flush notifications fired during seeding so
        // the assertion below sees only the delete-time notifies.
        notifier.mockClear()

        const result = await deleteAllTypingForKeyboard(sampleKeyboard.uid)
        expect(result.charMinutes).toBeGreaterThan(0)
        expect(listTypingKeyboards().map((k) => k.uid)).not.toContain(sampleKeyboard.uid)
        const machineHash = await getMachineHash()
        // Delete-all notifies a per-day unit for each day captured before the
        // unlink (plus a redundant one for the day the just-closed active
        // session flushed to). Both seeded UTC days must be notified; the
        // notify is idempotent so dedupe before comparing.
        const expectedUnits = ['2026-04-10', '2026-04-14'].map(
          (day) => `keyboards/${sampleKeyboard.uid}/devices/${machineHash}/days/${day}`,
        )
        expect([...new Set(notifier.mock.calls.map((call) => call[0] as string))].sort()).toEqual(expectedUnits.sort())
      })

      it('deleteTypingDailySummaries is a no-op when the dates array is empty', async () => {
        const notifier = vi.fn()
        setTypingAnalyticsSyncNotifier(notifier)
        await seedKeyboardData(sampleKeyboard, Date.UTC(2026, 3, 14, 12, 0, 0))
        notifier.mockClear() // forget the seed's own flush notification

        const result = await deleteTypingDailySummaries(sampleKeyboard.uid, [])
        expect(result).toEqual({ charMinutes: 0, matrixMinutes: 0, minuteStats: 0, bigramMinutes: 0, trigramMinutes: 0, sessions: 0 })
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
          await ingest(handler, { kind: 'matrix', row, col, layer, keycode: 0x04, ts, keyboard })
        }

        it('combines flushed DB rows with the live in-memory current minute', async () => {
          const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
          // One press lands in the DB via the flush.
          await ingestMatrix(sampleKeyboard, 1, 2, 0, ts)
          await flushTypingAnalyticsNowForTests()
          // Second press lands in the NEXT minute — a genuinely fresh,
          // never-flushed entry — so only the peekMatrixCountsForUid path
          // can see it. (A press landing back in the SAME, already-flushed
          // minute would instead be excluded from the peek — see the
          // "retention and eviction" describe block below for that case.)
          await ingestMatrix(sampleKeyboard, 1, 2, 0, ts + MINUTE_MS)

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
        await ingest(handler, { kind: 'matrix', row: 0, col: 0, layer: 0, keycode: 0x04, ts, keyboard: sampleKeyboard })
        await ingest(handler, { kind: 'matrix', row: 0, col: 1, layer: 0, keycode: 0x0B, ts: ts + 80, keyboard: sampleKeyboard })
        await ingest(handler, { kind: 'matrix', row: 0, col: 2, layer: 0, keycode: 0x07, ts: ts + 280, keyboard: sampleKeyboard })
        await flushTypingAnalyticsNowForTests()
      }

      it('returns top-ranked entries for view=top with all-scope', async () => {
        const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
        await ingestThree(ts)
        const handler = getHandler<TypingBigramAggregateResult>(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        const result = await handler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'top', 'all', undefined)
        expect(result.view).toBe('top')
        expect(result.entries.map((e: { ngramId: string }) => e.ngramId).sort()).toEqual(['11_7', '4_11'])
        expect(result.entries.every((e: { count: number }) => e.count === 1)).toBe(true)
      })

      it('computes observedRolloverRatio from overlap-tagged matrix events', async () => {
        setupTypingAnalyticsIpc()
        const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
        const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
        // 4->11 completes with overlap=true, 11->7 with overlap=false.
        await ingest(handler, { kind: 'matrix', row: 0, col: 0, layer: 0, keycode: 0x04, ts, keyboard: sampleKeyboard })
        await ingest(handler, { kind: 'matrix', row: 0, col: 1, layer: 0, keycode: 0x0B, ts: ts + 80, keyboard: sampleKeyboard, overlap: true })
        await ingest(handler, { kind: 'matrix', row: 0, col: 2, layer: 0, keycode: 0x07, ts: ts + 280, keyboard: sampleKeyboard, overlap: false })
        await flushTypingAnalyticsNowForTests()

        const aggHandler = getHandler<TypingBigramAggregateResult>(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        const result = await aggHandler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'top', 'all', undefined)
        expect(result.observedRolloverRatio).toBe(1 / 2)
      })

      it('returns null observedRolloverRatio when no ingested event carried a determined overlap', async () => {
        const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
        await ingestThree(ts)
        const handler = getHandler<TypingBigramAggregateResult>(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        const result = await handler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'top', 'all', undefined)
        expect(result.observedRolloverRatio).toBeNull()
      })

      it('returns slow entries with p95 for view=slow', async () => {
        const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
        await ingestThree(ts)
        const handler = getHandler<TypingBigramAggregateResult>(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        // minSampleCount: 1 — both pairs are single-sample so they're kept.
        const result = await handler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'slow', 'all', { minSampleCount: 1 })
        expect(result.view).toBe('slow')
        expect(result.entries).toHaveLength(2)
        if (result.view !== 'slow') throw new Error('unreachable')
        expect(typeof result.entries[0].p95).toBe('number')
      })

      it('drops entries below minSampleCount on view=slow', async () => {
        const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
        await ingestThree(ts)
        const handler = getHandler<TypingBigramAggregateResult>(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        // Default minSample = 5 — none of the single-sample pairs qualify.
        const result = await handler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'slow', 'all', undefined)
        expect(result.view).toBe('slow')
        expect(result.entries).toEqual([])
      })

      it('returns an empty top result for an unknown view', async () => {
        setupTypingAnalyticsIpc()
        const handler = getHandler<TypingBigramAggregateResult>(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        const result = await handler(fakeEvent, sampleKeyboard.uid, 0, 60_000, 'unknown', 'all', undefined)
        expect(result).toEqual({ view: 'top', entries: [], truncated: false, observedRolloverRatio: null })
      })

      it('returns an empty result when sinceMs >= untilMs', async () => {
        setupTypingAnalyticsIpc()
        const handler = getHandler<TypingBigramAggregateResult>(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        const result = await handler(fakeEvent, sampleKeyboard.uid, 60_000, 60_000, 'top', 'all', undefined)
        expect(result).toEqual({ view: 'top', entries: [], truncated: false, observedRolloverRatio: null })
      })

      it('returns an empty result when uid is invalid', async () => {
        setupTypingAnalyticsIpc()
        const handler = getHandler<TypingBigramAggregateResult>(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        const result = await handler(fakeEvent, '', 0, 60_000, 'top', 'all', undefined)
        expect(result).toEqual({ view: 'top', entries: [], truncated: false, observedRolloverRatio: null })
      })

      it('honours scope=own by filtering to the local machine_hash', async () => {
        const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
        await ingestThree(ts)
        const handler = getHandler<TypingBigramAggregateResult>(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        const result = await handler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'top', 'own', undefined)
        expect(result.view).toBe('top')
        // The own machineHash is the only one in test data — same as 'all'.
        expect(result.entries).toHaveLength(2)
      })

      it('attaches sd to top/slow entries once IKI sums are recorded', async () => {
        const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
        await ingestThree(ts)
        const handler = getHandler<TypingBigramAggregateResult>(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        const result = await handler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'top', 'all', undefined)
        // Each bigram in ingestThree has exactly one row (n=1) so sd is
        // undefined-for-variance (n < 2) → null, but the field must be
        // present and typed, not just missing.
        expect(result.entries.every((e: { sd: number | null }) => e.sd === null)).toBe(true)
      })

      it('sets truncated=false when every distinct pair fits within the limit', async () => {
        const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
        await ingestThree(ts) // two distinct bigrams, well under the default limit of 30
        const handler = getHandler<TypingBigramAggregateResult>(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        const result = await handler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'top', 'all', undefined)
        expect(result.truncated).toBe(false)
      })

      it('sets truncated=true when the distinct-pair universe exceeds the requested limit', async () => {
        const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
        await ingestThree(ts) // two distinct bigrams: 4_11 and 11_7
        const handler = getHandler<TypingBigramAggregateResult>(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        const result = await handler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'top', 'all', { limit: 1 })
        expect(result.truncated).toBe(true)
        expect(result.entries).toHaveLength(1)
      })

      it('sets truncated=true on view=slow too, computed from the same pair universe', async () => {
        const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
        await ingestThree(ts)
        const handler = getHandler<TypingBigramAggregateResult>(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
        const result = await handler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'slow', 'all', { minSampleCount: 1, limit: 1 })
        expect(result.truncated).toBe(true)
      })

      describe('gram option', () => {
        it('defaults to bigram results identical to an explicit gram: 2 request', async () => {
          const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
          await ingestThree(ts)
          const handler = getHandler<TypingBigramAggregateResult>(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
          const omitted = await handler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'top', 'all', undefined)
          const explicit = await handler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'top', 'all', { gram: 2 })
          expect(omitted).toEqual(explicit)
          expect(omitted.entries.map((e: { ngramId: string }) => e.ngramId).sort()).toEqual(['11_7', '4_11'])
        })

        it.each([0, 5, 'x', null, {}])('falls back to gram=2 for an invalid gram value (%s)', async (badGram) => {
          const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
          await ingestThree(ts)
          const handler = getHandler<TypingBigramAggregateResult>(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
          const baseline = await handler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'top', 'all', undefined)
          const withBadGram = await handler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'top', 'all', { gram: badGram })
          expect(withBadGram).toEqual(baseline)
        })

        it('aggregates from the trigram table when gram: 3 is requested', async () => {
          const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
          await ingestThree(ts)
          const handler = getHandler<TypingBigramAggregateResult>(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
          const result = await handler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'top', 'all', { gram: 3 })
          expect(result.view).toBe('top')
          expect(result.entries.map((e: { ngramId: string }) => e.ngramId)).toEqual(['4_11_7'])
          expect(result.entries[0].count).toBe(1)
        })

        it('returns an empty result for gram: 3 when fewer than 3 consecutive keystrokes were recorded', async () => {
          setupTypingAnalyticsIpc()
          const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
          const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
          await ingest(handler, { kind: 'matrix', row: 0, col: 0, layer: 0, keycode: 0x04, ts, keyboard: sampleKeyboard })
          await ingest(handler, { kind: 'matrix', row: 0, col: 1, layer: 0, keycode: 0x0B, ts: ts + 80, keyboard: sampleKeyboard })
          await flushTypingAnalyticsNowForTests()

          const aggHandler = getHandler<TypingBigramAggregateResult>(IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE)
          const result = await aggHandler(fakeEvent, sampleKeyboard.uid, ts - 60_000, ts + 60_000, 'top', 'all', { gram: 3 })
          expect(result.entries).toEqual([])
        })
      })
    })

    it('silently drops malformed payloads', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      await handler(fakeEvent, null)
      await handler(fakeEvent, 'not-an-object')
      await ingest(handler, { kind: 'char', ts: 1_000, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'char', key: 'a', keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'matrix', row: 0, col: 0, layer: 0, keycode: 1, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'unknown', key: 'a', ts: 1_000, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'matrix', row: -1, col: 0, layer: 0, keycode: 1, ts: 1_000, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'char', key: 'a', ts: 1_000 })
      await ingest(handler, { kind: 'char', key: 'a', ts: 1_000, keyboard: { uid: '', vendorId: 0, productId: 0, productName: '' } })
      // Note: an invalid action/overlap/pollGapMs on an otherwise-valid
      // matrix event does NOT drop the payload — see the sanitization
      // tests below (isValidEvent strips the offending optional field
      // instead of rejecting the whole keystroke).
      // matrix-release requires row/col/layer/keycode plus a valid durationMs.
      await ingest(handler, { kind: 'matrix-release', row: 0, col: 0, layer: 0, keycode: 1, ts: 1_000, keyboard: sampleKeyboard })
      await ingest(handler, {
        kind: 'matrix-release', row: 0, col: 0, layer: 0, keycode: 1, ts: 1_000, durationMs: 0, keyboard: sampleKeyboard,
      })
      await ingest(handler, {
        kind: 'matrix-release', row: 0, col: 0, layer: 0, keycode: 1, ts: 1_000, durationMs: -10, keyboard: sampleKeyboard,
      })
      await ingest(handler, {
        kind: 'matrix-release', row: 0, col: 0, layer: 0, keycode: 1, ts: 1_000, durationMs: 60_000, keyboard: sampleKeyboard,
      })

      expect(getMinuteBufferForTests().isEmpty()).toBe(true)
    })

    it('accepts a matrix event with valid action/overlap/pollGapMs and a matrix-release event, and persists duration to SQLite', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const ts = Date.UTC(2026, 3, 14, 12, 0, 0)

      await ingest(handler, {
        kind: 'matrix', row: 0, col: 3, layer: 0, keycode: 0x04, ts, keyboard: sampleKeyboard,
        action: 'tap', overlap: true, pollGapMs: 20,
      })
      await ingest(handler, {
        kind: 'matrix-release', row: 0, col: 3, layer: 0, keycode: 0x04, ts: ts + 90, durationMs: 90, keyboard: sampleKeyboard,
      })
      await flushTypingAnalyticsNowForTests()

      const conn = getTypingAnalyticsDB().getConnection()
      const row = conn.prepare('SELECT count, dur_hist, dur_sum, dur_sumsq FROM typing_matrix_minute WHERE row = 0 AND col = 3').get() as {
        count: number
        dur_hist: Uint8Array | null
        dur_sum: number | null
        dur_sumsq: number | null
      }
      expect(row.count).toBe(1)
      expect(row.dur_hist).not.toBeNull()
      expect(row.dur_sum).toBe(90)
      expect(row.dur_sumsq).toBe(8_100)
    })

    it('sanitizes an invalid action/overlap/pollGapMs instead of dropping the keystroke', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const ts = Date.UTC(2026, 3, 14, 12, 0, 0)

      await ingest(handler, {
        kind: 'matrix', row: 0, col: 5, layer: 0, keycode: 0x04, ts, keyboard: sampleKeyboard,
        action: 'bogus', overlap: 'yes', pollGapMs: -5,
      })
      await flushTypingAnalyticsNowForTests()

      const conn = getTypingAnalyticsDB().getConnection()
      // The keystroke itself is still counted...
      const row = conn.prepare('SELECT count, tap_count, hold_count FROM typing_matrix_minute WHERE row = 0 AND col = 5').get() as {
        count: number
        tap_count: number
        hold_count: number
      }
      expect(row.count).toBe(1)
      expect(row.tap_count).toBe(0)
      expect(row.hold_count).toBe(0)

      // ...but the invalid pollGapMs never reaches minute-stats.
      const stats = conn.prepare('SELECT poll_p50_ms, poll_p95_ms FROM typing_minute_stats WHERE minute_ts = ?').get(Math.floor(ts / MINUTE_MS) * MINUTE_MS) as {
        poll_p50_ms: number | null
        poll_p95_ms: number | null
      }
      expect(stats.poll_p50_ms).toBeNull()
      expect(stats.poll_p95_ms).toBeNull()
    })

    it('sanitizes an oversized pollGapMs (beyond OBSERVATION_HOLE_MS) without dropping the event', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const ts = Date.UTC(2026, 3, 14, 12, 0, 0)

      await ingest(handler, {
        kind: 'matrix', row: 0, col: 6, layer: 0, keycode: 0x04, ts, keyboard: sampleKeyboard,
        pollGapMs: OBSERVATION_HOLE_MS + 1,
      })
      await flushTypingAnalyticsNowForTests()

      const conn = getTypingAnalyticsDB().getConnection()
      const row = conn.prepare('SELECT count FROM typing_matrix_minute WHERE row = 0 AND col = 6').get() as { count: number }
      expect(row.count).toBe(1)

      const stats = conn.prepare('SELECT poll_p50_ms FROM typing_minute_stats WHERE minute_ts = ?').get(Math.floor(ts / MINUTE_MS) * MINUTE_MS) as { poll_p50_ms: number | null }
      expect(stats.poll_p50_ms).toBeNull()
    })

    it('does not create a minute-stats row for a minute whose only activity is a matrix-release (no phantom day)', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      // A press near the end of one minute, released just after the next
      // minute starts — the release's own minute has no press activity
      // of its own, only the duration sample.
      const minuteStart = Date.UTC(2026, 3, 14, 10, 1, 0)
      const pressTs = minuteStart - 50
      const releaseTs = minuteStart + 50

      await ingest(handler, { kind: 'matrix', row: 0, col: 7, layer: 0, keycode: 0x04, ts: pressTs, keyboard: sampleKeyboard })
      await ingest(handler, {
        kind: 'matrix-release', row: 0, col: 7, layer: 0, keycode: 0x04, ts: releaseTs, durationMs: 100, keyboard: sampleKeyboard,
      })
      await flushTypingAnalyticsNowForTests()

      const conn = getTypingAnalyticsDB().getConnection()
      const releaseMinuteTs = Math.floor(releaseTs / MINUTE_MS) * MINUTE_MS
      const statsRow = conn.prepare('SELECT keystrokes FROM typing_minute_stats WHERE minute_ts = ?').get(releaseMinuteTs)
      expect(statsRow).toBeUndefined()

      // The duration data itself still ships for that same minute.
      const matrixRow = conn.prepare('SELECT dur_sum FROM typing_matrix_minute WHERE minute_ts = ? AND row = 0 AND col = 7').get(releaseMinuteTs) as { dur_sum: number } | undefined
      expect(matrixRow?.dur_sum).toBe(100)

      // The press's own (earlier) minute still gets an ordinary
      // minute-stats row — only the release-only minute is skipped.
      const pressMinuteTs = Math.floor(pressTs / MINUTE_MS) * MINUTE_MS
      const pressStatsRow = conn.prepare('SELECT keystrokes FROM typing_minute_stats WHERE minute_ts = ?').get(pressMinuteTs) as { keystrokes: number } | undefined
      expect(pressStatsRow?.keystrokes).toBe(1)
    })

    it('excludes matrix-release from session detection (a release alone does not open or extend a session)', async () => {
      setupTypingAnalyticsIpc()
      const eventHandler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const flushHandler = getHandler(IpcChannels.TYPING_ANALYTICS_FLUSH)

      const pressTs = Date.UTC(2026, 3, 14, 12, 0, 0)
      // Well past SESSION_IDLE_GAP_MS (5 min) — if the release below
      // were treated as an ordinary keystroke for session detection, this
      // gap would close the press's session and open a second one at
      // the release's own ts.
      const releaseTs = pressTs + 6 * MINUTE_MS

      await ingest(eventHandler, { kind: 'matrix', row: 0, col: 8, layer: 0, keycode: 0x04, ts: pressTs, keyboard: sampleKeyboard })
      await ingest(eventHandler, {
        kind: 'matrix-release', row: 0, col: 8, layer: 0, keycode: 0x04, ts: releaseTs, durationMs: 6 * MINUTE_MS, keyboard: sampleKeyboard,
      })

      await flushHandler(fakeEvent, sampleKeyboard.uid)

      const conn = getTypingAnalyticsDB().getConnection()
      const sessions = conn.prepare('SELECT start_ms, end_ms FROM typing_sessions').all() as Array<{ start_ms: number; end_ms: number }>
      // Exactly one session, ending at the press itself — the release
      // never reached the session detector at all.
      expect(sessions).toHaveLength(1)
      expect(sessions[0].start_ms).toBe(pressTs)
      expect(sessions[0].end_ms).toBe(pressTs)
    })
  })

  describe('listRolloverMinutes', () => {
    type RolloverMinuteRow = { minuteTs: number; oc: number; on: number }

    async function ingestOverlapPair(ts: number): Promise<void> {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      // 4->11 completes with overlap=true, 11->7 with overlap=false —
      // both bigram completions land in the same minute.
      await ingest(handler, { kind: 'matrix', row: 0, col: 0, layer: 0, keycode: 0x04, ts, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'matrix', row: 0, col: 1, layer: 0, keycode: 0x0B, ts: ts + 80, keyboard: sampleKeyboard, overlap: true })
      await ingest(handler, { kind: 'matrix', row: 0, col: 2, layer: 0, keycode: 0x07, ts: ts + 280, keyboard: sampleKeyboard, overlap: false })
      await flushTypingAnalyticsNowForTests()
    }

    it('returns the per-minute oc/on sum across every completed bigram pair', async () => {
      const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
      await ingestOverlapPair(ts)
      const handler = getHandler<RolloverMinuteRow[]>(IpcChannels.TYPING_ANALYTICS_LIST_ROLLOVER_MINUTES)
      const result = await handler(fakeEvent, sampleKeyboard.uid, 'all', ts - 60_000, ts + 60_000)
      const minuteTs = Math.floor(ts / MINUTE_MS) * MINUTE_MS
      expect(result).toEqual([{ minuteTs, oc: 1, on: 2 }])
    })

    it('returns an empty array when no ingested event carried a determined overlap', async () => {
      setupTypingAnalyticsIpc()
      const handler2 = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
      await ingest(handler2, { kind: 'matrix', row: 0, col: 0, layer: 0, keycode: 0x04, ts, keyboard: sampleKeyboard })
      await ingest(handler2, { kind: 'matrix', row: 0, col: 1, layer: 0, keycode: 0x0B, ts: ts + 80, keyboard: sampleKeyboard })
      await flushTypingAnalyticsNowForTests()

      const handler = getHandler<RolloverMinuteRow[]>(IpcChannels.TYPING_ANALYTICS_LIST_ROLLOVER_MINUTES)
      const result = await handler(fakeEvent, sampleKeyboard.uid, 'all', ts - 60_000, ts + 60_000)
      expect(result).toEqual([])
    })

    it('honours scope=own by filtering to the local machine_hash', async () => {
      const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
      await ingestOverlapPair(ts)
      const handler = getHandler<RolloverMinuteRow[]>(IpcChannels.TYPING_ANALYTICS_LIST_ROLLOVER_MINUTES)
      const result = await handler(fakeEvent, sampleKeyboard.uid, 'own', ts - 60_000, ts + 60_000)
      const minuteTs = Math.floor(ts / MINUTE_MS) * MINUTE_MS
      // The own machineHash is the only one in test data — same as 'all'.
      expect(result).toEqual([{ minuteTs, oc: 1, on: 2 }])
    })

    it('returns an empty array when uid is invalid', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler<RolloverMinuteRow[]>(IpcChannels.TYPING_ANALYTICS_LIST_ROLLOVER_MINUTES)
      expect(await handler(fakeEvent, '', 'all', 0, 60_000)).toEqual([])
    })

    it('returns an empty array when sinceMs >= untilMs', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler<RolloverMinuteRow[]>(IpcChannels.TYPING_ANALYTICS_LIST_ROLLOVER_MINUTES)
      expect(await handler(fakeEvent, sampleKeyboard.uid, 'all', 60_000, 60_000)).toEqual([])
    })

    it('returns an empty array for an unparseable scope', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler<RolloverMinuteRow[]>(IpcChannels.TYPING_ANALYTICS_LIST_ROLLOVER_MINUTES)
      expect(await handler(fakeEvent, sampleKeyboard.uid, 'not-a-scope', 0, 60_000)).toEqual([])
    })

    it('rejects non-numeric sinceMs/untilMs instead of coercing them', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler<RolloverMinuteRow[]>(IpcChannels.TYPING_ANALYTICS_LIST_ROLLOVER_MINUTES)
      expect(await handler(fakeEvent, sampleKeyboard.uid, 'all', 'x', 60_000)).toEqual([])
      expect(await handler(fakeEvent, sampleKeyboard.uid, 'all', 0, 'x')).toEqual([])
    })
  })

  describe('listDurationCells', () => {
    type DurationCellRow = { row: number; col: number; layer: number; durationSamples: number; hist: number[]; sum: number; sumSq: number }

    async function ingestDuration(row: number, col: number, ts: number, durationMs: number): Promise<void> {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      await ingest(handler, {
        kind: 'matrix-release', row, col, layer: 0, keycode: 0x04, ts, durationMs, keyboard: sampleKeyboard,
      })
      await flushTypingAnalyticsNowForTests()
    }

    it('returns one folded cell total per (row, col, layer) in range', async () => {
      const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
      await ingestDuration(0, 3, ts, 90)
      const handler = getHandler<DurationCellRow[]>(IpcChannels.TYPING_ANALYTICS_LIST_DURATION_CELLS)
      const result = await handler(fakeEvent, sampleKeyboard.uid, 'all', ts - 60_000, ts + 60_000)
      expect(result).toHaveLength(1)
      expect(result[0].row).toBe(0)
      expect(result[0].col).toBe(3)
      expect(result[0].layer).toBe(0)
      expect(result[0].durationSamples).toBe(1)
      expect(result[0].sum).toBe(90)
      expect(result[0].sumSq).toBe(8_100)
      expect(Array.isArray(result[0].hist)).toBe(true)
    })

    it('folds multiple minutes for the same cell into one total', async () => {
      const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
      await ingestDuration(1, 2, ts, 80)
      await ingestDuration(1, 2, ts + MINUTE_MS, 120)
      const handler = getHandler<DurationCellRow[]>(IpcChannels.TYPING_ANALYTICS_LIST_DURATION_CELLS)
      const result = await handler(fakeEvent, sampleKeyboard.uid, 'all', ts - 60_000, ts + 2 * MINUTE_MS)
      expect(result).toHaveLength(1)
      expect(result[0].durationSamples).toBe(2)
      expect(result[0].sum).toBe(200)
      expect(result[0].sumSq).toBe(80 * 80 + 120 * 120)
    })

    it('returns an empty array when no matrix-release event has landed in range', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler<DurationCellRow[]>(IpcChannels.TYPING_ANALYTICS_LIST_DURATION_CELLS)
      expect(await handler(fakeEvent, sampleKeyboard.uid, 'all', 0, 60_000)).toEqual([])
    })

    it('honours scope=own by filtering to the local machine_hash', async () => {
      const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
      await ingestDuration(0, 0, ts, 100)
      const handler = getHandler<DurationCellRow[]>(IpcChannels.TYPING_ANALYTICS_LIST_DURATION_CELLS)
      const result = await handler(fakeEvent, sampleKeyboard.uid, 'own', ts - 60_000, ts + 60_000)
      expect(result).toHaveLength(1)
    })

    it('returns an empty array when uid is invalid', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler<DurationCellRow[]>(IpcChannels.TYPING_ANALYTICS_LIST_DURATION_CELLS)
      expect(await handler(fakeEvent, '', 'all', 0, 60_000)).toEqual([])
    })

    it('returns an empty array when sinceMs >= untilMs', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler<DurationCellRow[]>(IpcChannels.TYPING_ANALYTICS_LIST_DURATION_CELLS)
      expect(await handler(fakeEvent, sampleKeyboard.uid, 'all', 60_000, 60_000)).toEqual([])
    })

    it('returns an empty array for an unparseable scope', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler<DurationCellRow[]>(IpcChannels.TYPING_ANALYTICS_LIST_DURATION_CELLS)
      expect(await handler(fakeEvent, sampleKeyboard.uid, 'not-a-scope', 0, 60_000)).toEqual([])
    })

    it('rejects non-numeric sinceMs/untilMs instead of coercing them', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler<DurationCellRow[]>(IpcChannels.TYPING_ANALYTICS_LIST_DURATION_CELLS)
      expect(await handler(fakeEvent, sampleKeyboard.uid, 'all', 'x', 60_000)).toEqual([])
      expect(await handler(fakeEvent, sampleKeyboard.uid, 'all', 0, 'x')).toEqual([])
    })
  })

  describe('parseLayoutComparisonOptions (fingerOverrides validation)', () => {
    const validBase = {
      source: { id: 'qwerty', map: {} },
      targets: [{ id: 'colemak', map: {} }],
      metrics: [] as string[],
    }

    it('accepts a valid fingerOverrides map', () => {
      const result = parseLayoutComparisonOptionsForTests({
        ...validBase,
        fingerOverrides: { '0,0': 'left-index', '1,3': 'right-pinky' },
      })
      expect(result).not.toBeNull()
      expect(result?.fingerOverrides).toEqual({ '0,0': 'left-index', '1,3': 'right-pinky' })
    })

    it('accepts options without fingerOverrides (backward compatible)', () => {
      const result = parseLayoutComparisonOptionsForTests(validBase)
      expect(result).not.toBeNull()
      expect(result?.fingerOverrides).toBeUndefined()
    })

    it('rejects a fingerOverrides key that is not a "row,col" position', () => {
      const result = parseLayoutComparisonOptionsForTests({
        ...validBase,
        fingerOverrides: { 'not-a-pos': 'left-index' },
      })
      expect(result).toBeNull()
    })

    it('rejects a fingerOverrides value that is not one of the 10 finger names', () => {
      const result = parseLayoutComparisonOptionsForTests({
        ...validBase,
        fingerOverrides: { '0,0': 'left-elbow' },
      })
      expect(result).toBeNull()
    })

    it('rejects a non-object fingerOverrides', () => {
      const result = parseLayoutComparisonOptionsForTests({
        ...validBase,
        fingerOverrides: 'left-index',
      })
      expect(result).toBeNull()
    })

    it('rejects a fingerOverrides array (Array.isArray guard)', () => {
      const result = parseLayoutComparisonOptionsForTests({
        ...validBase,
        fingerOverrides: ['left-index'],
      })
      expect(result).toBeNull()
    })
  })

  describe('per-day JSONL output', () => {
    async function readDayRows(uid: string, machineHash: string, utcDay: string): Promise<JsonlRow[]> {
      const path = deviceDayJsonlPath(mockUserDataPath, uid, machineHash, utcDay)
      const { rows } = await readRows(path)
      return rows
    }
    const charsOnDay = (rows: JsonlRow[]): string[] =>
      rows.flatMap((r) => (r.kind === 'char-minute' ? [r.payload.char] : []))

    it('writes each flush to {hash}/{utcDay}.jsonl with no flat sibling', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const ts = Date.UTC(2026, 3, 14, 10, 0, 0)
      await ingest(handler, { kind: 'char', key: 'a', ts, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'char', key: 'a', ts: ts + 100, keyboard: sampleKeyboard })
      await flushTypingAnalyticsNowForTests()

      const hash = await getMachineHash()
      const dayPath = deviceDayJsonlPath(mockUserDataPath, sampleKeyboard.uid, hash, '2026-04-14')
      expect(existsSync(dayPath)).toBe(true)

      // Guard against a stray flat `{hash}.jsonl` ever being written
      // alongside the per-day directory — there is no code path for it
      // anymore, but the assertion locks the invariant in place.
      const flatPath = join(deviceDayDir(mockUserDataPath, sampleKeyboard.uid, hash), '..', `${hash}.jsonl`)
      expect(existsSync(flatPath)).toBe(false)

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
      await ingest(handler, { kind: 'char', key: 'a', ts: dayOne, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'char', key: 'b', ts: dayTwo, keyboard: sampleKeyboard })
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
      await ingest(handler, { kind: 'char', key: 'x', ts: eveningMinute, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'char', key: 'y', ts: morningMinute, keyboard: sampleKeyboard })
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
      await ingest(eventHandler, { kind: 'char', key: 'a', ts: start, keyboard: sampleKeyboard })
      await ingest(eventHandler, { kind: 'char', key: 'b', ts: end, keyboard: sampleKeyboard })
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
      await ingest(handler, { kind: 'char', key: 'a', ts: minuteOne, keyboard: sampleKeyboard })
      await ingest(handler, { kind: 'char', key: 'b', ts: minuteTwo, keyboard: sampleKeyboard })
      await flushTypingAnalyticsNowForTests()

      const hash = await getMachineHash()
      const rows = await readDayRows(sampleKeyboard.uid, hash, '2026-04-14')
      expect(rows.filter((r) => r.kind === 'scope')).toHaveLength(1)
    })
  })

  describe('retention and full re-send', () => {
    it('persists the full cumulative keystroke count when a late event arrives after a completed flush', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const ts = Date.UTC(2026, 3, 14, 12, 0, 0)

      await ingest(handler, { kind: 'char', key: 'a', ts, keyboard: sampleKeyboard })
      await flushTypingAnalyticsNowForTests()

      const conn = getTypingAnalyticsDB().getConnection()
      let stats = conn.prepare('SELECT keystrokes FROM typing_minute_stats').all() as { keystrokes: number }[]
      expect(stats).toEqual([{ keystrokes: 1 }])

      // A straggler for the SAME minute arrives after that flush already
      // completed — e.g. a tap-hold press whose deferred emit landed past
      // DRAIN_CLOSE_GRACE_MS.
      await ingest(handler, { kind: 'char', key: 'a', ts: ts + DRAIN_CLOSE_GRACE_MS + 500, keyboard: sampleKeyboard })
      await flushTypingAnalyticsNowForTests()

      stats = conn.prepare('SELECT keystrokes FROM typing_minute_stats').all() as { keystrokes: number }[]
      // Must be the FULL cumulative count (2), not the straggler alone —
      // a partial re-send here would replace the DB's real total through
      // the strict `>` LWW merge instead of adding to it.
      expect(stats).toEqual([{ keystrokes: 2 }])
    })

    it('drops an ultra-late event targeting an already-evicted minute instead of persisting a fresh partial entry', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const ts = Date.UTC(2026, 3, 14, 12, 0, 0)

      await ingest(handler, { kind: 'char', key: 'a', ts, keyboard: sampleKeyboard })
      await flushTypingAnalyticsNowForTests()

      // drainAll (used by flushTypingAnalyticsNowForTests) retains entries —
      // only drainClosed evicts (see minute-buffer.ts) — so eviction is
      // driven directly here to simulate the periodic flush pass that
      // would eventually run drainClosed once the wall clock genuinely
      // moves this far past the minute.
      const evictedNow = ts + MINUTE_MS + RETENTION_MS + 1
      getMinuteBufferForTests().drainClosed(evictedNow)

      // An event still targeting the now-evicted minute arrives.
      // ingestEvent passes real Date.now() (pinned here to the same
      // ultra-late instant) as MinuteBuffer.addEvent's nowMs, so this must
      // be dropped rather than starting a fresh partial entry.
      vi.setSystemTime(evictedNow)
      await handler(fakeEvent, { kind: 'char', key: 'a', ts, keyboard: sampleKeyboard })
      await flushTypingAnalyticsNowForTests()

      const conn = getTypingAnalyticsDB().getConnection()
      const stats = conn.prepare('SELECT scope_id, minute_ts, keystrokes FROM typing_minute_stats').all() as StatsRow[]
      // Only the original minute's original count — the ultra-late event
      // was dropped, not persisted as a second, disconnected minute.
      expect(stats).toHaveLength(1)
      expect(stats[0].keystrokes).toBe(1)
    })

    it('keeps updatedAt strictly increasing across two flush passes at the exact same fake instant', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const ts = Date.UTC(2026, 3, 14, 12, 0, 0)

      await ingest(handler, { kind: 'char', key: 'a', ts, keyboard: sampleKeyboard })
      await flushTypingAnalyticsNowForTests()
      const conn = getTypingAnalyticsDB().getConnection()
      const first = conn.prepare('SELECT updated_at FROM typing_minute_stats').get() as { updated_at: number }

      // Same instant as the first flush (ingest() pins the clock to `ts`
      // again) — the DB's strict `>` LWW guard would reject this second
      // pass's row entirely if updatedAt merely tied instead of strictly
      // increasing.
      await ingest(handler, { kind: 'char', key: 'b', ts, keyboard: sampleKeyboard })
      await flushTypingAnalyticsNowForTests()
      const second = conn.prepare('SELECT updated_at FROM typing_minute_stats').get() as { updated_at: number }

      expect(second.updated_at).toBeGreaterThan(first.updated_at)
      // And the second pass's cumulative row actually landed (both chars
      // counted) — proof the tie-break wasn't merely cosmetic.
      const stats = conn.prepare('SELECT keystrokes FROM typing_minute_stats').get() as { keystrokes: number }
      expect(stats.keystrokes).toBe(2)
    })

    it('recovers a failed flush by reopening the drained snapshot instead of losing it', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const ts = Date.UTC(2026, 3, 14, 12, 0, 0)

      await ingest(handler, { kind: 'char', key: 'a', ts, keyboard: sampleKeyboard })
      // Force the cache-apply step to throw after the drain already
      // captured this minute's snapshot (see persistOwnJsonlDay: JSONL
      // append happens first, cache apply second, against this closed
      // connection).
      getTypingAnalyticsDB().close()
      await flushTypingAnalyticsNowForTests()

      // A second keystroke for the same minute arrives before the retry.
      await ingest(handler, { kind: 'char', key: 'b', ts: ts + 500, keyboard: sampleKeyboard })

      resetTypingAnalyticsDBForTests()
      await flushTypingAnalyticsNowForTests()

      // The retry must land BOTH keystrokes — the one from the failed
      // pass (recovered via minuteBuffer.reopenAll()) and the one that
      // arrived after it — not just the second one alone.
      const conn = getTypingAnalyticsDB().getConnection()
      const stats = conn.prepare('SELECT keystrokes FROM typing_minute_stats').get() as { keystrokes: number }
      expect(stats.keystrokes).toBe(2)
    })
  })
})
