// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDeviceLifecycle } from '../useDeviceLifecycle'
import type { DeviceInfo, KeyboardDefinition, VilFile } from '../../../shared/types/protocol'
import type { SyncScope, SyncOperationResult } from '../../../shared/types/sync'
import type { ReloadResult } from '../keyboard-types'

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
  connectDevice: Mock<(dev: DeviceInfo) => Promise<boolean>>
  disconnectDevice: Mock<() => Promise<void>>
  keyboardReload: Mock<() => Promise<ReloadResult>>
  applyDevicePrefs: Mock<(uid: string) => Promise<void>>
  syncNow: Mock<(direction: 'download' | 'upload', scope?: SyncScope) => Promise<SyncOperationResult>>
}

function makeOptions(overrides: Partial<{
  authenticated: boolean
  autoSync: boolean
  hasPassword: boolean
  reloadUid: string | undefined
  // When set, keyboardReload resolves to this failure instead of the
  // default success — replaces hand-building a keyboardReload mock per test.
  reloadFailure: 'notVial' | 'loadFailed'
  // Defaults to true so the suite below doesn't need to account for an
  // extra syncNow('download', 'packs') call it never asserts on. The
  // dedicated "packs auto-fire" describe block below overrides this to false.
  packsPulledOnce: boolean
  typingRecordEnabled: boolean
}> = {}, mocks?: Partial<Mocks> & { markPacksPulledOnce?: Mock<() => void> }) {
  const connectDevice = mocks?.connectDevice ?? vi.fn().mockResolvedValue(true)
  const disconnectDevice = mocks?.disconnectDevice ?? vi.fn().mockResolvedValue(undefined)
  const keyboardReload = mocks?.keyboardReload ?? vi.fn().mockResolvedValue(
    overrides.reloadFailure
      ? { ok: false, reason: overrides.reloadFailure }
      : { ok: true, uid: overrides.reloadUid ?? 'uid-1' },
  )
  const applyDevicePrefs = mocks?.applyDevicePrefs ?? vi.fn().mockResolvedValue(undefined)
  const syncNow = mocks?.syncNow ?? vi.fn().mockResolvedValue(undefined)
  const markPacksPulledOnce = mocks?.markPacksPulledOnce ?? vi.fn()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).vialAPI = {
    lock: vi.fn().mockResolvedValue(undefined),
    keyboardMetaNameIfMissing: vi.fn().mockResolvedValue(undefined),
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
      packsPulledOnce: overrides.packsPulledOnce ?? true,
      markPacksPulledOnce,
      resetUIState: vi.fn(),
      clearFileStatus: vi.fn(),
      resetHubState: vi.fn(),
      matrixMode: false,
      typingTestMode: false,
      typingTestViewOnly: false,
      typingRecordEnabled: overrides.typingRecordEnabled ?? false,
      saveLastDevice: vi.fn(),
      clearLastDevice: vi.fn(),
    },
    mocks: { connectDevice, disconnectDevice, keyboardReload, applyDevicePrefs, syncNow, markPacksPulledOnce },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useDeviceLifecycle.handleConnect', () => {
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

  it('names the keyboard from its product name on connect', async () => {
    const { options } = makeOptions()
    const { result } = renderHook(() => useDeviceLifecycle(options))

    await act(async () => {
      await result.current.handleConnect(mockDevice)
    })

    expect(window.vialAPI.keyboardMetaNameIfMissing).toHaveBeenCalledWith('uid-1', 'Test Keyboard')
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

  it('records the last device on a genuine connect, and keeps it through the not-Vial-compatible bailout', async () => {
    const { options } = makeOptions({ reloadFailure: 'notVial' })
    const { result } = renderHook(() => useDeviceLifecycle(options))

    await act(async () => {
      await result.current.handleConnect(mockDevice)
    })

    // uid never resolved: nothing saved, and the internal cleanup
    // disconnect must not forget a previously remembered device.
    expect(options.saveLastDevice).not.toHaveBeenCalled()
    expect(options.clearLastDevice).not.toHaveBeenCalled()
    expect(result.current.deviceLoadError).toBe('error.notVialCompatible')

    const genuine = makeOptions()
    const { result: result2 } = renderHook(() => useDeviceLifecycle(genuine.options))
    await act(async () => {
      await result2.current.handleConnect(mockDevice)
    })
    expect(genuine.options.saveLastDevice).toHaveBeenCalledWith(mockDevice)
  })

  it('clears the last device on a user-initiated disconnect', async () => {
    const { options } = makeOptions()
    const { result } = renderHook(() => useDeviceLifecycle(options))

    await act(async () => {
      await result.current.handleDisconnect()
    })

    expect(options.clearLastDevice).toHaveBeenCalled()
  })
})

describe('useDeviceLifecycle.handleConnect — reload failure message split', () => {
  it.each([
    ['notVial', 'error.notVialCompatible'],
    ['loadFailed', 'error.deviceLoadFailed'],
  ] as const)('shows the %s message and disconnects', async (reason, message) => {
    const { options, mocks } = makeOptions({ reloadFailure: reason })
    const { result } = renderHook(() => useDeviceLifecycle(options))

    await act(async () => {
      await result.current.handleConnect(mockDevice)
    })

    expect(result.current.deviceLoadError).toBe(message)
    expect(options.keyboardReset).toHaveBeenCalled()
    expect(mocks.disconnectDevice).toHaveBeenCalled()
  })
})

