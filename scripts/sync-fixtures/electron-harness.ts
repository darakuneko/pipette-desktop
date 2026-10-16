// SPDX-License-Identifier: GPL-2.0-or-later
// The `electron` module of the sync fixture generators: the stub of the
// root Vitest config, with the members the harness (harness.ts) keeps away
// from the real system.

import { vi } from 'vitest'
import * as stub from '../../src/main/__tests__/electron-stub'
import { guardedFetch, harnessPath, recordOpenedUrl } from './harness'

export * from '../../src/main/__tests__/electron-stub'

export const app = {
  ...stub.app,
  getPath: vi.fn((name: string) => harnessPath(name)),
}

export const shell = {
  ...stub.shell,
  openExternal: vi.fn(async (url: string) => {
    recordOpenedUrl(url)
  }),
  openPath: vi.fn(async () => 'sync fixture harness: openPath is not available'),
}

/** A fixed reversible transformation; the OS key store is never used. */
export const safeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((plain: string) => Buffer.from(`fixture-safe-storage:${plain}`, 'utf8')),
  decryptString: vi.fn((encrypted: Buffer) => {
    const text = encrypted.toString('utf8')
    if (!text.startsWith('fixture-safe-storage:')) throw new Error('sync fixture harness: not encrypted by the harness')
    return text.slice('fixture-safe-storage:'.length)
  }),
}

export const net = {
  ...stub.net,
  fetch: vi.fn((input: string | URL | Request, init?: RequestInit) => guardedFetch(globalThis.fetch)(input, init)),
}
