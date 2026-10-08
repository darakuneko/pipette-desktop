// SPDX-License-Identifier: GPL-2.0-or-later
//
// Focused coverage for pack-bundle-merge.ts: a malformed remote `metas`
// field (not an array, or missing entirely) must throw
// MalformedSyncBundleError so the sync poll's unchanged-revision skip
// applies; the roster merge forgets the body revisions it still needs; a
// body apply queues the roster; roster units run before every other unit.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../i18n-pack-store', () => ({
  mergeSyncedIndex: vi.fn(),
  applySyncedPackBody: vi.fn(),
}))

vi.mock('../../theme-pack-store', () => ({
  mergeSyncedIndex: vi.fn(),
  applySyncedPackBody: vi.fn(),
}))

vi.mock('../sync-service', () => ({ notifyChange: vi.fn() }))

vi.mock('../../utils/broadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}))

import { mergePackBodyBundle, mergePackIndexBundle, markPackRosterSynced, settlePackIndexUnitsFirst } from '../pack-bundle-merge'
import { notifyChange } from '../sync-service'
import { syncRuntime } from '../sync-runtime-state'
import { applySyncedPackBody as applySyncedI18nPackBody } from '../../i18n-pack-store'
import { MalformedSyncBundleError } from '../merge'
import { mergeSyncedIndex as mergeSyncedI18nIndex } from '../../i18n-pack-store'
import { mergeSyncedIndex as mergeSyncedThemeIndex } from '../../theme-pack-store'
import { I18N_INDEX_SYNC_UNIT } from '../../../shared/types/i18n-store'
import { THEME_INDEX_SYNC_UNIT } from '../../../shared/types/theme-store'
import type { SyncBundle } from '../../../shared/types/sync'

function makeBundle(index: unknown): SyncBundle {
  return { type: 'i18n-index', key: 'i18n-index', index, files: {} } as unknown as SyncBundle
}

describe('mergePackIndexBundle — malformed metas field', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws MalformedSyncBundleError when remote index.metas is not an array (i18n)', async () => {
    const bundle = makeBundle({ metas: 'not-an-array' })
    await expect(mergePackIndexBundle(I18N_INDEX_SYNC_UNIT, bundle)).rejects.toThrow(MalformedSyncBundleError)
    expect(mergeSyncedI18nIndex).not.toHaveBeenCalled()
  })

  it('throws MalformedSyncBundleError when remote index.metas is missing entirely (i18n)', async () => {
    const bundle = makeBundle({})
    await expect(mergePackIndexBundle(I18N_INDEX_SYNC_UNIT, bundle)).rejects.toThrow(MalformedSyncBundleError)
    expect(mergeSyncedI18nIndex).not.toHaveBeenCalled()
  })

  it('throws MalformedSyncBundleError when remote index.metas is not an array (theme)', async () => {
    const bundle = makeBundle({ metas: { not: 'an array' } })
    await expect(mergePackIndexBundle(THEME_INDEX_SYNC_UNIT, bundle)).rejects.toThrow(MalformedSyncBundleError)
    expect(mergeSyncedThemeIndex).not.toHaveBeenCalled()
  })

  it('still merges normally when metas is a valid (possibly empty) array', async () => {
    vi.mocked(mergeSyncedI18nIndex).mockResolvedValue({ applied: true, remoteNeedsUpdate: false, bodyFetchIds: [] })
    const bundle = makeBundle({ metas: [] })

    const result = await mergePackIndexBundle(I18N_INDEX_SYNC_UNIT, bundle)

    expect(result).toBe(false)
    expect(mergeSyncedI18nIndex).toHaveBeenCalledWith([])
  })

  it('propagates the merge result even with non-empty, well-formed metas', async () => {
    vi.mocked(mergeSyncedThemeIndex).mockResolvedValue({ applied: true, remoteNeedsUpdate: true, bodyFetchIds: [] })
    const bundle = makeBundle({ metas: [{ id: 'a' }] })

    const result = await mergePackIndexBundle(THEME_INDEX_SYNC_UNIT, bundle)

    expect(result).toBe(true)
    expect(mergeSyncedThemeIndex).toHaveBeenCalledWith([{ id: 'a' }])
  })
})

describe('pack roster and body units', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    syncRuntime.lastKnownRemoteState.clear()
    syncRuntime.syncedPackRosters.clear()
  })

  it('forgets the recorded revision of every body the merged roster still needs', async () => {
    syncRuntime.lastKnownRemoteState.set('i18n_packs_p1.enc', { id: 'x', modifiedTime: 'm' })
    syncRuntime.lastKnownRemoteState.set('i18n_packs_p2.enc', { id: 'y', modifiedTime: 'm' })
    vi.mocked(mergeSyncedI18nIndex).mockResolvedValue({ applied: true, remoteNeedsUpdate: false, bodyFetchIds: ['p1'] })
    await mergePackIndexBundle(I18N_INDEX_SYNC_UNIT, makeBundle({ metas: [] }))
    expect(syncRuntime.lastKnownRemoteState.has('i18n_packs_p1.enc')).toBe(false)
    expect(syncRuntime.lastKnownRemoteState.has('i18n_packs_p2.enc')).toBe(true)
  })

  it('queues the roster after applying a remote body, and passes whether the roster was synced', async () => {
    vi.mocked(applySyncedI18nPackBody).mockResolvedValue('applied')
    const bundle = { type: 'i18n-pack', key: 'p1', index: { metas: [] }, files: {} } as unknown as SyncBundle
    expect(await mergePackBodyBundle({ isTheme: false, packId: 'p1' }, bundle, 'm')).toBe(false)
    expect(vi.mocked(applySyncedI18nPackBody).mock.calls[0][3]).toBe(false)
    expect(notifyChange).toHaveBeenCalledWith(I18N_INDEX_SYNC_UNIT)

    markPackRosterSynced(I18N_INDEX_SYNC_UNIT)
    vi.mocked(applySyncedI18nPackBody).mockResolvedValue('local-wins')
    expect(await mergePackBodyBundle({ isTheme: false, packId: 'p1' }, bundle, 'm')).toBe(true)
    expect(vi.mocked(applySyncedI18nPackBody).mock.calls[1][3]).toBe(true)
  })

  it('settles every pack roster unit before any other unit starts', async () => {
    const order: string[] = []
    const run = async (unit: string): Promise<void> => {
      order.push(`start ${unit}`)
      await new Promise((r) => setTimeout(r, unit === THEME_INDEX_SYNC_UNIT ? 5 : 0))
      order.push(`end ${unit}`)
    }
    await settlePackIndexUnitsFirst(['i18n/packs/a', THEME_INDEX_SYNC_UNIT, 'favorites/macro', I18N_INDEX_SYNC_UNIT], (u) => u, run)
    const lastIndexEnd = Math.max(order.indexOf(`end ${THEME_INDEX_SYNC_UNIT}`), order.indexOf(`end ${I18N_INDEX_SYNC_UNIT}`))
    expect(order.indexOf('start i18n/packs/a')).toBeGreaterThan(lastIndexEnd)
    expect(order.indexOf('start favorites/macro')).toBeGreaterThan(lastIndexEnd)
  })
})
