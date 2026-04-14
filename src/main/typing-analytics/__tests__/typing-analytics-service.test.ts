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

const mockMachineId = vi.fn<(original?: boolean) => Promise<string>>()

vi.mock('node-machine-id', () => ({
  machineId: (original?: boolean) => mockMachineId(original),
}))

import { ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import {
  setupTypingAnalytics,
  setupTypingAnalyticsIpc,
  resetTypingAnalyticsForTests,
  getTypingAnalyticsAggregatorForTests,
  flushTypingAnalyticsNowForTests,
  hasTypingAnalyticsPendingWork,
  flushTypingAnalyticsBeforeQuit,
} from '../typing-analytics-service'
import * as installationIdModule from '../installation-id'
import { resetMachineHashCacheForTests } from '../machine-hash'
import {
  canonicalScopeKey,
  type TypingAnalyticsDailyFile,
} from '../../../shared/types/typing-analytics'
import { dailyFilePath, sessionsFilePath } from '../typing-analytics-paths'
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

/** Canonical scope key for `sampleKeyboard` + mocked OS info, computed lazily. */
function expectedScopeKey(): string {
  const [scope] = getTypingAnalyticsAggregatorForTests().getScopes().values()
  return canonicalScopeKey(scope.scope)
}

describe('typing-analytics-service', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'pipette-typing-analytics-service-test-'))
    resetTypingAnalyticsForTests()
    installationIdModule.resetInstallationIdCacheForTests()
    resetMachineHashCacheForTests()
    mockMachineId.mockReset()
    mockMachineId.mockResolvedValue('fixed-machine-id')
  })

  afterEach(async () => {
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

    it('aggregates a char event into the active scope bucket', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      await handler(fakeEvent, { kind: 'char', key: 'a', ts: 1000, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'char', key: 'a', ts: 1001, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'char', key: 'b', ts: 1002, keyboard: sampleKeyboard })

      const scopes = getTypingAnalyticsAggregatorForTests().getScopes()
      expect(scopes.size).toBe(1)
      const entry = scopes.get(expectedScopeKey())!
      expect(entry.charCounts).toEqual({ a: 2, b: 1 })
      expect(entry.scope.keyboard).toEqual(sampleKeyboard)
    })

    it('aggregates a matrix event into per-position counts', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      await handler(fakeEvent, {
        kind: 'matrix', row: 2, col: 4, layer: 1, keycode: 0x4015, ts: 2000, keyboard: sampleKeyboard,
      })
      await handler(fakeEvent, {
        kind: 'matrix', row: 2, col: 4, layer: 1, keycode: 0x4015, ts: 2001, keyboard: sampleKeyboard,
      })

      const entry = getTypingAnalyticsAggregatorForTests().getScopes().get(expectedScopeKey())!
      expect(entry.matrixCounts['2,4,1']).toEqual({ count: 2, keycode: 0x4015 })
    })

    it('creates separate scope buckets for different keyboards', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const otherKeyboard = { ...sampleKeyboard, uid: '0xCCDD', vendorId: 0x1234 }

      await handler(fakeEvent, { kind: 'char', key: 'a', ts: 1, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'char', key: 'b', ts: 2, keyboard: otherKeyboard })

      expect(getTypingAnalyticsAggregatorForTests().getScopes().size).toBe(2)
    })

    it('persists aggregated counts to a daily file when flushed', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      await handler(fakeEvent, { kind: 'char', key: 'a', ts: Date.now(), keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'char', key: 'a', ts: Date.now(), keyboard: sampleKeyboard })
      await handler(fakeEvent, {
        kind: 'matrix', row: 0, col: 3, layer: 0, keycode: 0x04,
        ts: Date.now(), keyboard: sampleKeyboard,
      })

      await flushTypingAnalyticsNowForTests()

      const today = new Date().toISOString().slice(0, 10)
      const path = dailyFilePath(sampleKeyboard.uid, today)
      const file = JSON.parse(await readFile(path, 'utf-8')) as TypingAnalyticsDailyFile
      const [entry] = Object.values(file.scopes)
      expect(entry.charCounts).toEqual({ a: 2 })
      expect(entry.matrixCounts['0,3,0']).toEqual({ count: 1, keycode: 0x04 })

      // The aggregator is cleared after a successful flush.
      expect(getTypingAnalyticsAggregatorForTests().isEmpty()).toBe(true)
    })

    it('writes a session record when the flush IPC closes the session', async () => {
      setupTypingAnalyticsIpc()
      const eventHandler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const flushHandler = getHandler(IpcChannels.TYPING_ANALYTICS_FLUSH)

      const start = Date.UTC(2026, 3, 14, 10, 0, 0)
      const end = Date.UTC(2026, 3, 14, 10, 0, 5)
      await eventHandler(fakeEvent, { kind: 'char', key: 'a', ts: start, keyboard: sampleKeyboard })
      await eventHandler(fakeEvent, { kind: 'char', key: 'b', ts: end, keyboard: sampleKeyboard })

      await flushHandler(fakeEvent, sampleKeyboard.uid)

      const path = sessionsFilePath(sampleKeyboard.uid, '2026-04-14')
      const lines = (await readFile(path, 'utf-8')).trim().split('\n')
      expect(lines).toHaveLength(1)
      const session = JSON.parse(lines[0]) as { keystrokeCount: number; start: string; end: string }
      expect(session.keystrokeCount).toBe(2)
      expect(session.start).toBe(new Date(start).toISOString())
      expect(session.end).toBe(new Date(end).toISOString())
    })

    it('routes events from different keyboards to separate daily files', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)
      const otherKeyboard = { ...sampleKeyboard, uid: '0xCCDD', vendorId: 0x1234 }

      await handler(fakeEvent, { kind: 'char', key: 'a', ts: Date.now(), keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'char', key: 'a', ts: Date.now(), keyboard: otherKeyboard })

      await flushTypingAnalyticsNowForTests()

      const today = new Date().toISOString().slice(0, 10)
      const a = JSON.parse(await readFile(dailyFilePath(sampleKeyboard.uid, today), 'utf-8'))
      const b = JSON.parse(await readFile(dailyFilePath(otherKeyboard.uid, today), 'utf-8'))
      expect(Object.keys(a.scopes)).toHaveLength(1)
      expect(Object.keys(b.scopes)).toHaveLength(1)
    })

    it('reports pending work while only an active session exists', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      await handler(fakeEvent, { kind: 'char', key: 'a', ts: Date.now(), keyboard: sampleKeyboard })
      await flushTypingAnalyticsNowForTests()

      // After a successful flush the aggregator and queued sessions are
      // empty, but the active session is still open and must be picked up by
      // the before-quit finalizer.
      expect(getTypingAnalyticsAggregatorForTests().isEmpty()).toBe(true)
      expect(hasTypingAnalyticsPendingWork()).toBe(true)
    })

    it('persists the active session via flushTypingAnalyticsBeforeQuit', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      const ts = Date.UTC(2026, 3, 14, 12, 0, 0)
      await handler(fakeEvent, { kind: 'char', key: 'a', ts, keyboard: sampleKeyboard })
      await flushTypingAnalyticsNowForTests()
      // The session is still open at this point; quit-time finalize should
      // close it and append the record.
      await flushTypingAnalyticsBeforeQuit()

      const sessionsPath = sessionsFilePath(sampleKeyboard.uid, '2026-04-14')
      const lines = (await readFile(sessionsPath, 'utf-8')).trim().split('\n')
      expect(lines).toHaveLength(1)
      const session = JSON.parse(lines[0]) as { keystrokeCount: number }
      expect(session.keystrokeCount).toBe(1)
      expect(hasTypingAnalyticsPendingWork()).toBe(false)
    })

    it('reports pending work while a flush is mid-write so before-quit waits', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      await handler(fakeEvent, { kind: 'char', key: 'a', ts: Date.now(), keyboard: sampleKeyboard })

      // Kick off a flush but don't await — the chain holds the in-flight pass.
      const inflight = flushTypingAnalyticsNowForTests()

      // While the flush is mid-write the live state is already cleared by
      // the snapshot, but the in-flight counter must still surface as work.
      expect(hasTypingAnalyticsPendingWork()).toBe(true)

      await inflight
      // After the flush settles only the still-open active session keeps the
      // pending flag true, exercising the post-snapshot path.
      expect(hasTypingAnalyticsPendingWork()).toBe(true)
    })

    it('serializes concurrent flush callers so quit waits for the in-flight pass', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      await handler(fakeEvent, { kind: 'char', key: 'a', ts: Date.now(), keyboard: sampleKeyboard })

      // Kick off two concurrent flushes; both promises must resolve only
      // after their own pass completes (no early-return short circuit).
      const a = flushTypingAnalyticsNowForTests()
      const b = flushTypingAnalyticsNowForTests()
      await Promise.all([a, b])

      // The second pass would observe the (already empty) state and become
      // a no-op, but the chain ensures it cannot resolve until the first
      // pass has finished writing — proving quit-time callers will wait too.
      const today = new Date().toISOString().slice(0, 10)
      const file = JSON.parse(await readFile(dailyFilePath(sampleKeyboard.uid, today), 'utf-8'))
      expect(Object.keys(file.scopes)).toHaveLength(1)
    })

    it('silently drops malformed payloads', async () => {
      setupTypingAnalyticsIpc()
      const handler = getHandler(IpcChannels.TYPING_ANALYTICS_EVENT)

      await handler(fakeEvent, null)
      await handler(fakeEvent, 'not-an-object')
      await handler(fakeEvent, { kind: 'char', ts: 1000, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'char', key: 'a', keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'matrix', row: 0, col: 0, layer: 0, keycode: 1, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'unknown', key: 'a', ts: 1000, keyboard: sampleKeyboard })
      await handler(fakeEvent, { kind: 'matrix', row: -1, col: 0, layer: 0, keycode: 1, ts: 1000, keyboard: sampleKeyboard })
      // Missing keyboard field
      await handler(fakeEvent, { kind: 'char', key: 'a', ts: 1000 })
      // Invalid keyboard shape (empty uid)
      await handler(fakeEvent, { kind: 'char', key: 'a', ts: 1000, keyboard: { uid: '', vendorId: 0, productId: 0, productName: '' } })

      expect(getTypingAnalyticsAggregatorForTests().isEmpty()).toBe(true)
    })
  })
})
