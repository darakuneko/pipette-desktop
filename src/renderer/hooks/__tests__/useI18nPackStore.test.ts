// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// Focused hook-level coverage for `useI18nPackStore`'s `reorder`
// (Phase 2 of the pack-modal-unification plan). Mirrors the
// `reorder` describe block already covering `useKeyLabels`.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { setupAppConfigMock, renderHookWithConfig, vialAPIMock } from './test-helpers'
import { useI18nPackStore } from '../useI18nPackStore'

vi.mock('../../i18n', () => ({
  default: { changeLanguage: vi.fn().mockResolvedValue(undefined), language: 'builtin:en' },
}))
vi.mock('../../i18n/dynamic-bundles', () => ({
  packResourceBundleId: (id: string) => `pack:${id}`,
  registerOnePack: vi.fn().mockResolvedValue(undefined),
  unregisterOnePack: vi.fn(),
  syncBundlesWithStore: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../i18n/coverage-cache', () => ({
  invalidateCoverage: vi.fn(),
  refreshCoverageFromIpc: vi.fn().mockResolvedValue(undefined),
}))

const mockList = vi.fn()
const mockReorder = vi.fn()

function meta(overrides: Partial<{ id: string; name: string }> = {}) {
  return {
    id: overrides.id ?? 'a',
    name: overrides.name ?? 'A',
    version: '0.1.0',
    enabled: true,
    filename: `${overrides.id ?? 'a'}.json`,
    savedAt: 'now',
    updatedAt: 'now',
  }
}

describe('useI18nPackStore reorder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupAppConfigMock({ language: 'builtin:en' })
    mockList.mockResolvedValue({ success: true, data: [meta({ id: 'a', name: 'A' }), meta({ id: 'b', name: 'B' })] })
    mockReorder.mockResolvedValue({ success: true })
    Object.defineProperty(window, 'vialAPI', {
      value: {
        ...vialAPIMock(),
        i18nPackList: mockList,
        i18nPackReorder: mockReorder,
        i18nPackOnChanged: () => () => undefined,
      },
      writable: true,
      configurable: true,
    })
  })

  it('refreshes after reorder succeeds, and the new order is reflected in metas', async () => {
    const { result } = renderHookWithConfig(() => useI18nPackStore())
    await waitFor(() => expect(result.current.metas.map((m) => m.id)).toEqual(['a', 'b']))
    mockList.mockClear()
    // Simulate the store now returning the reordered list — this is
    // what a dropdown (or any other `metas` consumer) would see after
    // a successful reorder, without any extra wiring on its part.
    mockList.mockResolvedValueOnce({ success: true, data: [meta({ id: 'b', name: 'B' }), meta({ id: 'a', name: 'A' })] })

    await act(async () => {
      await result.current.reorder(['b', 'a'])
    })

    expect(mockReorder).toHaveBeenCalledWith(['b', 'a'])
    expect(mockList).toHaveBeenCalled()
    await waitFor(() => expect(result.current.metas.map((m) => m.id)).toEqual(['b', 'a']))
  })

  it('does not refresh when reorder fails, and surfaces the error', async () => {
    mockReorder.mockResolvedValueOnce({ success: false, error: 'reorder failed' })
    const { result } = renderHookWithConfig(() => useI18nPackStore())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    mockList.mockClear()

    await act(async () => {
      const res = await result.current.reorder(['b', 'a'])
      expect(res.success).toBe(false)
      expect(res.error).toBe('reorder failed')
    })

    expect(mockList).not.toHaveBeenCalled()
  })
})
