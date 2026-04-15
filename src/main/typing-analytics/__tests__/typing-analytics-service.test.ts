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

const mockMachineId = vi.fn<(original?: boolean) => Promise<string>>()

vi.mock('node-machine-id', () => ({
  default: { machineId: (original?: boolean) => mockMachineId(original) },
  machineId: (original?: boolean) => mockMachineId(original),
}))

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
} from '../typing-analytics-service'
import * as installationIdModule from '../installation-id'
import { resetMachineHashCacheForTests } from '../machine-hash'
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

      const units = notifier.mock.calls.map((c) => c[0]).sort()
      expect(units).toEqual([
        `keyboards/${sampleKeyboard.uid}/typing-analytics`,
        `keyboards/${otherKeyboard.uid}/typing-analytics`,
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
})
