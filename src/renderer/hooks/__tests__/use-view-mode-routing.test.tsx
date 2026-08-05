// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useViewModeRouting } from '../use-view-mode-routing'
import type { DeviceInfo, UnlockStatus } from '../../../shared/types/protocol'
import type { ViewMode } from '../../../shared/types/pipette-settings'
import type { KeymapEditorHandle } from '../../components/editors/KeymapEditor'
import { ZOOM_FACTOR_DEFAULT } from '../../../shared/types/app-config'
import { EMPTY_UID } from '../../../shared/constants/protocol'

// The hook's Params interface pins down the FULL return types of
// useDeviceConnection / useKeyboard / useDevicePrefs / useEditorUIState /
// useAppConfig, each far larger than what this hook actually reads. Rather
// than construct every field of those (unrelated) hooks, this file builds
// small literal fixtures covering only the fields use-view-mode-routing.ts
// touches and casts them at the call boundary — the same "narrow fixture,
// cast once" approach as useDeviceLifecycle.test.ts's makeOptions, just
// applied through an extra `as unknown as` step because the real Params
// type is expressed as ReturnType<...> instead of its own named interface.

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
  device: { connectedDevice: DeviceInfo | null; isDummy: boolean }
  keyboard: {
    uid: string
    loading: boolean
    unlockStatus: UnlockStatus
    unlockStatusKnown: boolean
  }
  devicePrefs: {
    viewMode: ViewMode
    appliedUid: string | null
    keyEditorZoom: number | undefined
    typingTestViewOnly: boolean
    typingTestViewOnlyWindowSize: { width: number; height: number } | undefined
    setViewMode: (mode: ViewMode) => void
    setTypingTestViewOnly: (enabled: boolean) => void
  }
  editorUI: {
    typingTestMode: boolean
    resetUIState: () => void
    setShowUnlockDialog: (visible: boolean) => void
  }
  appConfig: { config: { zoomFactor?: number } }
  keymapEditorRef: { current: KeymapEditorHandle | null }
}

interface Overrides {
  connectedDevice?: DeviceInfo | null
  isDummy?: boolean
  uid?: string
  loading?: boolean
  unlocked?: boolean
  unlockStatusKnown?: boolean
  viewMode?: ViewMode
  appliedUid?: string | null
  keyEditorZoom?: number
  typingTestViewOnly?: boolean
  typingTestViewOnlyWindowSize?: { width: number; height: number }
  typingTestMode?: boolean
  zoomFactor?: number
  setViewMode?: Mock<(mode: ViewMode) => void>
  setTypingTestViewOnly?: Mock<(enabled: boolean) => void>
  resetUIState?: Mock<() => void>
  setShowUnlockDialog?: Mock<(visible: boolean) => void>
  toggleTypingTest?: ReturnType<typeof vi.fn>
  keymapEditorRef?: { current: KeymapEditorHandle | null }
}

function makeParams(overrides: Overrides = {}) {
  const setViewMode = overrides.setViewMode ?? vi.fn()
  const setTypingTestViewOnly = overrides.setTypingTestViewOnly ?? vi.fn()
  const resetUIState = overrides.resetUIState ?? vi.fn()
  const setShowUnlockDialog = overrides.setShowUnlockDialog ?? vi.fn()
  const toggleTypingTest = overrides.toggleTypingTest ?? vi.fn()
  const keymapEditorRef = overrides.keymapEditorRef ?? {
    current: { toggleTypingTest } as unknown as KeymapEditorHandle,
  }

  const params: FakeParams = {
    device: {
      connectedDevice: overrides.connectedDevice !== undefined ? overrides.connectedDevice : makeDevice(),
      isDummy: overrides.isDummy ?? false,
    },
    keyboard: {
      uid: overrides.uid ?? 'UID1',
      loading: overrides.loading ?? false,
      unlockStatus: { unlocked: overrides.unlocked ?? false, inProgress: false, keys: [] },
      unlockStatusKnown: overrides.unlockStatusKnown ?? true,
    },
    devicePrefs: {
      viewMode: overrides.viewMode ?? 'editor',
      appliedUid: overrides.appliedUid !== undefined ? overrides.appliedUid : (overrides.uid ?? 'UID1'),
      keyEditorZoom: overrides.keyEditorZoom,
      typingTestViewOnly: overrides.typingTestViewOnly ?? false,
      typingTestViewOnlyWindowSize: overrides.typingTestViewOnlyWindowSize,
      setViewMode,
      setTypingTestViewOnly,
    },
    editorUI: {
      typingTestMode: overrides.typingTestMode ?? false,
      resetUIState,
      setShowUnlockDialog,
    },
    appConfig: { config: { zoomFactor: overrides.zoomFactor } },
    keymapEditorRef,
  }

  return {
    params,
    mocks: { setViewMode, setTypingTestViewOnly, resetUIState, setShowUnlockDialog, toggleTypingTest, keymapEditorRef },
  }
}

