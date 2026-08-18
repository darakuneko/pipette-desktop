// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTypingRecordingTray } from '../use-typing-recording-tray'
import type { DeviceInfo, UnlockStatus } from '../../../shared/types/protocol'
import { EMPTY_UID } from '../../../shared/constants/protocol'

// Mirrors use-view-mode-routing.test.tsx's approach: the hook's Params type
// pins down the full return types of useKeyboard / useDevicePrefs, far
// larger than what this hook actually reads. Build a narrow fixture and
// cast at the call boundary instead of constructing every unrelated field.

function makeDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    vendorId: 0x1234,
    productId: 0x5678,
    productName: 'Test Keyboard',
    serialNumber: 'SN001',
    type: 'vial',
    ...overrides,
  }
}

interface FakeParams {
  keyboard: {
    uid: string
    loading: boolean
    unlockStatus: UnlockStatus
    unlockStatusKnown: boolean
  }
  devicePrefs: {
    typingRecordEnabled: boolean
    appliedUid: string | null
    setTypingRecordEnabled: (enabled: boolean) => void
  }
  typingTestMode: boolean
  isDummy: boolean
  connectedDevice: DeviceInfo | null
  onRequestUnlockDialog: () => void
}

interface Overrides {
  uid?: string
  loading?: boolean
  unlocked?: boolean
  unlockStatusKnown?: boolean
  typingRecordEnabled?: boolean
  appliedUid?: string | null
  typingTestMode?: boolean
  isDummy?: boolean
  connectedDevice?: DeviceInfo | null
  setTypingRecordEnabled?: Mock<(enabled: boolean) => void>
  onRequestUnlockDialog?: Mock<() => void>
}

function makeParams(overrides: Overrides = {}) {
  const setTypingRecordEnabled = overrides.setTypingRecordEnabled ?? vi.fn()
  const onRequestUnlockDialog = overrides.onRequestUnlockDialog ?? vi.fn()

  const params: FakeParams = {
    keyboard: {
      uid: overrides.uid ?? 'UID1',
      loading: overrides.loading ?? false,
      unlockStatus: { unlocked: overrides.unlocked ?? false, inProgress: false, keys: [] },
      unlockStatusKnown: overrides.unlockStatusKnown ?? true,
    },
    devicePrefs: {
      typingRecordEnabled: overrides.typingRecordEnabled ?? false,
      appliedUid: overrides.appliedUid !== undefined ? overrides.appliedUid : (overrides.uid ?? 'UID1'),
      setTypingRecordEnabled,
    },
    typingTestMode: overrides.typingTestMode ?? false,
    isDummy: overrides.isDummy ?? false,
    connectedDevice: overrides.connectedDevice !== undefined ? overrides.connectedDevice : makeDevice(),
    onRequestUnlockDialog,
  }

  return { params, mocks: { setTypingRecordEnabled, onRequestUnlockDialog } }
}

function callHook(params: FakeParams) {
  return useTypingRecordingTray(params as unknown as Parameters<typeof useTypingRecordingTray>[0])
}

/** Keeps identity-sensitive fields (the device object, mocks) stable across
 * `update()` calls unless a test explicitly overrides them — a fresh
 * `makeDevice()` or `vi.fn()` on every rerender would otherwise look like a
 * real dependency change to the hook's effects. */
function renderTray(initial: Overrides = {}) {
  const first = makeParams(initial)
  let current: Overrides = {
    ...initial,
    connectedDevice: first.params.connectedDevice,
    setTypingRecordEnabled: first.mocks.setTypingRecordEnabled,
    onRequestUnlockDialog: first.mocks.onRequestUnlockDialog,
  }

  // StrictMode pins that this hook tolerates React's dev-mode double-invoke
  // of effects/renders without double-firing the unlock request.
  const utils = renderHook(callHook, { initialProps: first.params, wrapper: StrictMode })

  function update(patch: Overrides = {}) {
    current = { ...current, ...patch }
    const { params } = makeParams(current)
    utils.rerender(params)
    return params
  }

  return { ...utils, mocks: first.mocks, update }
}

