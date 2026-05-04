// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// Focused coverage for the analyze save panel's "overwrite same name"
// flow. Mirrors the keymap save panel's `useHubState.handleOverwriteSave`
// behaviour: delete the existing entry, save a fresh one with the same
// label, and re-stamp the prior `hubPostId` so the Hub link survives.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAnalyzeFilterStore } from '../useAnalyzeFilterStore'
import type { AnalyzeFilterSnapshotPayload } from '../useAnalyzeFilterStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const PAYLOAD: AnalyzeFilterSnapshotPayload = {
  version: 1,
  analysisTab: 'summary',
  range: { fromMs: 0, toMs: 86_400_000 },
  filters: {
    deviceScopes: ['own'],
    appScopes: [],
    heatmap: {},
    wpm: {},
    interval: {},
    activity: { calendar: {} },
    layer: {},
    ergonomics: {},
    bigrams: {},
    layoutComparison: { targetLayoutId: null },
  } as unknown as AnalyzeFilterSnapshotPayload['filters'],
}

const mockList = vi.fn()
const mockSave = vi.fn()
const mockDelete = vi.fn()
const mockSetHubPostId = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).vialAPI = {
    ...((window as { vialAPI?: object }).vialAPI ?? {}),
    analyzeFilterStoreList: mockList,
    analyzeFilterStoreSave: mockSave,
    analyzeFilterStoreLoad: vi.fn(),
    analyzeFilterStoreUpdate: vi.fn(),
    analyzeFilterStoreRename: vi.fn(),
    analyzeFilterStoreDelete: mockDelete,
    analyzeFilterStoreSetHubPostId: mockSetHubPostId,
  }
})

describe('useAnalyzeFilterStore.overwriteSnapshot', () => {
  it('deletes the existing entry then saves a fresh one with the same label', async () => {
    mockList.mockResolvedValue({
      success: true,
      entries: [{ id: 'old-id', label: 'My Filter', filename: 'old.json', savedAt: '2026-01-01T00:00:00.000Z' }],
    })
    mockDelete.mockResolvedValue({ success: true })
    mockSave.mockResolvedValue({
      success: true,
      entry: { id: 'new-id', label: 'My Filter', filename: 'new.json', savedAt: '2026-05-04T00:00:00.000Z' },
    })

    const { result } = renderHook(() => useAnalyzeFilterStore({ uid: 'kb-1' }))
    await act(async () => { await result.current.refreshEntries() })

    let returned: string | null = null
    await act(async () => {
      returned = await result.current.overwriteSnapshot('old-id', 'My Filter', PAYLOAD, 'cond summary')
    })

    expect(returned).toBe('new-id')
    expect(mockDelete).toHaveBeenCalledWith('kb-1', 'old-id')
    expect(mockSave).toHaveBeenCalledWith(
      'kb-1',
      JSON.stringify(PAYLOAD, null, 2),
      'My Filter',
      'cond summary',
    )
    // No hubPostId to migrate — the setHubPostId IPC stays untouched.
    expect(mockSetHubPostId).not.toHaveBeenCalled()
  })

  it('re-stamps the prior hubPostId on the new entry so the Hub link survives', async () => {
    mockList.mockResolvedValue({
      success: true,
      entries: [{
        id: 'old-id',
        label: 'Hub Filter',
        filename: 'old.json',
        savedAt: '2026-01-01T00:00:00.000Z',
        hubPostId: 'post-xyz',
      }],
    })
    mockDelete.mockResolvedValue({ success: true })
    mockSave.mockResolvedValue({
      success: true,
      entry: { id: 'new-id', label: 'Hub Filter', filename: 'new.json', savedAt: '2026-05-04T00:00:00.000Z' },
    })
    mockSetHubPostId.mockResolvedValue({ success: true })

    const { result } = renderHook(() => useAnalyzeFilterStore({ uid: 'kb-1' }))
    await act(async () => { await result.current.refreshEntries() })

    await act(async () => {
      await result.current.overwriteSnapshot('old-id', 'Hub Filter', PAYLOAD)
    })

    expect(mockSetHubPostId).toHaveBeenCalledWith('kb-1', 'new-id', 'post-xyz')
  })

  it('returns null + reports an error when the underlying delete fails', async () => {
    mockList.mockResolvedValue({
      success: true,
      entries: [{ id: 'old-id', label: 'X', filename: 'old.json', savedAt: '' }],
    })
    mockDelete.mockResolvedValue({ success: false, error: 'IO error' })

    const { result } = renderHook(() => useAnalyzeFilterStore({ uid: 'kb-1' }))
    await act(async () => { await result.current.refreshEntries() })

    let returned: string | null = 'sentinel'
    await act(async () => {
      returned = await result.current.overwriteSnapshot('old-id', 'X', PAYLOAD)
    })

    expect(returned).toBeNull()
    expect(mockSave).not.toHaveBeenCalled()
    expect(result.current.error).toBe('analyzeFilterStore.saveFailed')
  })

  it('treats max-entries reached after delete as a save failure (defensive — should not normally fire)', async () => {
    mockList.mockResolvedValue({
      success: true,
      entries: [{ id: 'old-id', label: 'X', filename: 'old.json', savedAt: '' }],
    })
    mockDelete.mockResolvedValue({ success: true })
    mockSave.mockResolvedValue({ success: false, error: 'max entries reached' })

    const { result } = renderHook(() => useAnalyzeFilterStore({ uid: 'kb-1' }))
    await act(async () => { await result.current.refreshEntries() })

    let returned: string | null = 'sentinel'
    await act(async () => {
      returned = await result.current.overwriteSnapshot('old-id', 'X', PAYLOAD)
    })

    expect(returned).toBeNull()
    expect(result.current.error).toBe('analyzeFilterStore.maxEntriesReached')
  })

  it('returns null without invoking IPCs when uid is null', async () => {
    const { result } = renderHook(() => useAnalyzeFilterStore({ uid: null }))
    let returned: string | null = 'sentinel'
    await act(async () => {
      returned = await result.current.overwriteSnapshot('old-id', 'X', PAYLOAD)
    })
    expect(returned).toBeNull()
    expect(mockDelete).not.toHaveBeenCalled()
    expect(mockSave).not.toHaveBeenCalled()
  })
})
