// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { useHubFreshness, hasUpdate } from '../useHubFreshness'
import { keyLabelHubApi } from '../../../tauri-shim/api/key-label-hub'

const keyLabelHubTimestamps = vi.fn()

function installVialAPI(members: object): void {
  Object.defineProperty(window, 'vialAPI', { value: members, writable: true, configurable: true })
}

// Both vialAPI implementations answer the key label timestamps from the
// same spy: a preload-like mock, and the Tauri shim's member over a mocked
// Tauri IPC, whose command hands the spy its argument.
const backends = [
  { name: 'preload-like mock', install: () => installVialAPI({ keyLabelHubTimestamps }) },
  {
    name: 'Tauri shim over mockIPC',
    install: () => {
      mockIPC((cmd, payload) => {
        if (cmd !== 'key_label_hub_timestamps') throw new Error(`unexpected command ${cmd}`)
        return keyLabelHubTimestamps((payload as Record<string, unknown>).ids)
      })
      installVialAPI({ keyLabelHubTimestamps: keyLabelHubApi.keyLabelHubTimestamps })
    },
  },
]

afterEach(() => {
  clearMocks()
})

const fetchTimestamps = (ids: string[]) => window.vialAPI.keyLabelHubTimestamps(ids)

const candidates = [
  { localId: 'local-a', hubPostId: 'hub-a' },
  { localId: 'local-b', hubPostId: 'hub-b' },
]

describe.each(backends)('useHubFreshness with the key label timestamps ($name)', (backend) => {
  beforeEach(() => {
    vi.clearAllMocks()
    backend.install()
  })

  it('marks the posts the Hub still has and the ones it dropped', async () => {
    keyLabelHubTimestamps.mockResolvedValueOnce({
      success: true,
      data: { items: [{ id: 'hub-a', updated_at: '2026-10-09 00:00:00.000Z' }] },
    })
    const { result } = renderHook(() => useHubFreshness({ enabled: true, candidates, fetchTimestamps }))
    await waitFor(() => expect(result.current.size).toBe(2))
    expect(keyLabelHubTimestamps).toHaveBeenCalledWith(['hub-a', 'hub-b'])
    expect(result.current.get('local-a')).toEqual({ serverUpdatedAt: '2026-10-09 00:00:00.000Z', removed: false })
    expect(result.current.get('local-b')).toEqual({ removed: true })
    expect(hasUpdate(result.current.get('local-a'), '2026-10-01 00:00:00.000Z')).toBe(true)
  })

  it('keeps nothing when the check fails', async () => {
    keyLabelHubTimestamps.mockResolvedValueOnce({ success: false, errorCode: 'IO_ERROR', error: 'offline' })
    const { result } = renderHook(() => useHubFreshness({ enabled: true, candidates, fetchTimestamps }))
    await waitFor(() => expect(keyLabelHubTimestamps).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(result.current.size).toBe(0)
  })
})
