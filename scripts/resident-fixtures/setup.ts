// SPDX-License-Identifier: GPL-2.0-or-later
// Installs the resident fixture harness (harness.ts) before every test file.
// Every module src/main/index.ts imports is replaced except the ones the
// resident behaviour lives in (app-behavior.ts, notification-store.ts,
// window-bounds.ts, csp.ts and the shared types): the stores and IPC setups
// do nothing, the app config answers the harness's values and records what
// is saved, the logger records, and ipc-guard keeps the handlers for the
// generators to call.

import { afterEach, beforeEach, vi } from 'vitest'
import { DEFAULT_APP_CONFIG } from '../../src/shared/types/app-config'
import { harnessHome, harnessState, record, refusedFetch, resetHarness } from './harness'

// harness.ts imports `node:os` itself, so the real HOME goes straight onto
// `globalThis` (the key of harness.ts's realHome) instead of through it.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  ;(globalThis as unknown as Record<symbol, string>)[Symbol.for('pipette.resident-fixtures.real-home')] = actual.homedir()
  const overrides = { homedir: () => harnessHome() }
  return { ...actual, ...overrides, default: { ...actual, ...overrides } }
})

vi.mock('../../src/main/logger', () => ({
  log: (level: string, message: string) => {
    harnessState().logs.push({ level, message })
  },
  logHidPacket: () => undefined,
}))

vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    harnessState().handlers.set(channel, handler)
  },
  secureOn: (channel: string, handler: (...args: unknown[]) => unknown) => {
    harnessState().handlers.set(channel, handler)
  },
}))

// electron-store would load the real `electron` package. The constants and
// hasSavedWindowPosition are copies of app-config.ts.
vi.mock('../../src/main/app-config', () => ({
  MIN_WIDTH: 1280,
  MIN_HEIGHT: 1024,
  hasSavedWindowPosition: (state: { x: number; y: number }) => state.x !== -1 || state.y !== -1,
  loadAppConfig: () => ({ ...DEFAULT_APP_CONFIG, ...harnessState().config }),
  loadWindowState: () => ({ ...harnessState().windowState }),
  saveWindowState: (state: unknown) => {
    record('saveWindowState', state)
  },
  onAppConfigChange: (listener: (key: string, value: unknown) => void) => {
    harnessState().configListeners.push(listener)
  },
  setupAppConfigIpc: () => undefined,
}))

vi.mock('../../src/main/process-gone-log', () => ({
  registerProcessGoneLogging: () => undefined,
  registerChildProcessGoneLogging: () => undefined,
}))

vi.mock('../../src/main/typing-analytics/typing-analytics-service', () => ({
  setupTypingAnalytics: async () => undefined,
  setupTypingAnalyticsIpc: () => undefined,
  hasTypingAnalyticsPendingWork: () => false,
  flushTypingAnalyticsBeforeQuit: async () => undefined,
  setTypingAnalyticsSyncNotifier: () => undefined,
}))

vi.mock('../../src/main/sync/sync-service', () => ({
  registerPreSyncQuitFinalizer: () => undefined,
  notifyChange: () => undefined,
}))

vi.mock('../../src/main/virtual-device', () => ({
  isVirtualDeviceEnabled: () => false,
  getVirtualDeviceController: () => {
    throw new Error('resident fixture harness: no virtual device')
  },
}))

vi.mock('../../src/main/file-io', () => ({ setupFileIO: () => undefined }))
vi.mock('../../src/main/snapshot-store', () => ({ setupSnapshotStore: () => undefined }))
vi.mock('../../src/main/analyze-filter-store', () => ({ setupAnalyzeFilterStore: () => undefined }))
vi.mock('../../src/main/favorite-store', () => ({ setupFavoriteStore: () => undefined }))
vi.mock('../../src/main/key-label-ipc', () => ({ setupKeyLabelStore: () => undefined }))
vi.mock('../../src/main/typing-test-text-ipc', () => ({ setupTypingTestTextStore: () => undefined }))
vi.mock('../../src/main/typing-run-log-ipc', () => ({ setupTypingRunLogStore: () => undefined }))
vi.mock('../../src/main/i18n-pack-ipc', () => ({ setupI18nPackStore: () => undefined }))
vi.mock('../../src/main/theme-pack-ipc', () => ({ setupThemePackStore: () => undefined }))
vi.mock('../../src/main/hid-ipc', () => ({ setupHidIpc: () => undefined }))
vi.mock('../../src/main/pipette-settings-store', () => ({ setupPipetteSettingsStore: () => undefined }))
vi.mock('../../src/main/language-store', () => ({ setupLanguageStore: () => undefined }))
vi.mock('../../src/main/aozora/aozora-ipc', () => ({ setupAozoraIpc: () => undefined }))
vi.mock('../../src/main/sync/sync-ipc', () => ({ setupSyncIpc: () => undefined }))
vi.mock('../../src/main/hub/hub-ipc', () => ({ setupHubIpc: () => undefined }))
vi.mock('../../src/main/hub/i18n-startup-sync', () => ({ startI18nStartupSync: () => undefined }))
vi.mock('../../src/main/lzma', () => ({ setupLzmaIpc: () => undefined }))

globalThis.fetch = refusedFetch as typeof fetch

// Variables the resident code reads; each test starts without them and sets
// what its table needs.
const ENV = ['ELECTRON_RENDERER_URL', 'APPIMAGE', 'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE'] as const
const savedEnv = Object.fromEntries(ENV.map((name) => [name, process.env[name]]))

beforeEach(() => {
  resetHarness()
  for (const name of ENV) delete process.env[name]
})

afterEach(() => {
  vi.useRealTimers()
  resetHarness()
  for (const name of ENV) {
    const value = savedEnv[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})
