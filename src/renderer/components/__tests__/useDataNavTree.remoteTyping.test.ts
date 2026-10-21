// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// useDataNavTree's Sync > Typing tree against both vialAPI implementations
// (typing-remote-backends.ts): its keyboards, the local ones and those the
// scan found another device's days of, and the remote devices of a keyboard,
// the ones the cache knows and the ones only Drive has.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { clearMocks } from '@tauri-apps/api/mocks'
import { resetDataNavCache, useDataNavTree } from '../data-modal/useDataNavTree'
import { typingRemoteBackends, type TypingRemoteSpies } from './typing-remote-backends'

const device = (machineHash: string) => ({ machineHash, osPlatform: 'linux', osRelease: '6.0.0' })

const scan = (typingKeyboards: string[], keyboardNames: Record<string, string> = {}) => ({
  keyboards: typingKeyboards, typingKeyboards, keyboardNames, favorites: [], i18nPacks: [], themePacks: [],
  keyLabels: false, typingTestTexts: false, hasI18nData: false, hasThemesData: false, undecryptable: [],
})

const spies = {
  listStoredKeyboards: vi.fn(),
  typingAnalyticsListKeyboards: vi.fn(),
  typingAnalyticsListDeviceInfos: vi.fn(),
  typingAnalyticsListRemoteCloudHashes: vi.fn(),
  typingAnalyticsListRemoteCloudDays: vi.fn(),
  typingAnalyticsFetchRemoteDay: vi.fn(),
  typingAnalyticsListLocalDeviceDays: vi.fn(),
  typingAnalyticsListItemsForHash: vi.fn(),
  typingAnalyticsDeleteDeviceData: vi.fn(),
  syncScanRemote: vi.fn(),
} satisfies TypingRemoteSpies

