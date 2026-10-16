// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// The multi-file import of `useLanguagePackImport` on the real
// `useI18nPackStore`, on both vialAPI implementations
// (hooks/__tests__/i18n-pack-backends.ts): every chosen file is checked,
// saved with its coverage and placed, and a file that could not be read is
// reported by its name.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { clearMocks } from '@tauri-apps/api/mocks'
import { setupAppConfigMock, renderHookWithConfig, vialAPIMock } from '../../../hooks/__tests__/test-helpers'
import { i18nPackBackends } from '../../../hooks/__tests__/i18n-pack-backends'
import { useI18nPackStore } from '../../../hooks/useI18nPackStore'
import { useLanguagePackImport } from '../use-language-pack-import'
import type { UseImportPlacementResult } from '../../pack-modal/useImportPlacement'
import type { InlineRename } from '../../../hooks/useInlineRename'

vi.mock('../../../i18n', () => ({
  default: { changeLanguage: vi.fn().mockResolvedValue(undefined), language: 'builtin:en' },
}))
vi.mock('../../../i18n/dynamic-bundles', () => ({
  packResourceBundleId: (id: string) => `pack:${id}`,
  registerOnePack: vi.fn().mockResolvedValue(undefined),
  unregisterOnePack: vi.fn(),
  syncBundlesWithStore: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../i18n/coverage-cache', () => ({
  BASE_REVISION: '0.9.0',
  ENGLISH_PACK_BODY: { name: 'English', version: '0.9.0', common: { save: 'Save', cancel: 'Cancel' } },
  invalidateCoverage: vi.fn(),
  refreshCoverageFromIpc: vi.fn().mockResolvedValue(undefined),
}))

const mockList = vi.fn()
const mockImport = vi.fn()
const mockApply = vi.fn()
const backends = i18nPackBackends({ i18nPackList: mockList, i18nPackImport: mockImport, i18nPackImportApply: mockApply })

const t = ((key: string) => key) as unknown as TFunction

function savedMeta(id: string, name: string) {
  return { id, name, version: '0.1.0', enabled: true, filename: `packs/${id}.json`, savedAt: 'now', updatedAt: 'now' }
}

function placementStub(): UseImportPlacementResult {
  return {
    feedback: null,
    snapshotBeforeIds: () => new Set<string>(),
    snapshotEntries: () => ({ entries: [], direction: null }),
    place: vi.fn().mockResolvedValue(undefined),
    placeMany: vi.fn().mockResolvedValue(undefined),
  } as unknown as UseImportPlacementResult
}

function renameStub(): InlineRename<string> {
  return { cancelRename: vi.fn(), commitRename: vi.fn(() => null) } as unknown as InlineRename<string>
}

afterEach(() => {
  clearMocks()
})

describe.each(backends)('useLanguagePackImport ($name)', (backend) => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupAppConfigMock({ language: 'builtin:en' })
    mockList.mockResolvedValue({ success: true, data: [] })
    Object.defineProperty(window, 'vialAPI', {
      value: { ...vialAPIMock(), ...backend.install() },
      writable: true,
      configurable: true,
    })
  })

  function render() {
    const placement = placementStub()
    const setActionError = vi.fn()
    const handleSelectLanguage = vi.fn()
    const { result } = renderHookWithConfig(() => {
      const store = useI18nPackStore()
      return useLanguagePackImport({
        open: true,
        store,
        t,
        rename: renameStub(),
        placement,
        pushPackToHub: vi.fn().mockResolvedValue({ success: true }),
        handleSelectLanguage,
        setPendingId: vi.fn(),
        setActionError,
        setLastResult: vi.fn(),
      })
    })
    return { result, placement, setActionError, handleSelectLanguage }
  }

  it('saves every file that reads as a pack and reports the one that does not', async () => {
    const good = { name: 'Japanese', version: '0.1.0', common: { save: '保存', cancel: 'キャンセル' } }
    const partial = { name: 'Partial', version: '0.2.0', common: { save: 'S' } }
    mockImport.mockResolvedValue({
      canceled: false,
      files: [
        { filePath: '/packs/ja.json', raw: good, fileSizeBytes: 100 },
        { filePath: '/packs/missing.json', parseError: 'Error: ENOENT' },
        { filePath: '/packs/partial.json', raw: partial, fileSizeBytes: 50 },
      ],
    })
    mockApply
      .mockResolvedValueOnce({ success: true, data: savedMeta('p1', 'Japanese') })
      .mockResolvedValueOnce({ success: true, data: savedMeta('p2', 'Partial') })
    const { result, placement, setActionError } = render()
    await waitFor(() => expect(mockList).toHaveBeenCalled())

    await act(async () => {
      await result.current.runImport()
    })

    expect(mockApply.mock.calls).toEqual([
      [good, expect.objectContaining({ enabled: true, matchedBaseVersion: '0.9.0', coverage: { totalKeys: 2, coveredKeys: 2 }, dangerousKeyCount: 0 })],
      [partial, expect.objectContaining({ enabled: true, matchedBaseVersion: null, coverage: { totalKeys: 2, coveredKeys: 1 }, dangerousKeyCount: 0 })],
    ])
    expect(placement.placeMany).toHaveBeenCalledWith(
      [{ id: 'p1', name: 'Japanese' }, { id: 'p2', name: 'Partial' }],
      expect.anything(),
      2,
    )
    expect(setActionError).toHaveBeenLastCalledWith(expect.stringContaining('missing.json: Error: ENOENT'))
  })

  it('activates the one pack of a single-file import', async () => {
    mockImport.mockResolvedValue({ canceled: false, files: [{ filePath: '/ja.json', raw: { name: 'Ja', version: '1.0.0' }, fileSizeBytes: 10 }] })
    mockApply.mockResolvedValue({ success: true, data: savedMeta('p1', 'Ja') })
    const { result, handleSelectLanguage } = render()
    await act(async () => {
      await result.current.runImport()
    })
    expect(handleSelectLanguage).toHaveBeenCalledWith('pack:p1')
  })

  it('reports a pack the store refuses and saves nothing for a cancelled dialog', async () => {
    mockImport.mockResolvedValueOnce({ canceled: false, files: [{ filePath: '/en.json', raw: { name: 'English', version: '1.0.0' }, fileSizeBytes: 10 }] })
    mockApply.mockResolvedValueOnce({ success: false, errorCode: 'DUPLICATE_NAME', error: 'A language pack with the same name already exists' })
    const { result, setActionError } = render()
    await act(async () => {
      await result.current.runImport()
    })
    expect(setActionError).toHaveBeenLastCalledWith(expect.stringContaining('en.json: A language pack with the same name already exists'))

    mockImport.mockResolvedValueOnce({ canceled: true, files: [] })
    mockApply.mockClear()
    await act(async () => {
      await result.current.runImport()
    })
    expect(mockApply).not.toHaveBeenCalled()
  })
})
