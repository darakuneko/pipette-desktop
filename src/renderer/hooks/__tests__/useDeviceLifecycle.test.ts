// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDeviceLifecycle } from '../useDeviceLifecycle'
import type { DeviceInfo, KeyboardDefinition, VilFile } from '../../../shared/types/protocol'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const mockDevice: DeviceInfo = {
  vendorId: 0x1234,
  productId: 0x5678,
  productName: 'Test Keyboard',
  serialNumber: 'SN001',
  type: 'vial',
}

interface Mocks {
  connectDevice: ReturnType<typeof vi.fn>
  disconnectDevice: ReturnType<typeof vi.fn>
  keyboardReload: ReturnType<typeof vi.fn>
  applyDevicePrefs: ReturnType<typeof vi.fn>
  syncNow: ReturnType<typeof vi.fn>
}

function makeOptions(overrides: Partial<{
  authenticated: boolean
  autoSync: boolean
  hasPassword: boolean
  reloadUid: string | undefined
}> = {}, mocks?: Partial<Mocks>) {
  const connectDevice = mocks?.connectDevice ?? vi.fn().mockResolvedValue(true)
  const disconnectDevice = mocks?.disconnectDevice ?? vi.fn().mockResolvedValue(undefined)
  const keyboardReload = mocks?.keyboardReload ??
    vi.fn().mockResolvedValue(overrides.reloadUid ?? 'uid-1')
  const applyDevicePrefs = mocks?.applyDevicePrefs ?? vi.fn().mockResolvedValue(undefined)
  const syncNow = mocks?.syncNow ?? vi.fn().mockResolvedValue(undefined)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).vialAPI = {
    lock: vi.fn().mockResolvedValue(undefined),
  }

  return {
    options: {
      connectDevice,
      disconnectDevice,
      connectDummy: vi.fn(),
      connectPipetteFile: vi.fn(),
      isPipetteFile: false,
      keyboardUid: undefined,
      keyboardReload,
      keyboardReset: vi.fn(),
      keyboardLoadDummy: vi.fn() as (def: KeyboardDefinition) => void,
      keyboardLoadPipetteFile: vi.fn() as (vil: VilFile) => void,
      refreshUnlockStatus: vi.fn().mockResolvedValue(undefined),
      unlocked: false,
      activityCount: 0,
      applyDevicePrefs,
      autoLockTime: 0,
      autoSync: overrides.autoSync ?? true,
      authenticated: overrides.authenticated ?? true,
      hasPassword: overrides.hasPassword ?? true,
      syncNow,
      deviceSyncing: false,
      resetUIState: vi.fn(),
      clearFileStatus: vi.fn(),
      resetHubState: vi.fn(),
      matrixMode: false,
      typingTestMode: false,
      typingTestViewOnly: false,
    },
    mocks: { connectDevice, disconnectDevice, keyboardReload, applyDevicePrefs, syncNow },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useDeviceLifecycle.handleConnect — issue #190 regression', () => {
  it('downloads cloud settings BEFORE applying device prefs when sync is ready', async () => {
    const callOrder: string[] = []
    const syncNow = vi.fn().mockImplementation(async () => {
      callOrder.push('syncNow')
    })
    const applyDevicePrefs = vi.fn().mockImplementation(async () => {
      callOrder.push('applyDevicePrefs')
    })

    const { options } = makeOptions({}, { syncNow, applyDevicePrefs })
    const { result } = renderHook(() => useDeviceLifecycle(options))

    await act(async () => {
      await result.current.handleConnect(mockDevice)
    })

    expect(callOrder).toEqual(['syncNow', 'applyDevicePrefs'])
    expect(syncNow).toHaveBeenCalledWith('download', { favorites: true, keyboard: 'uid-1' })
  })

  it('skips sync download when autoSync is disabled', async () => {
    const { options, mocks } = makeOptions({ autoSync: false })
    const { result } = renderHook(() => useDeviceLifecycle(options))

    await act(async () => {
      await result.current.handleConnect(mockDevice)
    })

    expect(mocks.syncNow).not.toHaveBeenCalled()
    expect(mocks.applyDevicePrefs).toHaveBeenCalledWith('uid-1')
  })

  it('skips sync download when not authenticated', async () => {
    const { options, mocks } = makeOptions({ authenticated: false })
    const { result } = renderHook(() => useDeviceLifecycle(options))

    await act(async () => {
      await result.current.handleConnect(mockDevice)
    })

    expect(mocks.syncNow).not.toHaveBeenCalled()
    expect(mocks.applyDevicePrefs).toHaveBeenCalledWith('uid-1')
  })

  it('still applies device prefs when sync download fails', async () => {
    const syncNow = vi.fn().mockRejectedValue(new Error('network error'))
    const { options, mocks } = makeOptions({}, { syncNow })
    const { result } = renderHook(() => useDeviceLifecycle(options))

    await act(async () => {
      await result.current.handleConnect(mockDevice)
    })

    expect(syncNow).toHaveBeenCalled()
    expect(mocks.applyDevicePrefs).toHaveBeenCalledWith('uid-1')
  })
})
