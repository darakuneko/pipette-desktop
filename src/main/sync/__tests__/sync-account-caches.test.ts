// SPDX-License-Identifier: GPL-2.0-or-later
//
// forgetAccountCaches on the real Hub token, password-check and
// sync-format state.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData' },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: vi.fn() },
}))

vi.mock('../../utils/broadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}))

import { forgetAccountCaches } from '../sync-account-caches'
import { hubAuthState } from '../../hub/hub-ipc-token'
import { syncRuntime, resetSyncRuntimeForTests } from '../sync-runtime-state'
import { getCachedSyncFormatStatus, noteSyncFormatUpdateRequired, clearSyncFormatStatus } from '../sync-format-status'
import { syncFormatGeneration } from '../sync-format'

beforeEach(() => {
  resetSyncRuntimeForTests()
  clearSyncFormatStatus()
})

describe('forgetAccountCaches', () => {
  it('forgets the Hub JWT, the password-check and the sync-format status with the created marker', () => {
    hubAuthState.cachedHubJwt = { token: 'hub-jwt', expiresAt: Date.now() + 60_000 }
    const hubGeneration = hubAuthState.cacheGeneration
    syncRuntime.validatedPasswordCheck = { id: 'check-id', modifiedTime: '2026-10-01T00:00:00.000Z' }
    syncRuntime.passwordCheckCreated = { file: { id: 'check-id', modifiedTime: '2026-10-01T00:00:00.000Z' }, at: Date.now() }
    syncRuntime.syncFormatMarkerCreatedAt = Date.now()
    noteSyncFormatUpdateRequired(3, syncFormatGeneration())
    const formatGeneration = syncFormatGeneration()
    expect(getCachedSyncFormatStatus()).not.toBeNull()

    forgetAccountCaches()

    expect(hubAuthState.cachedHubJwt).toBeNull()
    expect(hubAuthState.cacheGeneration).toBe(hubGeneration + 1)
    expect(syncRuntime.validatedPasswordCheck).toBeNull()
    expect(syncRuntime.passwordCheckCreated).toBeNull()
    expect(syncRuntime.syncFormatMarkerCreatedAt).toBeNull()
    expect(syncFormatGeneration()).toBe(formatGeneration + 1)
    expect(getCachedSyncFormatStatus()).toBeNull()
  })
})
