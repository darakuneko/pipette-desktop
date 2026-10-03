// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SyncFormatStatus } from '../../../shared/types/sync'

const mockGetSyncFormatStatus = vi.hoisted(() => vi.fn<() => Promise<SyncFormatStatus>>())
const mockLog = vi.hoisted(() => vi.fn())
const formatGeneration = vi.hoisted(() => ({ value: 0 }))

vi.mock('../sync-format', () => ({
  getSyncFormatStatus: () => mockGetSyncFormatStatus(),
  syncFormatGeneration: () => formatGeneration.value,
  forgetCreatedSyncFormatMarker: () => { formatGeneration.value++ },
}))
vi.mock('../../logger', () => ({ log: (...args: unknown[]) => mockLog(...args) }))

import {
  getCachedSyncFormatStatus,
  refreshSyncFormatStatus,
  clearSyncFormatStatus,
  noteSyncFormatUpdateRequired,
  setSyncFormatStatusListener,
} from '../sync-format-status'
import { SYNC_FORMAT_VERSION } from '../../../shared/constants/sync-format'

const OK: SyncFormatStatus = { required: SYNC_FORMAT_VERSION, supported: SYNC_FORMAT_VERSION, updateRequired: false }
const NEWER: SyncFormatStatus = { required: SYNC_FORMAT_VERSION + 1, supported: SYNC_FORMAT_VERSION, updateRequired: true }

function deferred(): { promise: Promise<SyncFormatStatus>; resolve: (s: SyncFormatStatus) => void } {
  let resolve!: (s: SyncFormatStatus) => void
  const promise = new Promise<SyncFormatStatus>((r) => { resolve = r })
  return { promise, resolve }
}

const changes: Array<SyncFormatStatus | null> = []

describe('sync-format-status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setSyncFormatStatusListener(null)
    clearSyncFormatStatus()
    changes.length = 0
    setSyncFormatStatusListener((status) => changes.push(status))
  })

  it('is unknown until refreshed', () => {
    expect(getCachedSyncFormatStatus()).toBeNull()
  })

  it('refresh stores and returns the status from Drive', async () => {
    mockGetSyncFormatStatus.mockResolvedValueOnce(NEWER)

    expect(await refreshSyncFormatStatus()).toEqual(NEWER)
    expect(getCachedSyncFormatStatus()).toEqual(NEWER)
  })

  it('a failed refresh is logged, never thrown, and keeps the last status', async () => {
    mockGetSyncFormatStatus.mockResolvedValueOnce(OK)
    await refreshSyncFormatStatus()
    mockGetSyncFormatStatus.mockRejectedValueOnce(new Error('offline'))

    expect(await refreshSyncFormatStatus()).toEqual(OK)
    expect(mockLog).toHaveBeenCalledWith('warn', expect.stringContaining('offline'))
  })

  it('concurrent refreshes share one Drive listing', async () => {
    const listing = deferred()
    mockGetSyncFormatStatus.mockReturnValueOnce(listing.promise)

    const a = refreshSyncFormatStatus()
    const b = refreshSyncFormatStatus()
    listing.resolve(OK)

    expect(await a).toEqual(OK)
    expect(await b).toEqual(OK)
    expect(mockGetSyncFormatStatus).toHaveBeenCalledTimes(1)
  })

  it('clear forgets the status and the marker this process created', async () => {
    mockGetSyncFormatStatus.mockResolvedValueOnce(NEWER)
    await refreshSyncFormatStatus()
    const before = formatGeneration.value

    clearSyncFormatStatus()

    expect(getCachedSyncFormatStatus()).toBeNull()
    expect(formatGeneration.value).toBe(before + 1)
  })

  it('a refresh that finishes after clear stores nothing, and the next refresh lists again', async () => {
    const stale = deferred()
    mockGetSyncFormatStatus.mockReturnValueOnce(stale.promise)
    const staleRun = refreshSyncFormatStatus()

    clearSyncFormatStatus()
    mockGetSyncFormatStatus.mockResolvedValueOnce(OK)
    const fresh = refreshSyncFormatStatus()
    stale.resolve(NEWER)

    expect(await staleRun).toBeNull()
    expect(await fresh).toEqual(OK)
    expect(getCachedSyncFormatStatus()).toEqual(OK)
  })

  it('a blocked entry point marks the status as needing an update', () => {
    noteSyncFormatUpdateRequired(SYNC_FORMAT_VERSION + 2, formatGeneration.value)

    expect(getCachedSyncFormatStatus()).toEqual({
      required: SYNC_FORMAT_VERSION + 2,
      supported: SYNC_FORMAT_VERSION,
      updateRequired: true,
    })
  })

  it('a refresh that started before a block is noted does not overwrite it', async () => {
    const listing = deferred()
    mockGetSyncFormatStatus.mockReturnValueOnce(listing.promise)
    const run = refreshSyncFormatStatus()

    noteSyncFormatUpdateRequired(SYNC_FORMAT_VERSION + 1, formatGeneration.value)
    listing.resolve(OK)

    expect(await run).toEqual(NEWER)
    expect(getCachedSyncFormatStatus()).toEqual(NEWER)
  })

  it('a block from a pass that started before sign-out is ignored', () => {
    const passGeneration = formatGeneration.value

    clearSyncFormatStatus()
    noteSyncFormatUpdateRequired(SYNC_FORMAT_VERSION + 1, passGeneration)

    expect(getCachedSyncFormatStatus()).toBeNull()
  })

  describe('change events', () => {
    it('reports a refresh result, a block and a clear', async () => {
      mockGetSyncFormatStatus.mockResolvedValueOnce(OK)
      await refreshSyncFormatStatus()
      noteSyncFormatUpdateRequired(SYNC_FORMAT_VERSION + 1, formatGeneration.value)
      clearSyncFormatStatus()

      expect(changes).toEqual([OK, NEWER, null])
    })

    it('reports nothing when the status stays the same', async () => {
      noteSyncFormatUpdateRequired(SYNC_FORMAT_VERSION + 1, formatGeneration.value)
      noteSyncFormatUpdateRequired(SYNC_FORMAT_VERSION + 1, formatGeneration.value)
      mockGetSyncFormatStatus.mockResolvedValueOnce(NEWER)
      await refreshSyncFormatStatus()
      clearSyncFormatStatus()
      clearSyncFormatStatus()

      expect(changes).toEqual([NEWER, null])
    })

    it('reports nothing for an ignored refresh or block', async () => {
      const stale = deferred()
      mockGetSyncFormatStatus.mockReturnValueOnce(stale.promise)
      const run = refreshSyncFormatStatus()
      const passGeneration = formatGeneration.value
      noteSyncFormatUpdateRequired(SYNC_FORMAT_VERSION + 1, passGeneration)
      clearSyncFormatStatus()
      changes.length = 0

      noteSyncFormatUpdateRequired(SYNC_FORMAT_VERSION + 1, passGeneration)
      stale.resolve(OK)
      await run

      expect(changes).toEqual([])
    })
  })
})