function callHook(params: FakeParams) {
  return useViewModeRouting(params as unknown as Parameters<typeof useViewModeRouting>[0])
}

/** Mirrors useSessionRestore.test.ts's flat-overrides style, but also keeps
 * every identity-sensitive field (the device object, every setter mock, the
 * keymapEditorRef object itself) stable across `update()` calls unless a
 * test explicitly overrides it — otherwise a fresh `makeDevice()` or a fresh
 * `vi.fn()` on every rerender would look like a real dependency change to
 * the hook's effects and make every rerender re-fire everything. */
function renderRouting(initial: Overrides = {}) {
  const first = makeParams(initial)
  let current: Overrides = {
    ...initial,
    connectedDevice: first.params.device.connectedDevice,
    setViewMode: first.mocks.setViewMode,
    setTypingTestViewOnly: first.mocks.setTypingTestViewOnly,
    resetUIState: first.mocks.resetUIState,
    setShowUnlockDialog: first.mocks.setShowUnlockDialog,
    toggleTypingTest: first.mocks.toggleTypingTest,
    keymapEditorRef: first.mocks.keymapEditorRef,
  }

  // StrictMode pins that this hook tolerates React's dev-mode double-invoke
  // of effects/renders without double-firing IPC calls or corrupting refs.
  const utils = renderHook(callHook, { initialProps: first.params, wrapper: StrictMode })

  function update(patch: Overrides = {}) {
    current = { ...current, ...patch }
    const { params } = makeParams(current)
    utils.rerender(params)
    return params
  }

  return { ...utils, mocks: first.mocks, update }
}

