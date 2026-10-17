// SPDX-License-Identifier: GPL-2.0-or-later
// Installs the Hub fixture harness (hub-harness.ts) before every test
// file, after the sync fixture harness (../sync-fixtures/setup.ts):
// Google's id_token and the machine hash are fixed, the change notices, broadcasts and log lines
// are recorded instead of acting, the IPC handlers are kept for the
// generators to call, and the Hub base points at 127.0.0.1.

import { afterEach, beforeEach, vi } from 'vitest'
import { FIXED_MACHINE_HASH, HUB_BASE, currentIdToken, recordEvent, recordLog, recordNotified, resetHubHarness } from './hub-harness'
import { registerHandler } from './ipc-handlers'

vi.mock('../../src/main/sync/google-auth', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getIdToken: async () => currentIdToken() }
})

// node-machine-id would read this machine's id.
vi.mock('../../src/main/typing-analytics/machine-hash', () => ({
  getMachineHash: async () => FIXED_MACHINE_HASH,
  resetMachineHashCacheForTests: () => undefined,
}))

// The whole sync service stays out: the stores only call notifyChange.
vi.mock('../../src/main/sync/sync-service', () => ({
  notifyChange: (unit: string) => {
    recordNotified(unit)
  },
}))

// electron-store would load the real `electron` package; any read of the
// app config through this stub fails the generator.
vi.mock('../../src/main/app-config', () => {
  const unavailable = (): never => {
    throw new Error('hub fixture harness: the app config is not available')
  }
  return {
    MIN_WIDTH: 1280,
    MIN_HEIGHT: 1024,
    hasSavedWindowPosition: unavailable,
    getAppConfigStore: unavailable,
    loadAppConfig: unavailable,
    saveAppConfig: unavailable,
    loadWindowState: unavailable,
    saveWindowState: unavailable,
    onAppConfigChange: () => undefined,
    setupAppConfigIpc: unavailable,
  }
})

vi.mock('../../src/main/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, ...args: unknown[]) => {
    recordEvent(channel, args)
  },
}))

vi.mock('../../src/main/logger', () => ({
  log: (level: string, message: string) => {
    recordLog(level, message)
  },
  logHidPacket: () => undefined,
  getLogPath: () => {
    throw new Error('hub fixture harness: no log file')
  },
}))

vi.mock('../../src/main/ipc-guard', () => ({
  isAllowedOrigin: () => true,
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    registerHandler(channel, handler)
  },
  secureOn: (channel: string, handler: (...args: unknown[]) => unknown) => {
    registerHandler(channel, handler)
  },
}))

const HUB_ENV = ['PIPETTE_HUB_URL', 'PIPETTE_HUB_TEST', 'PIPETTE_HUB_TEST_ACCOUNT', 'ELECTRON_RENDERER_URL'] as const
const savedEnv = Object.fromEntries(HUB_ENV.map((name) => [name, process.env[name]]))

function restoreEnv(): void {
  for (const name of HUB_ENV) {
    const value = savedEnv[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

beforeEach(() => {
  resetHubHarness()
  for (const name of HUB_ENV) delete process.env[name]
  process.env.PIPETTE_HUB_URL = HUB_BASE
  process.env.PIPETTE_HUB_TEST = '1'
})

afterEach(() => {
  resetHubHarness()
  restoreEnv()
})
