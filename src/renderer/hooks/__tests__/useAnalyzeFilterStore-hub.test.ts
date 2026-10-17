// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// The Hub posts of a saved Analyze filter on both vialAPI implementations:
// a public upload, a private upload that stores its link, an in-place
// update of a public post, and a Hub error shown as its message.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { clearMocks } from '@tauri-apps/api/mocks'
import { useAnalyzeFilterStore, type UploadAnalyticsToHubInput } from '../useAnalyzeFilterStore'
import { analyzeFilterBackends } from './analyze-filter-backends'

const { mockRequestUploadOptions } = vi.hoisted(() => ({ mockRequestUploadOptions: vi.fn() }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../useUploadConfirm', () => ({
  useUploadConfirm: () => ({ requestUploadOptions: mockRequestUploadOptions, isOpen: false }),
}))

const ENTRY = { id: 'f-1', label: 'My Filter', filename: 'f.json', savedAt: '2026-01-01T00:00:00.000Z' }

const INPUT: UploadAnalyticsToHubInput = {
  entryId: 'f-1',
  title: 'My Filter',
  thumbnailBase64: '/9j/4A==',
  keyboard: { productName: 'Corne', vendorId: 0x4653, productId: 1 },
  fingerOverrides: { '0,0': 'left-pinky' },
  layoutComparisonInputs: null,
  categories: ['heatmap', 'bigrams'],
}

/** The parameters the hook sends for INPUT. */
const PARAMS = {
  uid: 'kb-1',
  entryId: 'f-1',
  title: 'My Filter',
  thumbnailBase64: '/9j/4A==',
  keyboard: INPUT.keyboard,
  fingerOverrides: INPUT.fingerOverrides,
  layoutComparisonInputs: null,
  categories: ['heatmap', 'bigrams'],
}

const mockList = vi.fn()
const mockSetHubPrivate = vi.fn()
const mockUpload = vi.fn()
const mockUpdate = vi.fn()
const mockUploadPrivate = vi.fn()

const backends = analyzeFilterBackends(
  {
    analyzeFilterStoreList: mockList,
    analyzeFilterStoreSetHubPrivate: mockSetHubPrivate,
    hubUploadAnalyticsPost: mockUpload,
    hubUpdateAnalyticsPost: mockUpdate,
    hubUploadPrivateAnalyticsPost: mockUploadPrivate,
  },
  { syncOnUnitApplied: () => () => {} },
)

beforeEach(() => {
  vi.clearAllMocks()
  mockList.mockResolvedValue({ success: true, entries: [ENTRY] })
  mockSetHubPrivate.mockResolvedValue({ success: true })
})

afterEach(() => {
  clearMocks()
})

describe.each(backends)('useAnalyzeFilterStore Hub posts ($name)', (backend) => {
  beforeEach(() => {
    backend.install()
  })

  it('uploads a public post and lists the filters again', async () => {
    mockRequestUploadOptions.mockResolvedValue({ visibility: 'public', expiresInDays: null })
    mockUpload.mockResolvedValue({ success: true, postId: 'post-1' })
    const { result } = renderHook(() => useAnalyzeFilterStore({ uid: 'kb-1' }))
    let outcome = { ok: false }
    await act(async () => { outcome = await result.current.uploadEntryToHub(INPUT) })
    expect(outcome).toEqual({ ok: true })
    expect(mockUpload).toHaveBeenCalledWith(PARAMS)
    expect(mockList).toHaveBeenCalledWith('kb-1')
    expect(result.current.hubUploadResult).toMatchObject({ kind: 'success', message: 'hub.uploadSuccess', entryId: 'f-1' })
  })

  it('uploads a private post and stores its link', async () => {
    mockRequestUploadOptions.mockResolvedValue({ visibility: 'private', expiresInDays: 7 })
    mockUploadPrivate.mockResolvedValue({ success: true, id: 'priv-1', url: '/p/abc', expiresAt: '2026-01-08 00:00:00.000Z' })
    const { result } = renderHook(() => useAnalyzeFilterStore({ uid: 'kb-1' }))
    await act(async () => { await result.current.uploadEntryToHub(INPUT) })
    expect(mockUploadPrivate).toHaveBeenCalledWith({ ...PARAMS, expiresInDays: 7 })
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockSetHubPrivate).toHaveBeenCalledWith('kb-1', 'f-1', { id: 'priv-1', url: '/p/abc', expiresAt: '2026-01-08 00:00:00.000Z' })
  })

  it('updates a public post in place', async () => {
    mockList.mockResolvedValue({ success: true, entries: [{ ...ENTRY, hubPostId: 'post-1' }] })
    mockRequestUploadOptions.mockResolvedValue({ visibility: 'public', expiresInDays: null })
    mockUpdate.mockResolvedValue({ success: true, postId: 'post-1' })
    const { result } = renderHook(() => useAnalyzeFilterStore({ uid: 'kb-1' }))
    await act(async () => { await result.current.refreshEntries() })
    let outcome = { ok: false }
    await act(async () => { outcome = await result.current.updateEntryOnHub(INPUT) })
    expect(outcome).toEqual({ ok: true })
    expect(mockUpdate).toHaveBeenCalledWith({ ...PARAMS, postId: 'post-1' })
    expect(result.current.hubUploadResult).toMatchObject({ kind: 'success', message: 'hub.updateSuccess' })
  })

  it('shows a Hub error as its message', async () => {
    mockRequestUploadOptions.mockResolvedValue({ visibility: 'public', expiresInDays: null })
    mockUpload.mockResolvedValue({ success: false, error: 'RATE_LIMITED' })
    const { result } = renderHook(() => useAnalyzeFilterStore({ uid: 'kb-1' }))
    let outcome = { ok: true }
    await act(async () => { outcome = await result.current.uploadEntryToHub(INPUT) })
    expect(outcome).toEqual({ ok: false })
    expect(result.current.hubUploadResult).toMatchObject({ kind: 'error', message: 'hub.rateLimited', entryId: 'f-1' })
    expect(mockList).not.toHaveBeenCalled()
  })
})
