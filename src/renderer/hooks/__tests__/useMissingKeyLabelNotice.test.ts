// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { useMissingKeyLabelNotice } from '../useMissingKeyLabelNotice'
import { keyLabelHubApi } from '../../../tauri-shim/api/key-label-hub'

const pipetteSettingsGet = vi.fn()
const keyLabelStoreList = vi.fn()
const keyLabelStoreListAll = vi.fn()
const keyLabelHubDetail = vi.fn().mockResolvedValue({ success: false, errorCode: 'NOT_FOUND' })

const localMembers = { pipetteSettingsGet, keyLabelStoreList, keyLabelStoreListAll }

function installVialAPI(members: object): void {
  Object.defineProperty(window, 'vialAPI', { value: { ...localMembers, ...members }, writable: true, configurable: true })
}

// Both vialAPI implementations answer the Hub detail from the same spy: a
// preload-like mock, and the Tauri shim's member over a mocked Tauri IPC,
// whose command hands the spy its argument.
const backends = [
  { name: 'preload-like mock', install: () => installVialAPI({ keyLabelHubDetail }) },
  {
    name: 'Tauri shim over mockIPC',
    install: () => {
      mockIPC((cmd, payload) => {
        if (cmd !== 'key_label_hub_detail') throw new Error(`unexpected command ${cmd}`)
        return keyLabelHubDetail((payload as Record<string, unknown>).hubPostId)
      })
      installVialAPI({ keyLabelHubDetail: keyLabelHubApi.keyLabelHubDetail })
    },
  },
]

afterEach(() => {
  clearMocks()
})

describe.each(backends)('useMissingKeyLabelNotice ($name)', (backend) => {
  beforeEach(() => {
    vi.clearAllMocks()
    backend.install()
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

  it('names the missing layout after its Hub post', async () => {
    pipetteSettingsGet.mockResolvedValueOnce({ keyboardLayout: 'hub-post-1' })
    keyLabelStoreListAll.mockResolvedValueOnce({ success: true, data: [] })
    keyLabelHubDetail.mockResolvedValueOnce({ success: true, data: { id: 'hub-post-1', name: 'Eucalyn' } })

    const { result } = renderHook(() => useMissingKeyLabelNotice('uid-1'))
    await waitFor(() => expect(result.current.missingName).toBe('Eucalyn'))
    expect(keyLabelHubDetail).toHaveBeenCalledWith('hub-post-1')
  })

  it('does not re-show after dismiss for the same uid+layout pair', async () => {
    pipetteSettingsGet.mockResolvedValue({ keyboardLayout: 'brazilian' })
    keyLabelStoreListAll.mockResolvedValue({ success: true, data: [] })

    const { result, rerender } = renderHook(
      ({ uid }: { uid: string | null }) => useMissingKeyLabelNotice(uid),
      { initialProps: { uid: 'uid-1' as string | null } },
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
      { initialProps: { uid: 'uid-1' as string | null } },
    )
    await waitFor(() => expect(result.current.missingName).toBe('brazilian'))

    rerender({ uid: null })
    await waitFor(() => expect(result.current.missingName).toBeNull())
  })
})
