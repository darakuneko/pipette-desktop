// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchMissingRemoteDays } from '../typing-sync-remote-fetch'

const listCloud = vi.fn()
const listLocal = vi.fn()
const fetchDay = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'vialAPI', {
    value: {
      typingAnalyticsListRemoteCloudDays: listCloud,
      typingAnalyticsListLocalDeviceDays: listLocal,
      typingAnalyticsFetchRemoteDay: fetchDay,
    },
    writable: true,
    configurable: true,
  })
  fetchDay.mockResolvedValue(true)
})

describe('fetchMissingRemoteDays', () => {
  it('fetches only the cloud days not already in the local tree, in order', async () => {
    listCloud.mockResolvedValue(['2026-10-01', '2026-10-02', '2026-10-03'])
    listLocal.mockResolvedValue(['2026-10-02'])
    await fetchMissingRemoteDays('uid1', 'hash1')
    expect(fetchDay.mock.calls).toEqual([['uid1', 'hash1', '2026-10-01'], ['uid1', 'hash1', '2026-10-03']])
  })

  it('swallows a failure so the caller still lists what is local', async () => {
    listCloud.mockRejectedValue(new Error('offline'))
    listLocal.mockResolvedValue([])
    await expect(fetchMissingRemoteDays('uid1', 'hash1')).resolves.toBeUndefined()
    expect(fetchDay).not.toHaveBeenCalled()
  })
})