let vialAPIStub: {
  setWindowCompactMode: ReturnType<typeof vi.fn>
  setWindowAspectRatio: ReturnType<typeof vi.fn>
  setWindowAlwaysOnTop: ReturnType<typeof vi.fn>
  setWindowZoom: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vialAPIStub = {
    setWindowCompactMode: vi.fn().mockResolvedValue(undefined),
    setWindowAspectRatio: vi.fn().mockResolvedValue(undefined),
    setWindowAlwaysOnTop: vi.fn().mockResolvedValue(undefined),
    setWindowZoom: vi.fn().mockResolvedValue(undefined),
  }
  window.vialAPI = vialAPIStub as unknown as typeof window.vialAPI

  // exitViewOnlyMode/handleViewAnalytics/handleAnalyticsBack chain two
  // nested rAF calls before touching vialAPI. Run them synchronously so
  // the promise chain that follows is reachable via a single microtask
  // flush instead of depending on jsdom's real frame scheduling.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Flushes the microtask queue so a `window.vialAPI.*().then(...)` chain
 * that already ran (via the synchronous rAF stub above) gets to resolve. */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useViewModeRouting', () => {
  describe('disconnect cleanup', () => {
    it('resets ephemeral UI, tears down the view-only window, and clears pendingTypingTestSaveRef so no deferred save fires after reconnect', () => {
      const { result, update, mocks } = renderRouting({
        connectedDevice: makeDevice(),
        typingTestViewOnly: true,
        typingTestMode: false,
        unlocked: false,
        viewMode: 'editor',
        uid: 'UID1',
        appliedUid: 'UID1',
      })

      // Arm pendingViewOnlyRef too, for realism (a locked click on the
      // StatusBar view-only toggle) — but this half is NOT what this test
      // pins: the deferred-view-only effect's own `if (!device.connectedDevice)
      // { pendingViewOnlyRef.current = false; return }` early return clears
      // it independently on every disconnect, so "no deferred entry after
      // reconnect" would hold even if the disconnect-cleanup effect's own
      // reset of this ref were deleted.
      act(() => { result.current.onStatusBarViewOnlyChange() })
      expect(mocks.setShowUnlockDialog).toHaveBeenCalledWith(true)

      // Arm pendingTypingTestSaveRef via a real user action (StatusBar
      // typing-test toggle while not yet in typing-test mode). This half
      // IS what this test pins — nothing else clears it on disconnect.
      act(() => { result.current.onStatusBarTypingTestModeChange() })
      expect(mocks.toggleTypingTest).toHaveBeenCalledTimes(1)

      // Disconnect: wasConnected && !connectedDevice.
      act(() => { update({ connectedDevice: null }) })

      expect(mocks.resetUIState).toHaveBeenCalledTimes(1)
      expect(vialAPIStub.setWindowCompactMode).toHaveBeenCalledWith(false)
      expect(vialAPIStub.setWindowAspectRatio).toHaveBeenCalledWith(0)
      expect(vialAPIStub.setWindowAlwaysOnTop).toHaveBeenCalledWith(false)
      expect(mocks.setTypingTestViewOnly).toHaveBeenCalledWith(false)

      // Reconnect and flip typingTestMode on (deliberately leaving the
      // keyboard locked — unlocking would also exercise the independent
      // deferred-view-only clear above, which is not this test's concern):
      // if pendingTypingTestSaveRef had survived, this would fire a
      // deferred setViewMode('typingTest').
      act(() => { update({ connectedDevice: makeDevice(), typingTestMode: true }) })

      expect(mocks.setViewMode).not.toHaveBeenCalled()
    })

    it('clears pendingTypingTestReentryRef on disconnect so a later unrelated Back does not spuriously re-enter the typing test (Task-clear-typing-reentry-ref-on-disconnect.md)', async () => {
      // pendingTypingTestReentryRef has no public getter, so this pins the
      // fix through its one observable consequence: arm it while the
      // Analyze page is already closed (openRunTimeline's own
      // setAnalyticsPageOpen(false) is then a no-op, so React never reruns
      // the effect that would otherwise consume the ref in the very same
      // commit), disconnect+reconnect, then walk through Analyze via an
      // *unrelated* 'editor' origin. The disconnect-cleanup effect now
      // resets the ref alongside the other three, so this Back must NOT
      // fire the toggle.
      const { result, update, mocks } = renderRouting({ typingTestMode: false })

      act(() => { result.current.openRunTimeline('run-1') })
      expect(mocks.toggleTypingTest).not.toHaveBeenCalled()

      act(() => { update({ connectedDevice: null }) })
      act(() => { update({ connectedDevice: makeDevice() }) })

      act(() => { result.current.handleViewAnalytics('editor') })
      await flushMicrotasks()
      expect(result.current.analyticsPageOpen).toBe(true)

      act(() => { result.current.handleAnalyticsBack() })

      // The stale ref from the unrelated earlier openRunTimeline call was
      // cleared on disconnect, so this 'editor'-origin Back does not
      // re-enter the typing test.
      expect(mocks.toggleTypingTest).not.toHaveBeenCalled()
    })
  })

  describe('deferred view-only entry after unlock', () => {
    it('enters typing-view-only exactly once after the keyboard unlocks', async () => {
      const { result, update, mocks } = renderRouting({ unlocked: false, viewMode: 'editor' })

      act(() => { result.current.onStatusBarViewOnlyChange() })
      expect(mocks.setShowUnlockDialog).toHaveBeenCalledWith(true)
      expect(mocks.setViewMode).not.toHaveBeenCalled()

      act(() => { update({ unlocked: true }) })
      await flushMicrotasks()

      expect(mocks.setViewMode).toHaveBeenCalledWith('typingView')
      expect(mocks.setViewMode).toHaveBeenCalledTimes(1)
      expect(vialAPIStub.setWindowCompactMode).toHaveBeenCalledWith(true, undefined)
      expect(mocks.setTypingTestViewOnly).toHaveBeenCalledWith(true)
      expect(mocks.toggleTypingTest).toHaveBeenCalledTimes(1)

      // One-shot: a further unrelated rerender at unlocked=true must not
      // re-enter (pendingViewOnlyRef was consumed).
      act(() => { update({ typingTestMode: true }) })
      expect(mocks.setViewMode).toHaveBeenCalledTimes(1)
    })
  })

  describe('deferred typing-test save', () => {
    it('commits setViewMode("typingTest") once typingTestMode actually transitions on', () => {
      const { result, update, mocks } = renderRouting({ typingTestMode: false })

      // StatusBar toggle while not yet in typing-test mode arms the
      // deferred save and asks KeymapEditor to flip its own state.
      act(() => { result.current.onStatusBarTypingTestModeChange() })
      expect(mocks.toggleTypingTest).toHaveBeenCalledTimes(1)
      expect(mocks.setViewMode).not.toHaveBeenCalled()

      // KeymapEditor's own state actually flips on (simulated here via the
      // editorUI.typingTestMode prop, since that state lives outside this hook).
      act(() => { update({ typingTestMode: true }) })

      expect(mocks.setViewMode).toHaveBeenCalledWith('typingTest')
      expect(mocks.setViewMode).toHaveBeenCalledTimes(1)

      // One-shot: flipping again must not re-commit.
      act(() => { update({ typingTestMode: false }) })
      act(() => { update({ typingTestMode: true }) })
      expect(mocks.setViewMode).toHaveBeenCalledTimes(1)
    })
  })

  describe('analytics re-entry after Back', () => {
    it('re-enters the typing test once the editor remounts, but only if the live ref lands before the Back commit', async () => {
      const { result, mocks, update } = renderRouting({ typingTestMode: false })

      act(() => { result.current.handleViewAnalytics('typingTest') })
      await flushMicrotasks()
      expect(result.current.analyticsPageOpen).toBe(true)

      // KeymapEditor unmounts while the Analyze page is open — the real
      // App.tsx ref goes null during this window.
      mocks.keymapEditorRef.current = null

      // Back arms pendingTypingTestReentryRef and flips analyticsPageOpen
      // false in the same synchronous call; the effect that consumes the
      // ref runs in this same commit. The remount must land BEFORE that —
      // assigning the live handle after this act would be inert, since the
      // effect already cleared the ref (with a null ref, silently skipping
      // the toggle) the instant it saw analyticsPageOpen go false.
      act(() => {
        mocks.keymapEditorRef.current = { toggleTypingTest: mocks.toggleTypingTest } as unknown as KeymapEditorHandle
        result.current.handleAnalyticsBack()
      })

      expect(mocks.toggleTypingTest).toHaveBeenCalledTimes(1)

      // One-shot: the remount effect must reset pendingTypingTestReentryRef
      // itself (not merely rely on analyticsPageOpen staying false).
      // Flipping an unrelated dep (typingTestMode) reruns the effect twice
      // more — it must stay a no-op both times, proving the ref was
      // actually cleared rather than just skipped-over.
      act(() => { update({ typingTestMode: true }) })
      act(() => { update({ typingTestMode: false }) })
      expect(mocks.toggleTypingTest).toHaveBeenCalledTimes(1)
    })

    it('does not re-enter when the live ref is assigned only after the Back commit', async () => {
      const { result, mocks } = renderRouting({ typingTestMode: false })

      act(() => { result.current.handleViewAnalytics('typingTest') })
      await flushMicrotasks()
      expect(result.current.analyticsPageOpen).toBe(true)

      mocks.keymapEditorRef.current = null

      // Back commits with the ref still null — the remount effect consumes
      // and clears pendingTypingTestReentryRef right here, silently
      // skipping the toggle since there is nothing to call it on.
      act(() => { result.current.handleAnalyticsBack() })

      // Too late: assigning the live handle after the commit cannot revive
      // an already-cleared pending flag.
      mocks.keymapEditorRef.current = { toggleTypingTest: mocks.toggleTypingTest } as unknown as KeymapEditorHandle

      expect(mocks.toggleTypingTest).not.toHaveBeenCalled()
    })
  })

  describe('handleAnalyticsBack origin branches', () => {
    it("re-enters typing-view-only for the 'typingView' origin (compact-mode IPC observable)", () => {
      const { result } = renderRouting({ typingTestMode: false })

      act(() => { result.current.handleAnalyticsBack() })

      // Default origin ref starts as 'typingView' (matches App.tsx's
      // initial analyticsOriginRef value), so Back without a prior
      // handleViewAnalytics call already exercises this branch.
      expect(vialAPIStub.setWindowCompactMode).toHaveBeenCalledWith(true, undefined)
    })

    it("returns to the plain editor (not typingView) for the 'editor' origin", async () => {
      const { result, mocks } = renderRouting({ typingTestMode: false })

      act(() => { result.current.handleViewAnalytics('editor') })
      await flushMicrotasks()
      mocks.setViewMode.mockClear()

      act(() => { result.current.handleAnalyticsBack() })

      expect(mocks.setViewMode).toHaveBeenCalledWith('editor')
      expect(mocks.setViewMode).not.toHaveBeenCalledWith('typingView')
    })
  })

  describe('viewExitTransition', () => {
    it('flips true then clears once handleViewAnalytics resolves', async () => {
      const { result } = renderRouting({})
      expect(result.current.viewExitTransition).toBe(false)

      act(() => { result.current.handleViewAnalytics('typingView') })
      expect(result.current.viewExitTransition).toBe(true)

      await flushMicrotasks()
      expect(result.current.viewExitTransition).toBe(false)
    })

    it('flips true then clears once exitViewOnlyMode resolves (via onTypingTestViewOnlyChange(false))', async () => {
      const { result } = renderRouting({})

      act(() => { result.current.onTypingTestViewOnlyChange(false) })
      expect(result.current.viewExitTransition).toBe(true)

      await flushMicrotasks()
      expect(result.current.viewExitTransition).toBe(false)
    })

    it('clears without opening Analyze when the compact-mode IPC rejects', async () => {
      vialAPIStub.setWindowCompactMode.mockRejectedValueOnce(new Error('ipc failed'))
      const { result } = renderRouting({})

      act(() => { result.current.handleViewAnalytics('typingView') })
      expect(result.current.viewExitTransition).toBe(true)

      await flushMicrotasks()

      expect(result.current.viewExitTransition).toBe(false)
      expect(result.current.analyticsPageOpen).toBe(false)
    })
  })

  describe('handleViewAnalytics entry side effects', () => {
    it('flips the persisted viewMode back to "editor" (session-restore intent) and clears typingTestViewOnly', async () => {
      const { result, mocks } = renderRouting({})

      act(() => { result.current.handleViewAnalytics('typingView') })
      await flushMicrotasks()

      expect(mocks.setViewMode).toHaveBeenCalledWith('editor')
      expect(mocks.setTypingTestViewOnly).toHaveBeenCalledWith(false)
    })
  })

  describe('viewMode auto-restore', () => {
    it('restores typingTest mode once per uid: same uid does not re-fire, a new uid does', () => {
      const { mocks, update } = renderRouting({ viewMode: 'typingTest', uid: 'UID1', appliedUid: 'UID1' })

      expect(mocks.toggleTypingTest).toHaveBeenCalledTimes(1)

      // Same uid, but an unrelated dep (unlockStatus.unlocked) changes —
      // this is exactly what restoreRequestedUidRef exists to guard
      // against: the effect reruns yet must not restore again.
      act(() => { update({ unlocked: true }) })
      expect(mocks.toggleTypingTest).toHaveBeenCalledTimes(1)

      // A new uid (new device/profile) restores again.
      act(() => { update({ uid: 'UID2', appliedUid: 'UID2' }) })
      expect(mocks.toggleTypingTest).toHaveBeenCalledTimes(2)
    })

    it('does not restore while devicePrefs.appliedUid has not caught up to a new uid, and does not burn the per-uid guard for it', () => {
      const { mocks, update } = renderRouting({ viewMode: 'typingTest', uid: 'UID1', appliedUid: 'UID1' })
      expect(mocks.toggleTypingTest).toHaveBeenCalledTimes(1)

      // uid changes (new device/profile) but appliedUid is still catching
      // up from the previous keyboard's prefs load — appliedUid !== uid
      // must block the restore, since devicePrefs.viewMode right now still
      // reflects the OLD keyboard.
      act(() => { update({ uid: 'UID2', appliedUid: 'UID1' }) })
      expect(mocks.toggleTypingTest).toHaveBeenCalledTimes(1)

      // appliedUid catches up to the new uid — restoreRequestedUidRef must
      // not have been burned for UID2 already while blocked above, so the
      // restore fires now instead of being silently skipped forever.
      act(() => { update({ appliedUid: 'UID2' }) })
      expect(mocks.toggleTypingTest).toHaveBeenCalledTimes(2)
    })

    it('suppresses the restore while loading, before a real uid is known, or for a dummy device', () => {
      const loading = renderRouting({ viewMode: 'typingTest', loading: true, uid: 'UID1', appliedUid: 'UID1' })
      expect(loading.mocks.toggleTypingTest).not.toHaveBeenCalled()

      const emptyUid = renderRouting({ viewMode: 'typingTest', uid: EMPTY_UID, appliedUid: EMPTY_UID })
      expect(emptyUid.mocks.toggleTypingTest).not.toHaveBeenCalled()

      const dummy = renderRouting({ viewMode: 'typingTest', isDummy: true, uid: 'UID1', appliedUid: 'UID1' })
      expect(dummy.mocks.toggleTypingTest).not.toHaveBeenCalled()
    })

    it('enters typing-view-only directly when already unlocked, toggling the typing test on', async () => {
      const { mocks } = renderRouting({ viewMode: 'typingView', unlocked: true, uid: 'UID1', appliedUid: 'UID1' })
      await flushMicrotasks()

      expect(vialAPIStub.setWindowCompactMode).toHaveBeenCalledWith(true, undefined)
      expect(mocks.setTypingTestViewOnly).toHaveBeenCalledWith(true)
      expect(mocks.setShowUnlockDialog).not.toHaveBeenCalled()
      expect(mocks.toggleTypingTest).toHaveBeenCalledTimes(1)
    })

    it('does not toggle the typing test again when auto-restoring typingView while already in typing-test mode', async () => {
      const { mocks } = renderRouting({
        viewMode: 'typingView', unlocked: true, typingTestMode: true, uid: 'UID1', appliedUid: 'UID1',
      })
      await flushMicrotasks()

      expect(vialAPIStub.setWindowCompactMode).toHaveBeenCalledWith(true, undefined)
      expect(mocks.toggleTypingTest).not.toHaveBeenCalled()
    })

    it('shows the unlock dialog and defers entry when locked but unlock status is known', () => {
      const { mocks } = renderRouting({
        viewMode: 'typingView', unlocked: false, unlockStatusKnown: true, uid: 'UID1', appliedUid: 'UID1',
      })

      expect(mocks.setShowUnlockDialog).toHaveBeenCalledWith(true)
      expect(vialAPIStub.setWindowCompactMode).not.toHaveBeenCalled()
    })

    it('skips the restore entirely when the unlock status is unknown', () => {
      const { mocks } = renderRouting({
        viewMode: 'typingView', unlocked: false, unlockStatusKnown: false, uid: 'UID1', appliedUid: 'UID1',
      })

      expect(mocks.setShowUnlockDialog).not.toHaveBeenCalled()
      expect(vialAPIStub.setWindowCompactMode).not.toHaveBeenCalled()
    })
  })

  describe('window zoom effect', () => {
    it('applies the per-keyboard keyEditorZoom override on mount, in one call', () => {
      renderRouting({ viewMode: 'editor', keyEditorZoom: 150, zoomFactor: 100 })

      expect(vialAPIStub.setWindowZoom).toHaveBeenCalledWith(150)
      expect(vialAPIStub.setWindowZoom).toHaveBeenCalledTimes(1)
    })

    it('short-circuits when a dependency changes but the computed zoom does not, and re-fires when it does', () => {
      const { update } = renderRouting({ viewMode: 'editor', keyEditorZoom: 150, zoomFactor: 100 })
      expect(vialAPIStub.setWindowZoom).toHaveBeenCalledTimes(1)

      // appConfig.zoomFactor changes, but viewMode is 'editor' so
      // keyEditorZoom (150) still wins — the computed zoom is unchanged.
      act(() => { update({ zoomFactor: 200 }) })
      expect(vialAPIStub.setWindowZoom).toHaveBeenCalledTimes(1)

      // keyEditorZoom itself changes — the computed zoom now differs.
      act(() => { update({ keyEditorZoom: 175 }) })
      expect(vialAPIStub.setWindowZoom).toHaveBeenCalledTimes(2)
      expect(vialAPIStub.setWindowZoom).toHaveBeenLastCalledWith(175)
    })

    it('falls back to the app-wide zoom factor default when nothing overrides it', () => {
      renderRouting({ viewMode: 'editor', keyEditorZoom: undefined, zoomFactor: undefined })

      expect(vialAPIStub.setWindowZoom).toHaveBeenCalledWith(ZOOM_FACTOR_DEFAULT)
    })

    it('does not re-fire on disconnect when the app-wide zoom already matches the per-keyboard override', () => {
      // device.connectedDevice going null makes the ternary fall back to
      // appZoom — with zoomFactor equal to keyEditorZoom here, the
      // recomputed value coincidentally matches prevZoomRef, so this pins
      // the connectedDevice branch of the ternary itself (a dependency none
      // of the other zoom tests above ever change) without a spurious call.
      const { update } = renderRouting({ viewMode: 'editor', keyEditorZoom: 150, zoomFactor: 150 })
      expect(vialAPIStub.setWindowZoom).toHaveBeenCalledTimes(1)

      act(() => { update({ connectedDevice: null }) })

      expect(vialAPIStub.setWindowZoom).toHaveBeenCalledTimes(1)
    })
  })

  describe('onTypingTestViewOnlyChange (KeymapEditor prop)', () => {
    it('disabling exits view-only: setViewMode("editor") then the exit teardown', async () => {
      const { result, mocks } = renderRouting()

      act(() => { result.current.onTypingTestViewOnlyChange(false) })
      expect(mocks.setViewMode).toHaveBeenCalledWith('editor')

      await flushMicrotasks()

      expect(vialAPIStub.setWindowCompactMode).toHaveBeenCalledWith(false)
      expect(mocks.setTypingTestViewOnly).toHaveBeenCalledWith(false)
      expect(mocks.toggleTypingTest).toHaveBeenCalledTimes(1)
    })

    it('enabling enters view-only: setViewMode("typingView") + setTypingTestViewOnly(true)', () => {
      const { result, mocks } = renderRouting()

      act(() => { result.current.onTypingTestViewOnlyChange(true) })

      expect(mocks.setViewMode).toHaveBeenCalledWith('typingView')
      expect(mocks.setTypingTestViewOnly).toHaveBeenCalledWith(true)
      // Direct enable is not the deferred/enterTypingViewOnly path — it
      // does not touch the compact-window IPC itself.
      expect(vialAPIStub.setWindowCompactMode).not.toHaveBeenCalled()
    })
  })

  describe('onStatusBarViewOnlyChange (StatusBar prop)', () => {
    it('exits view-only when already in it', async () => {
      const { result, mocks } = renderRouting({ typingTestMode: true, typingTestViewOnly: true })

      act(() => { result.current.onStatusBarViewOnlyChange() })
      expect(mocks.setViewMode).toHaveBeenCalledWith('editor')

      await flushMicrotasks()
      expect(vialAPIStub.setWindowCompactMode).toHaveBeenCalledWith(false)
    })

    it('shows the unlock dialog instead of entering when locked', () => {
      const { result, mocks } = renderRouting({ unlocked: false })

      act(() => { result.current.onStatusBarViewOnlyChange() })

      expect(mocks.setShowUnlockDialog).toHaveBeenCalledWith(true)
      expect(mocks.setViewMode).not.toHaveBeenCalled()
      expect(vialAPIStub.setWindowCompactMode).not.toHaveBeenCalled()
    })

    it('enters view-only directly when unlocked and not already in it', async () => {
      const { result, mocks } = renderRouting({ unlocked: true, typingTestMode: false })

      act(() => { result.current.onStatusBarViewOnlyChange() })
      expect(mocks.setViewMode).toHaveBeenCalledWith('typingView')

      await flushMicrotasks()
      expect(vialAPIStub.setWindowCompactMode).toHaveBeenCalledWith(true, undefined)
    })
  })

  describe('onStatusBarTypingTestModeChange (StatusBar prop)', () => {
    it('exits to editor and toggles when already in typing-test mode', () => {
      const { result, mocks } = renderRouting({ typingTestMode: true })

      act(() => { result.current.onStatusBarTypingTestModeChange() })

      expect(mocks.setViewMode).toHaveBeenCalledWith('editor')
      expect(mocks.toggleTypingTest).toHaveBeenCalledTimes(1)
    })

    it('arms the deferred save and toggles when not yet in typing-test mode', () => {
      const { result, mocks } = renderRouting({ typingTestMode: false })

      act(() => { result.current.onStatusBarTypingTestModeChange() })

      // No immediate setViewMode — the commit is deferred to the
      // typingTestMode-transition effect (covered separately above).
      expect(mocks.setViewMode).not.toHaveBeenCalled()
      expect(mocks.toggleTypingTest).toHaveBeenCalledTimes(1)
    })
  })
})
