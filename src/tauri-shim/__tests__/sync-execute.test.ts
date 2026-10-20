// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The sync of a scope runs in the backend (src-tauri/src/sync_commands/execute.rs);
// its progress and the units a merge rewrote come back as events on the
// channels of src/shared/ipc/channels.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import { syncExecuteApi } from '../api/sync-execute'
import type { SyncProgress } from '../../shared/types/sync'

afterEach(() => {
  clearMocks()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('sync passes', () => {
  it('sends the direction and the scope, leaving out a scope not given', async () => {
    const calls: Array<[string, unknown]> = []
    mockIPC((cmd, args) => {
      calls.push([cmd, args && Object.fromEntries(Object.entries(args as object))])
      return { success: true, status: 'partial', error: '1 sync unit(s) failed' }
    })
    await expect(syncExecuteApi.syncExecute('download')).resolves.toEqual({
      success: true,
      status: 'partial',
      error: '1 sync unit(s) failed',
    })
    await syncExecuteApi.syncExecute('upload', { favorites: true, keyboard: 'kb' })
    expect(calls).toEqual([
      ['sync_execute', { direction: 'download' }],
      ['sync_execute', { direction: 'upload', scope: { favorites: true, keyboard: 'kb' } }],
    ])
  })

  it('passes each progress report and each applied unit until unsubscribed', async () => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const progress = vi.fn()
    const applied = vi.fn()
    const stopProgress = syncExecuteApi.syncOnProgress(progress)
    const stopApplied = syncExecuteApi.syncOnUnitApplied(applied)
    await settle()
    const report: SyncProgress = { direction: 'upload', status: 'syncing', syncUnit: 'favorites/macro', current: 1, total: 2 }
    await emit('sync:progress', report)
    await emit('sync:unit-applied', { syncUnit: 'keyboards/kb/settings' })
    stopProgress()
    stopApplied()
    await emit('sync:progress', report)
    await emit('sync:unit-applied', { syncUnit: 'favorites/macro' })
    expect(progress.mock.calls).toEqual([[report]])
    expect(applied.mock.calls).toEqual([['keyboards/kb/settings']])
  })
})
