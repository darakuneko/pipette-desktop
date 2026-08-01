// SPDX-License-Identifier: GPL-2.0-or-later
//
// Focused coverage for pack-bundle-merge.ts's mergePackIndexBundle: a
// malformed remote `metas` field (not an array, or missing entirely) must
// throw MalformedSyncBundleError so the sync poll's unchanged-revision skip
// applies — mirroring the generic index-based tail in sync-service.ts,
// which already does this for a non-array `.entries`. Previously this
// silently defaulted to an empty array, which made a corrupt remote index
// indistinguishable from a legitimately-empty one.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../i18n-pack-store', () => ({
  mergeSyncedIndex: vi.fn(),
  statLocalPackMtime: vi.fn(),
  applySyncedPackBody: vi.fn(),
  pinPackBodyMtime: vi.fn(),
}))

vi.mock('../../theme-pack-store', () => ({
  mergeSyncedIndex: vi.fn(),
  statLocalPackMtime: vi.fn(),
  applySyncedPackBody: vi.fn(),
  pinPackBodyMtime: vi.fn(),
}))

vi.mock('../../utils/broadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}))

import { mergePackIndexBundle } from '../pack-bundle-merge'
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
    vi.mocked(mergeSyncedI18nIndex).mockResolvedValue({ applied: true, remoteNeedsUpdate: false })
    const bundle = makeBundle({ metas: [] })

    const result = await mergePackIndexBundle(I18N_INDEX_SYNC_UNIT, bundle)

    expect(result).toBe(false)
    expect(mergeSyncedI18nIndex).toHaveBeenCalledWith([])
  })

  it('propagates the merge result even with non-empty, well-formed metas', async () => {
    vi.mocked(mergeSyncedThemeIndex).mockResolvedValue({ applied: true, remoteNeedsUpdate: true })
    const bundle = makeBundle({ metas: [{ id: 'a' }] })

    const result = await mergePackIndexBundle(THEME_INDEX_SYNC_UNIT, bundle)

    expect(result).toBe(true)
    expect(mergeSyncedThemeIndex).toHaveBeenCalledWith([{ id: 'a' }])
  })
})