beforeEach(() => {
  resetDataNavCache()
  for (const spy of Object.values(spies)) spy.mockReset()
  spies.listStoredKeyboards.mockResolvedValue([])
  spies.typingAnalyticsListKeyboards.mockResolvedValue([])
  spies.typingAnalyticsListDeviceInfos.mockResolvedValue({ own: device('own'), remotes: [device('hash-b'), device('hash-a')] })
  spies.typingAnalyticsListRemoteCloudHashes.mockResolvedValue(['hash-c', 'hash-a'])
  spies.syncScanRemote.mockResolvedValue(scan(['kb-a'], { 'kb-a': 'Scanned A' }))
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

  it('names each keyboard as Sync > Keyboards does: scan, stored, product name, uid', async () => {
    spies.typingAnalyticsListKeyboards.mockResolvedValue([
      { uid: 'kb-b', productName: 'Local B', vendorId: 1, productId: 2 },
      { uid: 'kb-d', productName: 'Local D', vendorId: 1, productId: 2 },
    ])
    spies.syncScanRemote.mockResolvedValue(scan(['kb-a', 'kb-c'], { 'kb-a': 'Scanned A', 'kb-b': 'Scanned B' }))
    spies.listStoredKeyboards.mockResolvedValue([{ uid: 'kb-c', name: 'Stored C' }])
    const { result } = renderHook(() => useDataNavTree({ showHubTab: false, syncEnabled: true }))
    await waitFor(() => expect(result.current.syncTypingKeyboards).toHaveLength(4))
    const names = Object.fromEntries(result.current.syncTypingKeyboards.map((kb) => [kb.uid, kb.name]))
    expect(names).toEqual({ 'kb-a': 'Scanned A', 'kb-b': 'Scanned B', 'kb-c': 'Stored C', 'kb-d': 'Local D' })
  })

  it('names a keyboard only the scan found by its uid when it has no name', async () => {
    spies.syncScanRemote.mockResolvedValue(scan(['kb-x']))
    const { result } = renderHook(() => useDataNavTree({ showHubTab: false, syncEnabled: true }))
    await waitFor(() => expect(result.current.syncTypingKeyboards).toEqual([{ uid: 'kb-x', name: 'kb-x' }]))
  })

  it('scans again each time the sync turns on, and lists nothing while it is off', async () => {
    spies.typingAnalyticsListKeyboards.mockResolvedValue([
      { uid: 'kb-b', productName: 'Local B', vendorId: 1, productId: 2 },
    ])
    const { result, rerender } = renderHook(
      ({ syncEnabled }) => useDataNavTree({ showHubTab: false, syncEnabled }),
      { initialProps: { syncEnabled: true } },
    )
    await waitFor(() => expect(result.current.syncTypingKeyboards).toHaveLength(2))

    rerender({ syncEnabled: false })
    expect(result.current.syncTypingKeyboards).toEqual([])

    spies.syncScanRemote.mockResolvedValue(scan(['kb-c']))
    rerender({ syncEnabled: true })
    await waitFor(() => expect(result.current.syncTypingKeyboards.map((kb) => kb.uid)).toContain('kb-c'))
    expect(spies.syncScanRemote).toHaveBeenCalledTimes(2)
  })

  it('re-reads only the local typing keyboards on a refresh', async () => {
    const { result } = renderHook(() => useDataNavTree({ showHubTab: false, syncEnabled: true }))
    await waitFor(() => expect(spies.syncScanRemote).toHaveBeenCalledTimes(1))
    spies.typingAnalyticsListKeyboards.mockResolvedValue([
      { uid: 'kb-b', productName: 'Local B', vendorId: 1, productId: 2 },
    ])
    await act(() => result.current.refreshTypingKeyboards())
    expect(result.current.typingKeyboards).toHaveLength(1)
    expect(spies.syncScanRemote).toHaveBeenCalledTimes(1)
  })
  it('applies only the newest scan, and keeps scanning until it ends', async () => {
    const answers: ((result: ReturnType<typeof scan>) => void)[] = []
    spies.syncScanRemote.mockImplementation(() => new Promise((resolve) => { answers.push(resolve) }))
    const { result } = renderHook(() => useDataNavTree({ showHubTab: false, syncEnabled: true }))
    await waitFor(() => expect(answers).toHaveLength(1))
    act(() => { void result.current.handleSyncScan() })
    await waitFor(() => expect(answers).toHaveLength(2))

    await act(async () => answers[0](scan(['kb-old'])))
    expect(result.current.syncScanning).toBe(true)
    expect(result.current.rawSyncScanResult).toBeNull()

    await act(async () => answers[1](scan(['kb-new'])))
    expect(result.current.syncScanning).toBe(false)
    expect(result.current.rawSyncScanResult?.typingKeyboards).toEqual(['kb-new'])
  })

  it('drops an older scan that ends after the newest one', async () => {
    const answers: ((result: ReturnType<typeof scan>) => void)[] = []
    spies.syncScanRemote.mockImplementation(() => new Promise((resolve) => { answers.push(resolve) }))
    const { result } = renderHook(() => useDataNavTree({ showHubTab: false, syncEnabled: true }))
    await waitFor(() => expect(answers).toHaveLength(1))
    act(() => { void result.current.handleSyncScan() })
    await waitFor(() => expect(answers).toHaveLength(2))

    await act(async () => answers[1](scan(['kb-new'])))
    await act(async () => answers[0](scan(['kb-old'])))
    expect(result.current.syncScanning).toBe(false)
    expect(result.current.rawSyncScanResult?.typingKeyboards).toEqual(['kb-new'])
  })

  it('forgets the scan and the remote devices when the sync turns off, and reads them again for the next account', async () => {
    const { result, rerender } = renderHook(
      ({ syncEnabled }) => useDataNavTree({ showHubTab: false, syncEnabled }),
      { initialProps: { syncEnabled: true } },
    )
    await waitFor(() => expect(result.current.rawSyncScanResult).not.toBeNull())
    act(() => result.current.ensureRemoteTypingHashes('uid-1'))
    await waitFor(() => expect(result.current.remoteTypingHashes['uid-1']).toEqual(['hash-a', 'hash-b', 'hash-c']))

    rerender({ syncEnabled: false })
    expect(result.current.rawSyncScanResult).toBeNull()
    expect(result.current.remoteTypingHashes).toEqual({})

    spies.typingAnalyticsListDeviceInfos.mockResolvedValue(null)
    spies.typingAnalyticsListRemoteCloudHashes.mockResolvedValue(['hash-z'])
    rerender({ syncEnabled: true })
    act(() => result.current.ensureRemoteTypingHashes('uid-1'))
    await waitFor(() => expect(result.current.remoteTypingHashes['uid-1']).toEqual(['hash-z']))
  })

  it('drops the remote devices of a read that ends after the sync turned off', async () => {
    let answer: (hashes: string[]) => void = () => {}
    spies.typingAnalyticsListRemoteCloudHashes.mockReturnValue(new Promise<string[]>((resolve) => { answer = resolve }))
    const { result, rerender } = renderHook(
      ({ syncEnabled }) => useDataNavTree({ showHubTab: false, syncEnabled }),
      { initialProps: { syncEnabled: true } },
    )
    act(() => result.current.ensureRemoteTypingHashes('uid-1'))
    await waitFor(() => expect(spies.typingAnalyticsListRemoteCloudHashes).toHaveBeenCalledTimes(1))
    rerender({ syncEnabled: false })
    await act(async () => answer(['hash-old']))
    expect(result.current.remoteTypingHashes).toEqual({})
  })
})
