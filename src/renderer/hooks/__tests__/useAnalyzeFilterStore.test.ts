// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// The saved filter list of the Analyze pane on both vialAPI
// implementations: listing, saving (and the cap's message), loading
// (and a payload of an unknown version), renaming and deleting.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { clearMocks } from '@tauri-apps/api/mocks'
import { useAnalyzeFilterStore, type AnalyzeFilterSnapshotPayload } from '../useAnalyzeFilterStore'
import { analyzeFilterBackends } from './analyze-filter-backends'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const PAYLOAD = {
  version: 1,
  analysisTab: 'summary',
  range: { fromMs: 0, toMs: 86_400_000 },
  filters: { deviceScopes: ['own'], appScopes: [] },
} as unknown as AnalyzeFilterSnapshotPayload

const ENTRY = { id: 'f-1', label: 'My Filter', filename: 'f.json', savedAt: '2026-01-01T00:00:00.000Z' }

const mockList = vi.fn()
const mockSave = vi.fn()
const mockLoad = vi.fn()
const mockRename = vi.fn()
const mockDelete = vi.fn()

const backends = analyzeFilterBackends(
  {
    analyzeFilterStoreList: mockList,
    analyzeFilterStoreSave: mockSave,
    analyzeFilterStoreLoad: mockLoad,
    analyzeFilterStoreRename: mockRename,
    analyzeFilterStoreDelete: mockDelete,
  },
  { syncOnUnitApplied: () => () => {} },
)

beforeEach(() => {
  vi.clearAllMocks()
  mockList.mockResolvedValue({ success: true, entries: [ENTRY] })
})

afterEach(() => {
  clearMocks()
})

describe.each(backends)('useAnalyzeFilterStore ($name)', (backend) => {
  beforeEach(() => {
    backend.install()
  })

  it('lists the keyboard’s filters', async () => {
    const { result } = renderHook(() => useAnalyzeFilterStore({ uid: 'kb-1' }))
    await act(async () => { await result.current.refreshEntries() })
    expect(mockList).toHaveBeenCalledWith('kb-1')
    expect(result.current.entries).toEqual([ENTRY])
  })

  it('saves the payload as indented JSON with its label and summary, then lists again', async () => {
    mockSave.mockResolvedValue({ success: true, entry: ENTRY })
    const { result } = renderHook(() => useAnalyzeFilterStore({ uid: 'kb-1' }))
    let id: string | null = null
    await act(async () => { id = await result.current.saveSnapshot('My Filter', PAYLOAD, 'summary') })
    expect(id).toBe('f-1')
    expect(mockSave).toHaveBeenCalledWith('kb-1', JSON.stringify(PAYLOAD, null, 2), 'My Filter', 'summary')
    expect(mockList).toHaveBeenCalledTimes(1)
  })

  it('reports the cap when the store refuses a save', async () => {
    mockSave.mockResolvedValue({ success: false, error: 'max entries reached' })
    const { result } = renderHook(() => useAnalyzeFilterStore({ uid: 'kb-1' }))
    await act(async () => { await result.current.saveSnapshot('X', PAYLOAD) })
    expect(result.current.error).toBe('analyzeFilterStore.maxEntriesReached')
  })

  it('loads a saved payload, and refuses one of an unknown version', async () => {
    mockLoad.mockResolvedValueOnce({ success: true, data: JSON.stringify(PAYLOAD) })
    const { result } = renderHook(() => useAnalyzeFilterStore({ uid: 'kb-1' }))
    let loaded: AnalyzeFilterSnapshotPayload | null = null
    await act(async () => { loaded = await result.current.loadSnapshot('f-1') })
    expect(mockLoad).toHaveBeenCalledWith('kb-1', 'f-1')
    expect(loaded).toEqual(PAYLOAD)

    mockLoad.mockResolvedValueOnce({ success: true, data: '{"version":99}' })
    await act(async () => { loaded = await result.current.loadSnapshot('f-1') })
    expect(loaded).toBeNull()
    expect(result.current.error).toBe('analyzeFilterStore.unsupportedVersion')
  })

  it('renames and deletes a filter, then lists again', async () => {
    mockRename.mockResolvedValue({ success: true })
    mockDelete.mockResolvedValue({ success: true })
    const { result } = renderHook(() => useAnalyzeFilterStore({ uid: 'kb-1' }))
    await act(async () => { await result.current.refreshEntries() })
    let renamed = false
    let deleted = false
    await act(async () => { renamed = await result.current.renameEntry('f-1', 'New') })
    await act(async () => { deleted = await result.current.deleteEntry('f-1') })
    expect([renamed, deleted]).toEqual([true, true])
    expect(mockRename).toHaveBeenCalledWith('kb-1', 'f-1', 'New')
    expect(mockDelete).toHaveBeenCalledWith('kb-1', 'f-1')
    expect(mockList).toHaveBeenCalledTimes(3)
  })

  it('answers false when the store fails a rename', async () => {
    mockRename.mockResolvedValue({ success: false, error: 'Entry not found' })
    const { result } = renderHook(() => useAnalyzeFilterStore({ uid: 'kb-1' }))
    let renamed = true
    await act(async () => { renamed = await result.current.renameEntry('missing', 'New') })
    expect(renamed).toBe(false)
  })
})
