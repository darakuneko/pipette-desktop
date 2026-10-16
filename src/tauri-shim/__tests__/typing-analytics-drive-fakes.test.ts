// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The typing analytics Drive members answer as a signed-out sync does, so
// the Data modal's Sync > Typing tree still lists the device hashes the
// local cache knows.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { VialAPI } from '../../shared/types/vial-api'
import { resetDataNavCache, useDataNavTree } from '../../renderer/components/data-modal/useDataNavTree'
import { fakes } from '../fakes'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const device = (machineHash: string) => ({ machineHash, osPlatform: 'linux', osRelease: '6.0.0' })

afterEach(() => {
  resetDataNavCache()
})

describe('typing analytics Drive fakes', () => {
  it('answer that Drive holds nothing', async () => {
    await expect(fakes.typingAnalyticsHasRemote()).resolves.toBe(false)
    await expect(fakes.typingAnalyticsListRemoteCloudHashes()).resolves.toEqual([])
    await expect(fakes.typingAnalyticsListRemoteCloudDays()).resolves.toEqual([])
    await expect(fakes.typingAnalyticsFetchRemoteDay()).resolves.toBe(false)
    await expect(fakes.syncAnalyticsNow()).resolves.toBe(false)
  })

  it('leave the hashes of the local cache in the Sync > Typing tree', async () => {
    window.vialAPI = {
      ...fakes,
      listStoredKeyboards: () => Promise.resolve([]),
      typingAnalyticsListKeyboards: () => Promise.resolve([]),
      typingAnalyticsListDeviceInfos: () =>
        Promise.resolve({ own: device('own'), remotes: [device('hash-b'), device('hash-a')] }),
    } as unknown as VialAPI
    const { result } = renderHook(() => useDataNavTree({ showHubTab: false, syncEnabled: false }))
    act(() => result.current.ensureRemoteTypingHashes('uid-1'))
    await waitFor(() => expect(result.current.remoteTypingHashes['uid-1']).toEqual(['hash-a', 'hash-b']))
  })
})
