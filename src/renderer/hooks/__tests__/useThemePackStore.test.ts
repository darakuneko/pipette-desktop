// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// Focused hook-level coverage for `useThemePackStore`'s `reorder`. Mirrors
// the `reorder` describe block already covering `useKeyLabels`.
//
// Unlike i18n/Key Labels, `reorder` here does not call `refresh()`
// itself — the main-side handler broadcasts `THEME_PACK_CHANGED` on
// success, which reaches this same window's `themePackOnChanged`
// listener (see useThemePackStore.ts). Tests simulate that broadcast
// through the backend. Runs on both vialAPI implementations
// (theme-pack-backends.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { clearMocks } from '@tauri-apps/api/mocks'
import { useThemePackStore } from '../useThemePackStore'
import { themePackBackends } from './theme-pack-backends'

const mockList = vi.fn()
const mockReorder = vi.fn()

function meta(overrides: Partial<{ id: string; name: string }> = {}) {
  return {
    id: overrides.id ?? 'a',
    name: overrides.name ?? 'A',
    version: '1.0',
    filename: `${overrides.id ?? 'a'}.json`,
    savedAt: 'now',
    updatedAt: 'now',
  }
}

const backends = themePackBackends({ themePackList: mockList, themePackReorder: mockReorder })

afterEach(() => {
  clearMocks()
})

describe.each(backends)('useThemePackStore reorder ($name)', (backend) => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockList.mockResolvedValue({ success: true, data: [meta({ id: 'a', name: 'A' }), meta({ id: 'b', name: 'B' })] })
    mockReorder.mockResolvedValue({ success: true })
    Object.defineProperty(window, 'vialAPI', {
      value: backend.install(),
      writable: true,
      configurable: true,
    })
  })

  it('calls themePackReorder; the main-side change broadcast then refreshes metas to the new order', async () => {
    const { result } = renderHook(() => useThemePackStore())
    await waitFor(() => expect(result.current.metas.map((m) => m.id)).toEqual(['a', 'b']))

    await act(async () => {
      const res = await result.current.reorder(['b', 'a'])
      expect(res.success).toBe(true)
    })
    expect(mockReorder).toHaveBeenCalledWith(['b', 'a'])

    // Simulate the main process's THEME_PACK_CHANGED broadcast that
    // the IPC handler fires on a successful reorder.
    mockList.mockResolvedValueOnce({ success: true, data: [meta({ id: 'b', name: 'B' }), meta({ id: 'a', name: 'A' })] })
    await act(async () => { await backend.broadcast() })

    await waitFor(() => expect(result.current.metas.map((m) => m.id)).toEqual(['b', 'a']))
  })

  it('surfaces the error when reorder fails', async () => {
    mockReorder.mockResolvedValueOnce({ success: false, error: 'reorder failed' })
    const { result } = renderHook(() => useThemePackStore())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))

    await act(async () => {
      const res = await result.current.reorder(['b', 'a'])
      expect(res.success).toBe(false)
      expect(res.error).toBe('reorder failed')
    })
  })
})