describe('useDeviceLifecycle — REC-armed auto-lock suspend', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('suspends the auto-lock timer while REC is armed', () => {
    const { options } = makeOptions({ typingRecordEnabled: true })
    options.unlocked = true
    options.autoLockTime = 1
    renderHook(() => useDeviceLifecycle(options))

    vi.advanceTimersByTime(60_000 + 1000)

    expect(window.vialAPI.lock).not.toHaveBeenCalled()
  })

  it('auto-locks as usual when REC is not armed', () => {
    const { options } = makeOptions({ typingRecordEnabled: false })
    options.unlocked = true
    options.autoLockTime = 1
    renderHook(() => useDeviceLifecycle(options))

    vi.advanceTimersByTime(60_000 + 1000)

    expect(window.vialAPI.lock).toHaveBeenCalledOnce()
  })
})

describe('useDeviceLifecycle.handleConnect — packs first-sync auto-fire', () => {
  it('runs a packs-scoped download once and marks it done on success', async () => {
    const syncNow = vi.fn().mockResolvedValue({ success: true, status: 'completed' })
    const { options, mocks } = makeOptions({ packsPulledOnce: false }, { syncNow })
    const { result } = renderHook(() => useDeviceLifecycle(options))

    await act(async () => {
      await result.current.handleConnect(mockDevice)
    })

    expect(syncNow).toHaveBeenCalledWith('download', { favorites: true, keyboard: 'uid-1' })
    expect(syncNow).toHaveBeenCalledWith('download', 'packs')
    expect(mocks.markPacksPulledOnce).toHaveBeenCalledTimes(1)
  })

  it('does not mark done and does not throw when the packs download throws outright', async () => {
    const syncNow = vi.fn().mockImplementation(async (_direction: string, scope?: unknown) => {
      if (scope === 'packs') throw new Error('network error')
      return { success: true, status: 'completed' }
    })
    const { options, mocks } = makeOptions({ packsPulledOnce: false }, { syncNow })
    const { result } = renderHook(() => useDeviceLifecycle(options))

    await act(async () => {
      await result.current.handleConnect(mockDevice)
    })

    expect(syncNow).toHaveBeenCalledWith('download', 'packs')
    expect(mocks.markPacksPulledOnce).not.toHaveBeenCalled()
    // Device prefs must still apply — a packs-pull failure is non-fatal.
    expect(mocks.applyDevicePrefs).toHaveBeenCalledWith('uid-1')
  })

  // M1: the real wiring never throws for a busy race or missing
  // credentials — executeSync/syncExecute resolve normally with
  // status: 'skipped' in both cases (see SyncOperationResult's doc).
  // A mock that throws for this case would never happen in practice;
  // this is the actual shape markPacksPulledOnce must gate on.
  it('does not mark done when the packs pull resolves skipped (busy race with useDeviceAutoSync)', async () => {
    const syncNow = vi.fn().mockImplementation(async (_direction: string, scope?: unknown) => {
      if (scope === 'packs') return { success: true, status: 'skipped', skipReason: 'busy' }
      return { success: true, status: 'completed' }
    })
    const { options, mocks } = makeOptions({ packsPulledOnce: false }, { syncNow })
    const { result } = renderHook(() => useDeviceLifecycle(options))

    await act(async () => {
      await result.current.handleConnect(mockDevice)
    })

    expect(syncNow).toHaveBeenCalledWith('download', 'packs')
    expect(mocks.markPacksPulledOnce).not.toHaveBeenCalled()
    expect(mocks.applyDevicePrefs).toHaveBeenCalledWith('uid-1')
  })

  it('does not mark done when the packs pull resolves partial (a sync unit failed mid-pass)', async () => {
    const syncNow = vi.fn().mockImplementation(async (_direction: string, scope?: unknown) => {
      if (scope === 'packs') return { success: true, status: 'partial', error: '1 sync unit(s) failed' }
      return { success: true, status: 'completed' }
    })
    const { options, mocks } = makeOptions({ packsPulledOnce: false }, { syncNow })
    const { result } = renderHook(() => useDeviceLifecycle(options))

    await act(async () => {
      await result.current.handleConnect(mockDevice)
    })

    expect(mocks.markPacksPulledOnce).not.toHaveBeenCalled()
  })

  it('skips the packs pull entirely once it has already succeeded', async () => {
    const syncNow = vi.fn().mockResolvedValue({ success: true, status: 'completed' })
    const { options, mocks } = makeOptions({ packsPulledOnce: true }, { syncNow })
    const { result } = renderHook(() => useDeviceLifecycle(options))

    await act(async () => {
      await result.current.handleConnect(mockDevice)
    })

    expect(syncNow).not.toHaveBeenCalledWith('download', 'packs')
    expect(mocks.markPacksPulledOnce).not.toHaveBeenCalled()
  })

  it('does not fire the packs pull when autoSync/credentials are not ready', async () => {
    const syncNow = vi.fn().mockResolvedValue({ success: true, status: 'completed' })
    const { options, mocks } = makeOptions({ packsPulledOnce: false, autoSync: false }, { syncNow })
    const { result } = renderHook(() => useDeviceLifecycle(options))

    await act(async () => {
      await result.current.handleConnect(mockDevice)
    })

    expect(syncNow).not.toHaveBeenCalled()
    expect(mocks.markPacksPulledOnce).not.toHaveBeenCalled()
  })
})
