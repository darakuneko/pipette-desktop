// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// useDataNavTree's Sync > Typing tree against both vialAPI implementations
// (typing-remote-backends.ts): whether it is shown, and the remote devices
// of a keyboard, the ones the cache knows and the ones only Drive has.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { clearMocks } from '@tauri-apps/api/mocks'
import { resetDataNavCache, useDataNavTree } from '../data-modal/useDataNavTree'
import { typingRemoteBackends, type TypingRemoteSpies } from './typing-remote-backends'

const device = (machineHash: string) => ({ machineHash, osPlatform: 'linux', osRelease: '6.0.0' })

const spies = {
  listStoredKeyboards: vi.fn(),
  typingAnalyticsListKeyboards: vi.fn(),
  typingAnalyticsListDeviceInfos: vi.fn(),
  typingAnalyticsHasRemote: vi.fn(),
  typingAnalyticsListRemoteCloudHashes: vi.fn(),
  typingAnalyticsListRemoteCloudDays: vi.fn(),
  typingAnalyticsFetchRemoteDay: vi.fn(),
  typingAnalyticsListLocalDeviceDays: vi.fn(),
  typingAnalyticsListItemsForHash: vi.fn(),
  typingAnalyticsDeleteDeviceData: vi.fn(),
} satisfies TypingRemoteSpies

beforeEach(() => {
  resetDataNavCache()
  for (const spy of Object.values(spies)) spy.mockReset()
  spies.listStoredKeyboards.mockResolvedValue([])
  spies.typingAnalyticsListKeyboards.mockResolvedValue([])
  spies.typingAnalyticsListDeviceInfos.mockResolvedValue({ own: device('own'), remotes: [device('hash-b'), device('hash-a')] })
  spies.typingAnalyticsListRemoteCloudHashes.mockResolvedValue(['hash-c', 'hash-a'])
  spies.typingAnalyticsHasRemote.mockResolvedValue(true)
})

afterEach(() => {
  clearMocks()
})

describe.each(typingRemoteBackends(spies))('useDataNavTree Sync > Typing ($name)', (backend) => {
  beforeEach(() => {
    backend.install()
  })

  it('lists the devices the cache knows and those only Drive has, sorted', async () => {
    const { result } = renderHook(() => useDataNavTree({ showHubTab: false, syncEnabled: true }))
    act(() => result.current.ensureRemoteTypingHashes('uid-1'))
    await waitFor(() => expect(result.current.remoteTypingHashes['uid-1']).toEqual(['hash-a', 'hash-b', 'hash-c']))
    expect(spies.typingAnalyticsListRemoteCloudHashes).toHaveBeenCalledWith('uid-1')
  })

  it('lists no device when Drive cannot be read', async () => {
    spies.typingAnalyticsListRemoteCloudHashes.mockRejectedValue(new Error('Drive list failed: 500'))
    const { result } = renderHook(() => useDataNavTree({ showHubTab: false, syncEnabled: true }))
    act(() => result.current.ensureRemoteTypingHashes('uid-1'))
    await waitFor(() => expect(result.current.remoteTypingHashes['uid-1']).toEqual([]))
  })

  it('shows the tree when Drive has another device\'s typing, and hides it when Drive fails', async () => {
    const { result } = renderHook(() => useDataNavTree({ showHubTab: false, syncEnabled: true }))
    await act(() => result.current.refreshTypingKeyboards())
    expect(result.current.hasRemoteTyping).toBe(true)

    spies.typingAnalyticsHasRemote.mockRejectedValue(new Error('Drive list failed: 500'))
    await act(() => result.current.refreshTypingKeyboards())
    expect(result.current.hasRemoteTyping).toBe(false)
  })

  it('does not ask Drive while the sync is off', async () => {
    const { result } = renderHook(() => useDataNavTree({ showHubTab: false, syncEnabled: false }))
    await act(() => result.current.refreshTypingKeyboards())
    expect(result.current.hasRemoteTyping).toBe(false)
    expect(spies.typingAnalyticsHasRemote).not.toHaveBeenCalled()
  })
})
