// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// syncHasPendingChanges answers what the backend reports, and
// syncOnPendingChange passes each sync:pending-status event the backend
// emits to the callback, until unsubscribed.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import { syncPendingApi } from '../api/sync-pending'

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

afterEach(() => {
  clearMocks()
})

describe('syncPendingApi', () => {
  it('answers whether anything is pending from the backend', async () => {
    mockIPC((cmd) => (cmd === 'sync_has_pending_changes' ? true : undefined))
    await expect(syncPendingApi.syncHasPendingChanges()).resolves.toBe(true)
  })

  it('passes the status the backend sends until unsubscribed', async () => {
    mockIPC(() => {}, { shouldMockEvents: true })
    const callback = vi.fn()
    const unsubscribe = syncPendingApi.syncOnPendingChange(callback)
    await settle()
    await emit('sync:pending-status', true)
    await emit('sync:pending-status', false)
    unsubscribe()
    await emit('sync:pending-status', true)
    expect(callback.mock.calls).toEqual([[true], [false]])
  })
})
