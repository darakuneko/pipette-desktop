// SPDX-License-Identifier: GPL-2.0-or-later
// View-mode routing/orchestration: Typing View (compact window) <-> full
// Typing Test <-> Analyze page <-> plain editor, plus the deferred-intent
// refs that carry a user action across an Unlock dialog or an
// analytics-page unmount/remount. Split out of App.tsx (Task-split-app-tsx).

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { AnalyticsOrigin } from '../components/editors/keymap-editor-types'
import type { KeymapEditorHandle } from '../components/editors/KeymapEditor'
import { useRunTimelineHandoff } from './useRunTimelineHandoff'
import { ZOOM_FACTOR_DEFAULT } from '../../shared/types/app-config'
import { EMPTY_UID } from '../../shared/constants/protocol'
import type { useDeviceConnection } from './useDeviceConnection'
import type { useKeyboard } from './useKeyboard'
import type { UseDevicePrefsReturn } from './useDevicePrefs'
import type { useEditorUIState } from './useEditorUIState'
import type { useAppConfig } from './useAppConfig'

interface Params {
  device: ReturnType<typeof useDeviceConnection>
  keyboard: ReturnType<typeof useKeyboard>
  devicePrefs: UseDevicePrefsReturn
  editorUI: ReturnType<typeof useEditorUIState>
  appConfig: ReturnType<typeof useAppConfig>
  keymapEditorRef: RefObject<KeymapEditorHandle | null>
}

