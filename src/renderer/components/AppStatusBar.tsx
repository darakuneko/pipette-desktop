// SPDX-License-Identifier: GPL-2.0-or-later
// The connected-view footer StatusBar wrapper (visibility gating +
// the ~20-prop wiring from App's various hooks). Split out of App.tsx
// (Task-split-app-tsx).

import { StatusBar } from './StatusBar'
import type { DeviceInfo } from '../../shared/types/protocol'
import type { useKeyboard } from '../hooks/useKeyboard'
import type { useEditorUIState } from '../hooks/useEditorUIState'
import type { UseDevicePrefsReturn } from '../hooks/useDevicePrefs'
import type { UseSyncReturn } from '../hooks/useSync'
import type { useHubState } from '../hooks/useHubState'
import type { useTheme } from '../hooks/useTheme'
import type { useDeviceLifecycle } from '../hooks/useDeviceLifecycle'
import type { AnalyticsOrigin } from './editors/keymap-editor-types'

interface Props {
  connectedDevice: DeviceInfo
  keyboard: ReturnType<typeof useKeyboard>
  editorUI: ReturnType<typeof useEditorUIState>
  devicePrefs: UseDevicePrefsReturn
  sync: UseSyncReturn
  hub: ReturnType<typeof useHubState>
  themeCtx: ReturnType<typeof useTheme>
  lifecycle: ReturnType<typeof useDeviceLifecycle>
  analyticsPageOpen: boolean
  onStatusBarViewOnlyChange: () => void
  onStatusBarTypingTestModeChange: () => void
  handleViewAnalytics: (origin: AnalyticsOrigin) => void
  handleTypingRecordEnabledChange: (enabled: boolean) => void
  handleKeyboardLayoutSelectChange: (v: string) => void
  // Also gates the footer's Analyze button while a Key Label "apply to
  // keymap" rewrite is mid-flight (see the `analyzeDisabled` prop comment
  // below) — its true window fully contains the actual
  // `applyKeymapRewrite` call, so no separate in-flight flag is needed.
  keymapApplyBusy: boolean
  typingTestRunning: boolean
}

export function AppStatusBar({
  connectedDevice,
  keyboard,
  editorUI,
  devicePrefs,
  sync,
  hub,
  themeCtx,
  lifecycle,
  analyticsPageOpen,
  onStatusBarViewOnlyChange,
  onStatusBarTypingTestModeChange,
  handleViewAnalytics,
  handleTypingRecordEnabledChange,
  handleKeyboardLayoutSelectChange,
  keymapApplyBusy,
  typingTestRunning,
}: Props) {
  if (editorUI.typingTestMode && devicePrefs.typingTestViewOnly) return null
  if (analyticsPageOpen) return null

  return (
    <StatusBar
      deviceName={connectedDevice.productName || 'Unknown'}
      loadedLabel={lifecycle.lastLoadedLabel}
      autoAdvance={devicePrefs.autoAdvance}
      unlocked={keyboard.unlockStatus.unlocked}
      syncStatus={sync.syncStatus}
      hubConnected={sync.authStatus.authenticated ? hub.hubConnected : undefined}
      matrixMode={editorUI.matrixState.matrixMode}
      typingTestMode={editorUI.typingTestMode}
      hasMatrixTester={editorUI.matrixState.hasMatrixTester}
      comboActive={editorUI.comboSupported && keyboard.comboEntries.some((e) => e.output !== 0)}
      altRepeatKeyActive={editorUI.altRepeatKeySupported && keyboard.altRepeatKeyEntries.some((e) => e.enabled)}
      keyOverrideActive={editorUI.keyOverrideSupported && keyboard.keyOverrideEntries.some((e) => e.enabled)}
      viewOnly={devicePrefs.typingTestViewOnly}
      onViewOnlyChange={onStatusBarViewOnlyChange}
      onTypingTestModeChange={onStatusBarTypingTestModeChange}
      onOpenAnalyze={() => handleViewAnalytics('editor')}
      // Disabled while a Key Label "apply to keymap" rewrite is mid-
      // flight: opening AnalyzePage unmounts KeymapEditor (and its
      // `history`/undo stack) out from under the in-flight rewrite,
      // which would otherwise land the batch history push in an
      // unmounted component (making it un-undoable after Back) and
      // fire the post-apply flash timer's setState after unmount.
      // Typing View / Typing Test don't unmount the editor, so they're
      // unaffected; Disconnect has the same mid-apply hazard but
      // that's pre-existing and out of scope here.
      analyzeDisabled={keymapApplyBusy}
      onViewAnalytics={() => handleViewAnalytics('typingTest')}
      viewAnalyticsDisabled={typingTestRunning}
      onDisconnect={editorUI.typingTestMode ? undefined : lifecycle.handleDisconnect}
      typingRecordEnabled={devicePrefs.typingRecordEnabled ?? false}
      onTypingRecordEnabledChange={handleTypingRecordEnabledChange}
      quickSettings={{
        onThemeChange: themeCtx.setTheme,
        hubDisplayName: hub.hubDisplayName,
        hubCanWrite: hub.hubCanUpload,
        keyboardLayout: devicePrefs.layout,
        onKeyboardLayoutChange: handleKeyboardLayoutSelectChange,
      }}
    />
  )
}
