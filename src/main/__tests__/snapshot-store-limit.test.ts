// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

// Mock electron
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock-user-data') },
  ipcMain: {
    handle: vi.fn(),
  },
}))

// Mock sync-service
vi.mock('../sync/sync-service', () => ({
  notifyChange: vi.fn(),
}))

vi.mock('../ipc-guard', async () => {
  const { ipcMain } = await import('electron')
  return { secureHandle: ipcMain.handle }
})

// Mock fs/promises
const mockMkdir = vi.fn().mockResolvedValue(undefined)
const mockWriteFile = vi.fn().mockResolvedValue(undefined)
const mockReadFile = vi.fn()
vi.mock('node:fs/promises', () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}))

import { ipcMain } from 'electron'
import { setupSnapshotStore } from '../snapshot-store'

describe('snapshot-store 30-entry limit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ipcMain.handle as any).mockClear()
    setupSnapshotStore()
  })

  function getSaveHandler(): (...args: unknown[]) => Promise<unknown> {
    const calls = vi.mocked(ipcMain.handle).mock.calls
    const saveCall = calls.find(([channel]) => channel === 'snapshot-store:save')
    expect(saveCall).toBeDefined()
    return saveCall![1] as (...args: unknown[]) => Promise<unknown>
  }

  function makeIndex(activeCount: number, deletedCount = 0) {
    const entries = []
    for (let i = 0; i < activeCount; i++) {
      entries.push({
        id: `entry-${i}`,
        label: `Label ${i}`,
        filename: `keyboard_2025-01-01T00-00-0${i}.000Z.pipette`,
        savedAt: '2025-01-01T00:00:00.000Z',
      })
    }
    for (let i = 0; i < deletedCount; i++) {
      entries.push({
        id: `deleted-${i}`,
        label: `Deleted ${i}`,
        filename: `keyboard_2025-01-01T00-00-0${i}.000Z.pipette`,
        savedAt: '2025-01-01T00:00:00.000Z',
        deletedAt: '2025-01-02T00:00:00.000Z',
      })
    }
    return { uid: 'test-uid', entries }
  }

  it('rejects save when 30 active entries exist', async () => {
    const index = makeIndex(30)
    const indexPath = join('/mock-user-data', 'sync', 'keyboards', 'test-uid', 'snapshots', 'index.json')
    mockReadFile.mockImplementation((path: string) => {
      if (path === indexPath) return Promise.resolve(JSON.stringify(index))
      return Promise.reject(new Error('ENOENT'))
    })

    const handler = getSaveHandler()
    const result = await handler({}, 'test-uid', '{}', 'keyboard', 'New Entry')

    expect(result).toEqual({ success: false, error: 'max entries reached' })
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('allows save when active entries are below limit', async () => {
    const index = makeIndex(29)
    const indexPath = join('/mock-user-data', 'sync', 'keyboards', 'test-uid', 'snapshots', 'index.json')
    mockReadFile.mockImplementation((path: string) => {
      if (path === indexPath) return Promise.resolve(JSON.stringify(index))
      return Promise.reject(new Error('ENOENT'))
    })

    const handler = getSaveHandler()
    const result = await handler({}, 'test-uid', '{"keymap":{}}', 'keyboard', 'Entry 30') as { success: boolean }

    expect(result.success).toBe(true)
  })

  it('ignores deleted entries when counting', async () => {
    const index = makeIndex(25, 10)
    const indexPath = join('/mock-user-data', 'sync', 'keyboards', 'test-uid', 'snapshots', 'index.json')
    mockReadFile.mockImplementation((path: string) => {
      if (path === indexPath) return Promise.resolve(JSON.stringify(index))
      return Promise.reject(new Error('ENOENT'))
    })

    const handler = getSaveHandler()
    const result = await handler({}, 'test-uid', '{"keymap":{}}', 'keyboard', 'New Entry') as { success: boolean }

    expect(result.success).toBe(true)
  })
})
