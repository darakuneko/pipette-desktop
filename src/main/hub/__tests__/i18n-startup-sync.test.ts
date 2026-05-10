// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { I18nPackMeta } from '../../../shared/types/i18n-store'
import type { HubI18nExportV1 } from '../../../shared/types/hub'

vi.mock('../../i18n-pack-store', () => ({
  listMetas: vi.fn(),
  savePack: vi.fn(),
}))
vi.mock('../hub-i18n', () => ({
  downloadI18nPostBody: vi.fn(),
  fetchI18nPackTimestamps: vi.fn(),
  validateI18nExport: vi.fn(),
}))
vi.mock('../../logger', () => ({
  log: vi.fn(),
}))

import { listMetas, savePack } from '../../i18n-pack-store'
import { downloadI18nPostBody, fetchI18nPackTimestamps, validateI18nExport } from '../hub-i18n'
import { syncHubI18nPacksOnStartup } from '../i18n-startup-sync'

const mockedListMetas = vi.mocked(listMetas)
const mockedSavePack = vi.mocked(savePack)
const mockedDownload = vi.mocked(downloadI18nPostBody)
const mockedFetchTs = vi.mocked(fetchI18nPackTimestamps)
const mockedValidate = vi.mocked(validateI18nExport)

function makeMeta(overrides: Partial<I18nPackMeta> = {}): I18nPackMeta {
  return {
    id: 'pack-1',
    filename: 'packs/pack-1.json',
    name: 'French',
    version: '1.0.0',
    enabled: true,
    hubPostId: 'hub-1',
    hubUpdatedAt: '2026-05-09T00:00:00.000Z',
    savedAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeExport(): HubI18nExportV1 {
  return {
    version: 1,
    kind: 'i18n',
    exportedAt: '2026-05-10T03:00:00.000Z',
    pack: { name: 'French', version: '1.1.0' },
  }
}

describe('syncHubI18nPacksOnStartup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips packs without hubPostId', async () => {
    // Tombstoned entries are filtered by listMetas() upstream, so the
    // sync function never sees them — the only filter it performs is
    // dropping packs that were never linked to a Hub post.
    mockedListMetas.mockResolvedValue([
      makeMeta({ id: 'pack-local', hubPostId: undefined }),
    ])

    const result = await syncHubI18nPacksOnStartup()

    expect(result.checked).toBe(0)
    expect(mockedFetchTs).not.toHaveBeenCalled()
    expect(mockedDownload).not.toHaveBeenCalled()
  })

  it('skips re-download when local hubUpdatedAt matches Hub', async () => {
    mockedListMetas.mockResolvedValue([
      makeMeta({ id: 'pack-1', hubPostId: 'hub-1', hubUpdatedAt: '2026-05-09T00:00:00.000Z' }),
    ])
    mockedFetchTs.mockResolvedValue({
      items: [{ id: 'hub-1', updated_at: '2026-05-09T00:00:00.000Z' }],
    })

    const result = await syncHubI18nPacksOnStartup()

    expect(result.checked).toBe(1)
    expect(result.updated).toBe(0)
    expect(result.missingOnHub).toBe(0)
    expect(mockedDownload).not.toHaveBeenCalled()
    expect(mockedSavePack).not.toHaveBeenCalled()
  })

  it('downloads + savePack with new hubUpdatedAt when Hub is newer', async () => {
    mockedListMetas.mockResolvedValue([
      makeMeta({ id: 'pack-1', hubPostId: 'hub-1', hubUpdatedAt: '2026-05-09T00:00:00.000Z' }),
    ])
    mockedFetchTs.mockResolvedValue({
      items: [{ id: 'hub-1', updated_at: '2026-05-10T03:00:00.000Z' }],
    })
    const exportData = makeExport()
    mockedDownload.mockResolvedValue(exportData)
    mockedValidate.mockReturnValue({ ok: true, warnings: [] })
    mockedSavePack.mockResolvedValue({ success: true, data: makeMeta() })

    const result = await syncHubI18nPacksOnStartup()

    expect(result.checked).toBe(1)
    expect(result.updated).toBe(1)
    expect(mockedSavePack).toHaveBeenCalledWith(expect.objectContaining({
      id: 'pack-1',
      pack: exportData.pack,
      hubPostId: 'hub-1',
      hubUpdatedAt: '2026-05-10T03:00:00.000Z',
    }))
    // `enabled` must NOT be passed so the user's local choice is preserved.
    expect(mockedSavePack.mock.calls[0][0].enabled).toBeUndefined()
  })

  it('counts packs whose Hub post is missing without re-saving them', async () => {
    mockedListMetas.mockResolvedValue([
      makeMeta({ id: 'pack-orphan', hubPostId: 'hub-gone' }),
    ])
    mockedFetchTs.mockResolvedValue({ items: [] })

    const result = await syncHubI18nPacksOnStartup()

    expect(result.checked).toBe(1)
    expect(result.missingOnHub).toBe(1)
    expect(result.updated).toBe(0)
    expect(mockedDownload).not.toHaveBeenCalled()
    expect(mockedSavePack).not.toHaveBeenCalled()
  })

  it('downloads when local hubUpdatedAt is missing (legacy entry)', async () => {
    mockedListMetas.mockResolvedValue([
      makeMeta({ id: 'pack-legacy', hubPostId: 'hub-1', hubUpdatedAt: undefined }),
    ])
    mockedFetchTs.mockResolvedValue({
      items: [{ id: 'hub-1', updated_at: '2026-05-09T00:00:00.000Z' }],
    })
    mockedDownload.mockResolvedValue(makeExport())
    mockedValidate.mockReturnValue({ ok: true, warnings: [] })
    mockedSavePack.mockResolvedValue({ success: true, data: makeMeta() })

    const result = await syncHubI18nPacksOnStartup()

    expect(result.updated).toBe(1)
  })

  it('records a per-pack error when validation fails and continues', async () => {
    mockedListMetas.mockResolvedValue([
      makeMeta({ id: 'pack-bad', hubPostId: 'hub-bad', hubUpdatedAt: 'old' }),
      makeMeta({ id: 'pack-good', hubPostId: 'hub-good', hubUpdatedAt: 'old' }),
    ])
    mockedFetchTs.mockResolvedValue({
      items: [
        { id: 'hub-bad', updated_at: 'new' },
        { id: 'hub-good', updated_at: 'new' },
      ],
    })
    mockedDownload.mockImplementation(async (postId: string) => {
      return { ...makeExport(), pack: { ...makeExport().pack, name: postId } }
    })
    mockedValidate.mockImplementation((exp: unknown) => {
      const pack = (exp as HubI18nExportV1).pack
      if (pack.name === 'hub-bad') return { ok: false, reason: 'depth too deep', warnings: [] }
      return { ok: true, warnings: [] }
    })
    mockedSavePack.mockResolvedValue({ success: true, data: makeMeta() })

    const result = await syncHubI18nPacksOnStartup()

    expect(result.checked).toBe(2)
    expect(result.updated).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ packId: 'pack-bad', hubPostId: 'hub-bad' })
    expect(result.errors[0].reason).toContain('invalid pack from Hub')
  })

  it('returns an empty result and never throws when listMetas fails', async () => {
    mockedListMetas.mockRejectedValue(new Error('disk gone'))

    const result = await syncHubI18nPacksOnStartup()

    expect(result.checked).toBe(0)
    expect(result.updated).toBe(0)
    expect(mockedFetchTs).not.toHaveBeenCalled()
  })

  it('returns checked count with no updates when timestamps fetch fails', async () => {
    mockedListMetas.mockResolvedValue([
      makeMeta({ id: 'pack-1', hubPostId: 'hub-1' }),
    ])
    mockedFetchTs.mockRejectedValue(new Error('network'))

    const result = await syncHubI18nPacksOnStartup()

    expect(result.checked).toBe(1)
    expect(result.updated).toBe(0)
    expect(mockedDownload).not.toHaveBeenCalled()
  })

  it('chunks more than 100 ids into separate timestamps requests', async () => {
    const metas: I18nPackMeta[] = []
    for (let i = 0; i < 150; i++) {
      metas.push(makeMeta({ id: `pack-${String(i)}`, hubPostId: `hub-${String(i)}`, hubUpdatedAt: 'same' }))
    }
    mockedListMetas.mockResolvedValue(metas)
    mockedFetchTs.mockImplementation(async (ids: string[]) => ({
      items: ids.map((id) => ({ id, updated_at: 'same' })),
    }))

    const result = await syncHubI18nPacksOnStartup()

    expect(result.checked).toBe(150)
    expect(result.updated).toBe(0)
    expect(mockedFetchTs).toHaveBeenCalledTimes(2)
    expect(mockedFetchTs.mock.calls[0][0]).toHaveLength(100)
    expect(mockedFetchTs.mock.calls[1][0]).toHaveLength(50)
  })
})
