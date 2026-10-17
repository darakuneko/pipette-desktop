// SPDX-License-Identifier: GPL-2.0-or-later
// The Electron main process's surroundings for the sync interop tests,
// installed before every test file after the harness of the sync fixture
// generators (scripts/sync-fixtures/setup.ts): signed in as one account,
// the machine hash of the userData in use, no typing analytics cache, no
// timers that start passes, and the stores' IPC handlers kept for the
// tests (machine-state.ts).

import { vi } from 'vitest'

vi.mock('../../src/main/ipc-guard', async () => {
  const { handlers } = await import('./machine-state')
  return {
    secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    secureOn: () => {},
  }
})
vi.mock('../../src/main/sync/google-auth', () => ({
  getAuthStatus: async () => ({ authenticated: true }),
  getAccessToken: async () => 'interop-token',
  getAccountSub: async () => 'interop-sub',
}))
// The machine hash as both builds derive it: SHA-256 of the machine id and
// the installation id of the userData in use.
vi.mock('../../src/main/typing-analytics/machine-hash', async () => {
  const { createHash } = await import('node:crypto')
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { app } = await import('electron')
  const { machineEnv } = await import('./machine-state')
  return {
    getMachineHash: vi.fn(async () => {
      const id = readFileSync(join(app.getPath('userData'), 'local', 'installation-id'), 'utf8').trim()
      return createHash('sha256').update(machineEnv.machineId).update(id).digest('hex')
    }),
  }
})
// The typing analytics cache is not used: it names the keyboards a test
// says have typing, and no machine merges another's typing days (their
// keyboards are not on it).
vi.mock('../../src/main/typing-analytics/db/typing-analytics-db', async () => {
  const { machineEnv } = await import('./machine-state')
  return {
    getTypingAnalyticsDB: () => ({
      listLocalKeyboardUids: () => machineEnv.typingUids,
      tombstoneRowsForUidHashInRanges: () => ({ charMinutes: 0, matrixMinutes: 0, minuteStats: 0, sessions: 0 }),
      getConnection: () => ({ transaction: <T>(fn: () => T) => fn }),
    }),
  }
})
vi.mock('../../src/main/sync/typing-deleted-ranges-merge', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/sync/typing-deleted-ranges-merge')>(),
  queueOwnDeletedRangesApply: () => {},
}))
// The passes run when a test says, not from timers.
vi.mock('../../src/main/sync/sync-flush', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/sync/sync-flush')>(),
  scheduleFlushIfPending: () => {},
}))
vi.mock('../../src/main/sync/sync-service', async () => {
  const { markPending } = await import('../../src/main/sync/sync-runtime-state')
  return { notifyChange: (unit: string) => markPending(unit) }
})
vi.mock('../../src/main/utils/broadcast', () => ({ broadcastToAllWindows: () => {} }))
vi.mock('../../src/main/logger', () => ({ log: () => {} }))
vi.mock('../../src/main/app-config', () => ({
  loadAppConfig: vi.fn(() => ({ autoSync: false, defaultAutoAdvance: true })),
  saveAppConfig: vi.fn(async () => undefined),
  getAppConfigStore: vi.fn(() => ({ get: () => false })),
}))