beforeEach(() => {
  window.vialAPI = {
    trayStatusUpdate: vi.fn().mockResolvedValue(undefined),
    typingAnalyticsSaveKeymapSnapshot: vi.fn().mockResolvedValue(undefined),
  } as unknown as typeof window.vialAPI
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useTypingRecordingTray — REC-unlock gate', () => {
  it('fires once on the rising edge when REC is armed while locked', () => {
    const { mocks } = renderTray({
      connectedDevice: makeDevice(),
      unlocked: false,
      typingRecordEnabled: true,
    })

    expect(mocks.onRequestUnlockDialog).toHaveBeenCalledTimes(1)
  })

  it('does not re-request after the dialog is dismissed while the condition stays continuously true', () => {
    const { mocks, update } = renderTray({
      connectedDevice: makeDevice(),
      unlocked: false,
      typingRecordEnabled: true,
    })
    expect(mocks.onRequestUnlockDialog).toHaveBeenCalledTimes(1)

    // Dismiss here means "still locked, still armed" — an unrelated
    // rerender (e.g. typingTestMode toggling for an unrelated reason) must
    // not re-request while the gate condition itself never went false.
    act(() => { update({ typingTestMode: true }) })
    act(() => { update({ typingTestMode: false }) })

    expect(mocks.onRequestUnlockDialog).toHaveBeenCalledTimes(1)
  })

  it('re-fires when REC is toggled off then back on while still locked', () => {
    const { mocks, update } = renderTray({
      connectedDevice: makeDevice(),
      unlocked: false,
      typingRecordEnabled: false,
    })
    expect(mocks.onRequestUnlockDialog).not.toHaveBeenCalled()

    act(() => { update({ typingRecordEnabled: true }) })
    expect(mocks.onRequestUnlockDialog).toHaveBeenCalledTimes(1)

    act(() => { update({ typingRecordEnabled: false }) })
    expect(mocks.onRequestUnlockDialog).toHaveBeenCalledTimes(1)

    act(() => { update({ typingRecordEnabled: true }) })
    expect(mocks.onRequestUnlockDialog).toHaveBeenCalledTimes(2)
  })

  it('re-fires after a disconnect and reconnect of the same still-locked keyboard', () => {
    const { mocks, update } = renderTray({
      connectedDevice: makeDevice(),
      unlocked: false,
      typingRecordEnabled: true,
      uid: 'UID1',
      appliedUid: 'UID1',
    })
    expect(mocks.onRequestUnlockDialog).toHaveBeenCalledTimes(1)

    act(() => { update({ connectedDevice: null }) })
    act(() => { update({ connectedDevice: makeDevice(), uid: 'UID1', appliedUid: 'UID1' }) })

    expect(mocks.onRequestUnlockDialog).toHaveBeenCalledTimes(2)
  })

  it('re-fires when the uid changes to a different locked keyboard while REC stays armed', () => {
    const { mocks, update } = renderTray({
      connectedDevice: makeDevice(),
      unlocked: false,
      typingRecordEnabled: true,
      uid: 'UID1',
      appliedUid: 'UID1',
    })
    expect(mocks.onRequestUnlockDialog).toHaveBeenCalledTimes(1)

    act(() => { update({ uid: 'UID2', appliedUid: 'UID2' }) })

    expect(mocks.onRequestUnlockDialog).toHaveBeenCalledTimes(2)
  })

  it('does not fire while unlock status is unknown', () => {
    const { mocks } = renderTray({
      connectedDevice: makeDevice(),
      unlocked: false,
      unlockStatusKnown: false,
      typingRecordEnabled: true,
    })

    expect(mocks.onRequestUnlockDialog).not.toHaveBeenCalled()
  })

  it('does not fire while the keyboard is still loading', () => {
    const { mocks } = renderTray({
      connectedDevice: makeDevice(),
      unlocked: false,
      loading: true,
      typingRecordEnabled: true,
    })

    expect(mocks.onRequestUnlockDialog).not.toHaveBeenCalled()
  })

  it('does not fire while devicePrefs.appliedUid has not caught up to the connected uid', () => {
    const { mocks } = renderTray({
      connectedDevice: makeDevice(),
      unlocked: false,
      typingRecordEnabled: true,
      uid: 'UID1',
      appliedUid: 'UID_OLD',
    })

    expect(mocks.onRequestUnlockDialog).not.toHaveBeenCalled()
  })

  it('does not fire for a dummy device or an empty uid', () => {
    const dummy = renderTray({
      connectedDevice: makeDevice(),
      isDummy: true,
      unlocked: false,
      typingRecordEnabled: true,
    })
    expect(dummy.mocks.onRequestUnlockDialog).not.toHaveBeenCalled()

    const emptyUid = renderTray({
      connectedDevice: makeDevice(),
      unlocked: false,
      typingRecordEnabled: true,
      uid: EMPTY_UID,
      appliedUid: EMPTY_UID,
    })
    expect(emptyUid.mocks.onRequestUnlockDialog).not.toHaveBeenCalled()
  })

  it('does not fire once the keyboard is already unlocked', () => {
    const { mocks } = renderTray({
      connectedDevice: makeDevice(),
      unlocked: true,
      typingRecordEnabled: true,
    })

    expect(mocks.onRequestUnlockDialog).not.toHaveBeenCalled()
  })

  it('survives StrictMode double-invoke without double-firing', () => {
    // renderTray already wraps in StrictMode — the "fires once" test above
    // already covers this implicitly, but this test pins it explicitly as
    // its own scenario per the task spec.
    const { mocks } = renderTray({
      connectedDevice: makeDevice(),
      unlocked: false,
      typingRecordEnabled: true,
    })

    expect(mocks.onRequestUnlockDialog).toHaveBeenCalledTimes(1)
  })

  it('manual-lock flow: disarming REC before the lock status lands never re-triggers the gate', () => {
    // Pins the Security row's manual Lock flow (KeycodesOverlayPanel /
    // LockRecOffConfirmModal): REC is disarmed first, and only then does
    // the lock land. If REC were still armed by the time `unlocked` flips
    // to false, this same gate would fire and reopen the unlock dialog —
    // the disarm-before-lock ordering must prevent that.
    const { mocks, update } = renderTray({
      connectedDevice: makeDevice(),
      unlocked: true,
      unlockStatusKnown: true,
      typingRecordEnabled: true,
      uid: 'UID1',
      appliedUid: 'UID1',
    })
    expect(mocks.onRequestUnlockDialog).not.toHaveBeenCalled()

    // REC disarmed first (LockRecOffConfirmModal's onConfirm calls
    // onTypingRecordDisarm before onLock).
    act(() => { update({ typingRecordEnabled: false }) })
    expect(mocks.onRequestUnlockDialog).not.toHaveBeenCalled()

    // Lock status lands afterward.
    act(() => { update({ unlocked: false }) })

    expect(mocks.onRequestUnlockDialog).not.toHaveBeenCalled()
  })

  it('control: if REC were still armed when the lock status lands, the gate would fire once', () => {
    // Inverse of the manual-lock flow test above — proves the sequence
    // actually exercises the gate rather than passing vacuously.
    const { mocks, update } = renderTray({
      connectedDevice: makeDevice(),
      unlocked: true,
      unlockStatusKnown: true,
      typingRecordEnabled: true,
      uid: 'UID1',
      appliedUid: 'UID1',
    })
    expect(mocks.onRequestUnlockDialog).not.toHaveBeenCalled()

    // REC left armed while the lock status lands.
    act(() => { update({ unlocked: false }) })

    expect(mocks.onRequestUnlockDialog).toHaveBeenCalledTimes(1)
  })
})
