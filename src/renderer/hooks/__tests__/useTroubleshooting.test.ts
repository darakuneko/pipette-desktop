// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// Task-irr-3: importLocalData's cancelled/error outcomes must be
// distinguished by the renderer — a cancelled file picker leaves
// whatever result was already displayed alone, while a failure both
// flips the result to 'error' and stores the raw main-process message
// for display.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTroubleshooting } from '../useTroubleshooting'

const mockImportLocalData = vi.fn()
const mockExportLocalData = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  window.vialAPI = {
    ...(window.vialAPI ?? {}),
    importLocalData: mockImportLocalData,
    exportLocalData: mockExportLocalData,
  } as unknown as typeof window.vialAPI
})

describe('useTroubleshooting — importLocalData outcomes', () => {
  it('sets importResult to success and clears importError on a plain success', async () => {
    mockImportLocalData.mockResolvedValue({ success: true })
    const { result } = renderHook(() => useTroubleshooting())

    await act(async () => {
      await result.current.handleImport()
    })

    expect(result.current.importResult).toBe('success')
    expect(result.current.importError).toBeNull()
  })

  it('leaves a prior result untouched when the file picker is cancelled', async () => {
    mockImportLocalData.mockResolvedValueOnce({ success: false, error: 'boom' })
    const { result } = renderHook(() => useTroubleshooting())

    await act(async () => {
      await result.current.handleImport()
    })
    expect(result.current.importResult).toBe('error')
    expect(result.current.importError).toBe('boom')

    mockImportLocalData.mockResolvedValueOnce({ success: true, cancelled: true })
    await act(async () => {
      await result.current.handleImport()
    })

    // Cancelling a second import attempt must not clear the previous
    // failure's displayed result/error.
    expect(result.current.importResult).toBe('error')
    expect(result.current.importError).toBe('boom')
  })

  it('sets importResult to error and stores the raw message on failure', async () => {
    mockImportLocalData.mockResolvedValue({ success: false, error: 'Corrupted index: /tmp/foo' })
    const { result } = renderHook(() => useTroubleshooting())

    await act(async () => {
      await result.current.handleImport()
    })

    expect(result.current.importResult).toBe('error')
    expect(result.current.importError).toBe('Corrupted index: /tmp/foo')
  })

  it('clears busy after import settles', async () => {
    mockImportLocalData.mockResolvedValue({ success: true })
    const { result } = renderHook(() => useTroubleshooting())

    await act(async () => {
      await result.current.handleImport()
    })

    expect(result.current.busy).toBe(false)
  })
})