export function useViewModeRouting({
  device,
  keyboard,
  devicePrefs,
  editorUI,
  appConfig,
  keymapEditorRef,
}: Params) {
  // Hide content during view→edit transition animation
  const [viewExitTransition, setViewExitTransition] = useState(false)

  // Analytics page shell. Session-local boolean — entering the page
  // from the REC tab of the typing view exits the compact window
  // and hands the main content area over to TypingAnalyticsPage.
  const [analyticsPageOpen, setAnalyticsPageOpen] = useState(false)
  // Where the user opened Analyze from, so Back returns there: the compact
  // Typing View or the full-screen Typing Test.
  const analyticsOriginRef = useRef<AnalyticsOrigin>('typingView')

  // Exit view-only mode: hide content → wait for paint → resize → show editor
  const exitViewOnlyMode = useCallback(() => {
    setViewExitTransition(true)
    requestAnimationFrame(() => { requestAnimationFrame(() => {
      window.vialAPI.setWindowCompactMode(false).then(() => {
        devicePrefs.setTypingTestViewOnly(false)
        keymapEditorRef.current?.toggleTypingTest()
        setViewExitTransition(false)
      }).catch(() => { setViewExitTransition(false) })
    }) })
  }, [devicePrefs])

  const handleViewAnalytics = useCallback((origin: AnalyticsOrigin) => {
    // Each entry point states its own origin so Back returns there.
    analyticsOriginRef.current = origin
    setViewExitTransition(true)
    requestAnimationFrame(() => { requestAnimationFrame(() => {
      window.vialAPI.setWindowCompactMode(false).then(() => {
        devicePrefs.setTypingTestViewOnly(false)
        // Leaving the typing view — flip the persisted viewMode back
        // to 'editor' too so the next session-restore doesn't reopen
        // the compact window behind the analytics page.
        devicePrefs.setViewMode('editor')
        if (editorUI.typingTestMode) keymapEditorRef.current?.toggleTypingTest()
        setAnalyticsPageOpen(true)
        setViewExitTransition(false)
      }).catch(() => { setViewExitTransition(false) })
    }) })
  }, [devicePrefs, editorUI.typingTestMode])

  // Enter typing view-only mode (compact window + typing test). Assumes unlocked.
  const { typingTestViewOnlyWindowSize, setTypingTestViewOnly } = devicePrefs
  const enterTypingViewOnly = useCallback(() => {
    window.vialAPI.setWindowCompactMode(true, typingTestViewOnlyWindowSize).then(() => {
      setTypingTestViewOnly(true)
      if (!editorUI.typingTestMode) {
        keymapEditorRef.current?.toggleTypingTest()
      }
    }).catch(() => {})
  }, [typingTestViewOnlyWindowSize, setTypingTestViewOnly, editorUI.typingTestMode])

  // One-shot guard: prevents re-restoring the same uid after an initial restore.
  // Must survive StrictMode's double-invoke — the ref persists across the
  // extra mount/cleanup/mount pass, so the second pass still sees it as fired.
  const restoreRequestedUidRef = useRef<string | null>(null)

  // Pending refs for deferred user intents (set while unlock dialog is open)
  const pendingViewOnlyRef = useRef(false)
  const pendingTypingTestSaveRef = useRef(false)
  // Re-enter the full typing test after returning from the analytics page —
  // deferred because KeymapEditor (which owns the typing test) only remounts
  // once analyticsPageOpen flips back to false.
  const pendingTypingTestReentryRef = useRef(false)
  const prevZoomRef = useRef<number | null>(null)

  // Back from the analytics page returns the user to wherever they came
  // from (recorded in analyticsOriginRef): the full-screen Typing Test or
  // the compact Typing View. Re-enter that view in one step so they land
  // exactly where they were before clicking View Analytics.
  const handleAnalyticsBack = useCallback(() => {
    setAnalyticsPageOpen(false)
    if (analyticsOriginRef.current === 'typingTest') {
      // KeymapEditor is unmounted while the analytics page is open, so its
      // ref is null right now — defer the typing-test re-entry to an effect
      // that fires after the editor remounts (see below).
      devicePrefs.setViewMode('typingTest')
      pendingTypingTestReentryRef.current = true
    } else if (analyticsOriginRef.current === 'editor') {
      // Opened straight from the editor's own footer — there is no compact
      // window or typing test to re-enter, just return to the plain editor.
      devicePrefs.setViewMode('editor')
    } else {
      enterTypingViewOnly()
      devicePrefs.setViewMode('typingView')
    }
  }, [enterTypingViewOnly, devicePrefs])

  const { setViewMode } = devicePrefs
  const { resetUIState } = editorUI

  const { timelineHandoff, openRunTimeline } = useRunTimelineHandoff({
    setAnalyticsPageOpen, setViewMode, pendingTypingTestReentryRef,
  })

  // Guard must survive StrictMode's double-invoke: the ref carries the prior
  // connected value across the extra mount/cleanup/mount pass so cleanup only
  // fires on a real connected -> disconnected transition, not a remount.
  const prevConnectedRef = useRef(device.connectedDevice)
  useEffect(() => {
    const wasConnected = prevConnectedRef.current
    prevConnectedRef.current = device.connectedDevice
    if (wasConnected && !device.connectedDevice) {
      restoreRequestedUidRef.current = null
      pendingViewOnlyRef.current = false
      pendingTypingTestSaveRef.current = false
      pendingTypingTestReentryRef.current = false
      // Auto-detect polling disconnect bypasses lifecycle.handleDisconnect,
      // so ephemeral UI state (typingTestMode etc.) must be reset here too.
      resetUIState()
      if (devicePrefs.typingTestViewOnly) {
        window.vialAPI.setWindowCompactMode(false).catch(() => {})
        window.vialAPI.setWindowAspectRatio(0).catch(() => {})
        window.vialAPI.setWindowAlwaysOnTop(false).catch(() => {})
        setTypingTestViewOnly(false)
        setViewExitTransition(false)
      }
    }
  }, [device.connectedDevice, devicePrefs.typingTestViewOnly, setTypingTestViewOnly, resetUIState])

  // Deferred view-only entry after unlock
  useEffect(() => {
    if (!device.connectedDevice) { pendingViewOnlyRef.current = false; return }
    if (pendingViewOnlyRef.current && keyboard.unlockStatus.unlocked) {
      pendingViewOnlyRef.current = false
      setViewMode('typingView')
      enterTypingViewOnly()
    }
  }, [device.connectedDevice, keyboard.unlockStatus.unlocked, enterTypingViewOnly, setViewMode])

  // Commit deferred typing-test save once state actually transitions to on.
  // Catches both immediate (unlocked click) and deferred (locked click → unlock) paths.
  useEffect(() => {
    if (pendingTypingTestSaveRef.current && editorUI.typingTestMode) {
      pendingTypingTestSaveRef.current = false
      setViewMode('typingTest')
    }
  }, [editorUI.typingTestMode, setViewMode])

  // Re-enter the full typing test after Back from analytics (typingTest
  // origin). Runs once the editor has remounted (analyticsPageOpen false)
  // so keymapEditorRef is live; the auto-restore effect is one-shot per uid
  // and already fired, so this is the only path that re-enters here.
  useEffect(() => {
    if (analyticsPageOpen) return
    if (!pendingTypingTestReentryRef.current) return
    pendingTypingTestReentryRef.current = false
    if (!editorUI.typingTestMode) keymapEditorRef.current?.toggleTypingTest()
  }, [analyticsPageOpen, editorUI.typingTestMode])

  // Auto-restore last view mode once prefs are applied for the connected uid
  useEffect(() => {
    if (!device.connectedDevice || device.isDummy) return
    if (keyboard.loading || keyboard.uid === EMPTY_UID) return
    if (devicePrefs.appliedUid !== keyboard.uid) return
    if (restoreRequestedUidRef.current === keyboard.uid) return
    restoreRequestedUidRef.current = keyboard.uid
    // Restore is not a user intent — clear any stale pending save flags so the
    // watcher above does not misattribute the restore's state change to a user click.
    pendingTypingTestSaveRef.current = false
    pendingViewOnlyRef.current = false

    const mode = devicePrefs.viewMode
    if (mode === 'typingTest') {
      keymapEditorRef.current?.toggleTypingTest()
    } else if (mode === 'typingView') {
      if (keyboard.unlockStatus.unlocked) {
        enterTypingViewOnly()
      } else if (keyboard.unlockStatusKnown) {
        pendingViewOnlyRef.current = true
        editorUI.setShowUnlockDialog(true)
      }
      // Unknown unlock status (getUnlockStatus failed) — skip the restore
      // rather than prompting for an unlock that may not be needed.
    }
  }, [
    device.connectedDevice,
    device.isDummy,
    keyboard.loading,
    keyboard.uid,
    keyboard.unlockStatus.unlocked,
    keyboard.unlockStatusKnown,
    devicePrefs.appliedUid,
    devicePrefs.viewMode,
    enterTypingViewOnly,
    editorUI.setShowUnlockDialog,
  ])

  useEffect(() => {
    const appZoom = appConfig.config.zoomFactor ?? ZOOM_FACTOR_DEFAULT
    const zoom = (device.connectedDevice && !device.isDummy && devicePrefs.viewMode === 'editor')
      ? (devicePrefs.keyEditorZoom ?? appZoom)
      : appZoom
    if (prevZoomRef.current === zoom) return
    prevZoomRef.current = zoom
    window.vialAPI.setWindowZoom(zoom).catch(() => {})
  }, [
    device.connectedDevice,
    device.isDummy,
    devicePrefs.viewMode,
    devicePrefs.keyEditorZoom,
    appConfig.config.zoomFactor,
  ])

  // KeymapEditor's `onTypingTestViewOnlyChange` prop. Plain function (not
  // useCallback) — matches the original inline JSX arrow function, which
  // was recreated every render too.
  const onTypingTestViewOnlyChange = (enabled: boolean) => {
    pendingTypingTestSaveRef.current = false
    pendingViewOnlyRef.current = false
    if (!enabled) {
      setViewMode('editor')
      exitViewOnlyMode()
    } else {
      setViewMode('typingView')
      devicePrefs.setTypingTestViewOnly(true)
    }
  }

  // StatusBar's `onViewOnlyChange` prop
  const onStatusBarViewOnlyChange = () => {
    pendingTypingTestSaveRef.current = false
    if (editorUI.typingTestMode && devicePrefs.typingTestViewOnly) {
      pendingViewOnlyRef.current = false
      setViewMode('editor')
      exitViewOnlyMode()
    } else if (!keyboard.unlockStatus.unlocked) {
      pendingViewOnlyRef.current = true
      editorUI.setShowUnlockDialog(true)
    } else {
      pendingViewOnlyRef.current = false
      setViewMode('typingView')
      enterTypingViewOnly()
    }
  }

  // StatusBar's `onTypingTestModeChange` prop
  const onStatusBarTypingTestModeChange = () => {
    pendingViewOnlyRef.current = false
    if (editorUI.typingTestMode) {
      setViewMode('editor')
      pendingTypingTestSaveRef.current = false
    } else {
      pendingTypingTestSaveRef.current = true
    }
    keymapEditorRef.current?.toggleTypingTest()
  }

  return {
    viewExitTransition,
    analyticsPageOpen,
    handleViewAnalytics,
    handleAnalyticsBack,
    timelineHandoff,
    openRunTimeline,
    onTypingTestViewOnlyChange,
    onStatusBarViewOnlyChange,
    onStatusBarTypingTestModeChange,
  }
}
