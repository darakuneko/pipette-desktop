// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useMissingKeyLabelNotice } from '../useMissingKeyLabelNotice'

const pipetteSettingsGet = vi.fn()
const pipetteSettingsSet = vi.fn().mockResolvedValue({ success: true })
const keyLabelStoreList = vi.fn()
const keyLabelStoreListAll = vi.fn()
const keyLabelHubDetail = vi.fn().mockResolvedValue({ success: false, errorCode: 'NOT_FOUND' })

Object.defineProperty(window, 'vialAPI', {
  value: {
    pipetteSettingsGet,
    pipetteSettingsSet,
    keyLabelStoreList,
    keyLabelStoreListAll,
    keyLabelHubDetail,
  },
  writable: true,
})

describe('useMissingKeyLabelNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when uid is null', () => {
    const { result } = renderHook(() => useMissingKeyLabelNotice(null))
    expect(result.current.missingName).toBeNull()
  })

  it('returns null when keyboardLayout is qwerty', async () => {
    pipetteSettingsGet.mockResolvedValueOnce({ keyboardLayout: 'qwerty' })
    const { result } = renderHook(() => useMissingKeyLabelNotice('uid-1'))
    await waitFor(() => expect(pipetteSettingsGet).toHaveBeenCalled())
    expect(result.current.missingName).toBeNull()
  })

  it('returns null when the layout exists in the local store', async () => {
    pipetteSettingsGet.mockResolvedValueOnce({ keyboardLayout: 'custom-1' })
    keyLabelStoreListAll.mockResolvedValueOnce({
      success: true,
      data: [{ id: 'custom-1', name: 'Custom 1', uploaderName: 'me', filename: 'f', savedAt: '', updatedAt: '' }],
    })

    const { result } = renderHook(() => useMissingKeyLabelNotice('uid-1'))
    await waitFor(() => expect(keyLabelStoreListAll).toHaveBeenCalled())
    expect(result.current.missingName).toBeNull()
  })

  it('exposes missing name when neither built-in nor store has the layout', async () => {
    pipetteSettingsGet.mockResolvedValueOnce({ keyboardLayout: 'brazilian' })
    keyLabelStoreListAll.mockResolvedValueOnce({ success: true, data: [] })

    const { result } = renderHook(() => useMissingKeyLabelNotice('uid-1'))
    await waitFor(() => expect(result.current.missingName).toBe('brazilian'))
  })

  it('does not re-show after dismiss for the same uid+layout pair', async () => {
    pipetteSettingsGet.mockResolvedValue({ keyboardLayout: 'brazilian' })
    keyLabelStoreListAll.mockResolvedValue({ success: true, data: [] })

    const { result, rerender } = renderHook(
      ({ uid }: { uid: string | null }) => useMissingKeyLabelNotice(uid),
      { initialProps: { uid: 'uid-1' } },
    )
    await waitFor(() => expect(result.current.missingName).toBe('brazilian'))

    act(() => {
      result.current.dismiss()
    })
    expect(result.current.missingName).toBeNull()

    // Disconnect then reconnect to same uid → still suppressed.
    // dismiss() leaves persistence to `useDevicePrefs.setLayout`, so
    // only the effect's two reads of pipette_settings happen here.
    rerender({ uid: null })
    rerender({ uid: 'uid-1' })
    await waitFor(() => expect(pipetteSettingsGet).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.missingName).toBeNull()
  })

  it('clears missing name when uid becomes null', async () => {
    pipetteSettingsGet.mockResolvedValue({ keyboardLayout: 'brazilian' })
    keyLabelStoreListAll.mockResolvedValue({ success: true, data: [] })

    const { result, rerender } = renderHook(
      ({ uid }: { uid: string | null }) => useMissingKeyLabelNotice(uid),
      { initialProps: { uid: 'uid-1' } },
    )
    await waitFor(() => expect(result.current.missingName).toBe('brazilian'))

    rerender({ uid: null })
    await waitFor(() => expect(result.current.missingName).toBeNull())
  })
})
