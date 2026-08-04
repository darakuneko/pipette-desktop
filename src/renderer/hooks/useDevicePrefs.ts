// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback } from 'react'
import { useAppConfig } from './useAppConfig'
import { MIN_SCALE, MAX_SCALE } from '../components/editors/keymap-editor-types'
import { DEFAULT_DISPLAY_LINES, DEFAULT_FONT_SIZE } from '../typing-test/types'
import { clampZoomFactor } from '../../shared/types/app-config'
import { validateIpcPrefs, type ValidatedPrefs } from './device-prefs-validate'
import { useDevicePrefsState } from './use-device-prefs-state'
import { useDevicePrefsDefaults } from './use-device-prefs-defaults'
import { useTypingTestPrefs } from './use-typing-test-prefs'
import { useDevicePrefsRemap } from './use-device-prefs-remap'
import type { UseDevicePrefsReturn } from './device-prefs-types'
import type { KeyboardLayoutId } from '../data/keyboard-layouts'
import type { BasicViewType, SplitKeyMode } from '../../shared/types/app-config'
import type { ViewMode, ViewMatrixCell } from '../../shared/types/pipette-settings'

export type { KeyboardLayoutId, AutoLockMinutes, BasicViewType, SplitKeyMode } from './device-prefs-types'
export type { UseDevicePrefsReturn } from './device-prefs-types'

export function useDevicePrefs(): UseDevicePrefsReturn {
  const { config, set } = useAppConfig()

  const {
    defaultLayout, defaultAutoAdvance, defaultLayerPanelOpen, defaultBasicViewType, defaultSplitKeyMode, defaultQuickSelect,
    setDefaultLayout, setDefaultAutoAdvance, setDefaultLayerPanelOpen, setDefaultBasicViewType, setDefaultSplitKeyMode, setDefaultQuickSelect,
    autoLockTime, setAutoLockTime,
  } = useDevicePrefsDefaults({ config, set })

  const {
    layout, updateLayout,
    autoAdvance, updateAutoAdvance,
    layerPanelOpen, updateLayerPanelOpen,
    basicViewType, updateBasicViewType,
    splitKeyMode, updateSplitKeyMode,
    quickSelect, updateQuickSelect,
    keymapScale, updateKeymapScale,
    layerNames, updateLayerNames,
    typingTestResults, updateTypingTestResults, typingTestResultsRef,
    typingTestConfig, updateTypingTestConfig, typingTestConfigRef,
    typingTestMonkeytypeConfig, updateTypingTestMonkeytypeConfig,
    typingTestLanguage, updateTypingTestLanguage,
    typingTestViewOnly, updateTypingTestViewOnly,
    typingTestViewOnlyWindowSize, updateTypingTestViewOnlyWindowSize,
    typingTestViewOnlyAlwaysOnTop, updateTypingTestViewOnlyAlwaysOnTop,
    typingTestMemory, updateTypingTestMemory, typingTestMemoryRef,
    typingTestDisplayLines, updateTypingTestDisplayLines, typingTestDisplayLinesRef,
    typingTestFontSize, updateTypingTestFontSize, typingTestFontSizeRef,
    typingTestHideKeymap, updateTypingTestHideKeymap, typingTestHideKeymapRef,
    typingTestHideStatsRow, updateTypingTestHideStatsRow, typingTestHideStatsRowRef,
    typingTestHideControls, updateTypingTestHideControls, typingTestHideControlsRef,
    typingTestSaveUnnamed, updateTypingTestSaveUnnamed, typingTestSaveUnnamedRef,
    typingTestComparisonBaselines, updateTypingTestComparisonBaselines, typingTestComparisonBaselinesRef,
    typingTestSettingsPanelOpen, updateTypingTestSettingsPanelOpen, typingTestSettingsPanelOpenRef,
    typingRecordEnabled, updateTypingRecordEnabled, typingRecordEnabledRef,
    viewMode, updateViewMode, viewModeRef,
    keyEditorZoom, updateKeyEditorZoom, keyEditorZoomRef,
    viewMatrix, updateViewMatrix,
    appliedUid, setAppliedUid,
    uidRef, applySeqRef,
    saveCurrentPrefs,
    applyValidated,
  } = useDevicePrefsState({
    defaultLayout, defaultAutoAdvance, defaultLayerPanelOpen, defaultBasicViewType, defaultSplitKeyMode, defaultQuickSelect,
  })

  const setLayout = useCallback((id: KeyboardLayoutId) => {
    updateLayout(id)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateLayout])

  const setAutoAdvance = useCallback((enabled: boolean) => {
    updateAutoAdvance(enabled)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateAutoAdvance])

  const setLayerPanelOpen = useCallback((open: boolean) => {
    updateLayerPanelOpen(open)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateLayerPanelOpen])

  const setBasicViewType = useCallback((type: BasicViewType) => {
    updateBasicViewType(type)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateBasicViewType])

  const setSplitKeyMode = useCallback((mode: SplitKeyMode) => {
    updateSplitKeyMode(mode)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateSplitKeyMode])

  const setQuickSelect = useCallback((enabled: boolean) => {
    updateQuickSelect(enabled)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateQuickSelect])

  const setKeymapScale = useCallback((scale: number) => {
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale))
    updateKeymapScale(Math.round(clamped * 10) / 10)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateKeymapScale])

  const setLayerNames = useCallback((names: string[]) => {
    updateLayerNames(names)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateLayerNames])

  const {
    addTypingTestResult,
    renameTypingTestResult,
    deleteTypingTestResult,
    setTypingTestConfig,
    setTypingTestLanguage,
    setTypingTestViewOnly,
    setTypingTestViewOnlyWindowSize,
    setTypingTestViewOnlyAlwaysOnTop,
    setTypingTestMemory,
    setTypingTestDisplayLines,
    setTypingTestFontSize,
    setTypingTestHideKeymap,
    setTypingTestHideStatsRow,
    setTypingTestHideControls,
    setTypingTestSaveUnnamed,
    setTypingTestComparisonBaseline,
    setTypingTestSettingsPanelOpen,
    setTypingRecordEnabled,
  } = useTypingTestPrefs({
    typingTestResultsRef, updateTypingTestResults,
    typingTestConfigRef, updateTypingTestConfig, updateTypingTestMonkeytypeConfig,
    updateTypingTestLanguage,
    updateTypingTestViewOnly,
    updateTypingTestViewOnlyWindowSize,
    updateTypingTestViewOnlyAlwaysOnTop,
    typingTestMemoryRef, updateTypingTestMemory,
    typingTestDisplayLinesRef, updateTypingTestDisplayLines,
    typingTestFontSizeRef, updateTypingTestFontSize,
    typingTestHideKeymapRef, updateTypingTestHideKeymap,
    typingTestHideStatsRowRef, updateTypingTestHideStatsRow,
    typingTestHideControlsRef, updateTypingTestHideControls,
    typingTestSaveUnnamedRef, updateTypingTestSaveUnnamed,
    typingTestComparisonBaselinesRef, updateTypingTestComparisonBaselines,
    typingTestSettingsPanelOpenRef, updateTypingTestSettingsPanelOpen,
    typingRecordEnabledRef, updateTypingRecordEnabled,
    saveCurrentPrefs,
  })

  const setViewMode = useCallback((mode: ViewMode) => {
    if (viewModeRef.current === mode) return
    updateViewMode(mode)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateViewMode])

  /** `undefined` resets to physical matrix order — clears every override. */
  const setViewMatrix = useCallback((next: Record<string, ViewMatrixCell> | undefined) => {
    updateViewMatrix(next)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateViewMatrix])

  const setKeyEditorZoom = useCallback((zoom: number) => {
    const clamped = clampZoomFactor(zoom)
    if (keyEditorZoomRef.current === clamped) return
    updateKeyEditorZoom(clamped)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateKeyEditorZoom])

  const applyDevicePrefs = useCallback(async (uid: string) => {
    uidRef.current = uid
    setAppliedUid(null)
    const seq = ++applySeqRef.current

    let prefs: ValidatedPrefs | null = null
    try {
      const raw = await window.vialAPI.pipetteSettingsGet(uid)
      if (applySeqRef.current !== seq) return
      prefs = validateIpcPrefs(raw, defaultLayout, defaultAutoAdvance, defaultLayerPanelOpen, defaultBasicViewType, defaultSplitKeyMode, defaultQuickSelect)
    } catch {
      // IPC failure — fall through to defaults
    }
    if (applySeqRef.current !== seq) return

    const resolved: ValidatedPrefs = prefs ?? {
      keyboardLayout: defaultLayout,
      autoAdvance: defaultAutoAdvance,
      layerPanelOpen: defaultLayerPanelOpen,
      basicViewType: defaultBasicViewType,
      splitKeyMode: defaultSplitKeyMode,
      quickSelect: defaultQuickSelect,
      keymapScale: 1,
      layerNames: [],
      typingTestResults: [],
      typingTestViewOnly: false,
      typingTestViewOnlyAlwaysOnTop: false,
      typingTestDisplayLines: DEFAULT_DISPLAY_LINES,
      typingTestFontSize: DEFAULT_FONT_SIZE,
      typingTestHideKeymap: false,
      typingTestHideStatsRow: false,
      typingTestHideControls: false,
      typingTestSaveUnnamed: true,
      typingTestComparisonBaselines: {},
      typingTestSettingsPanelOpen: true,
      typingRecordEnabled: false,
      viewMode: 'editor',
    }
    applyValidated(resolved)
    setAppliedUid(uid)

    if (!prefs) {
      saveCurrentPrefs()
    }
  }, [saveCurrentPrefs, applyValidated, defaultLayout, defaultAutoAdvance, defaultLayerPanelOpen, defaultBasicViewType, defaultSplitKeyMode, defaultQuickSelect])

  const {
    remapLabel,
    isRemapped,
    remapKind,
    activeRewriteTable,
    activeLayoutName,
    pickerRemapLabel,
  } = useDevicePrefsRemap(layout)

  return {
    layout,
    autoAdvance,
    layerPanelOpen,
    basicViewType,
    splitKeyMode,
    quickSelect,
    keymapScale,
    layerNames,
    typingTestResults,
    typingTestConfig,
    typingTestMonkeytypeConfig,
    typingTestLanguage,
    typingTestViewOnly,
    typingTestViewOnlyWindowSize,
    typingTestViewOnlyAlwaysOnTop,
    typingTestMemory,
    typingTestDisplayLines,
    typingTestFontSize,
    typingTestHideKeymap,
    typingTestHideStatsRow,
    typingTestHideControls,
    typingTestSaveUnnamed,
    typingTestComparisonBaselines,
    typingTestSettingsPanelOpen,
    typingRecordEnabled,
    viewMode,
    keyEditorZoom,
    viewMatrix,
    appliedUid,
    setLayout,
    setAutoAdvance,
    setLayerPanelOpen,
    setBasicViewType,
    setSplitKeyMode,
    setQuickSelect,
    setKeymapScale,
    setLayerNames,
    addTypingTestResult,
    renameTypingTestResult,
    deleteTypingTestResult,
    setTypingTestConfig,
    setTypingTestLanguage,
    setTypingTestViewOnly,
    setTypingTestViewOnlyWindowSize,
    setTypingTestViewOnlyAlwaysOnTop,
    setTypingTestMemory,
    setTypingTestDisplayLines,
    setTypingTestFontSize,
    setTypingTestHideKeymap,
    setTypingTestHideStatsRow,
    setTypingTestHideControls,
    setTypingTestSaveUnnamed,
    setTypingTestComparisonBaseline,
    setTypingTestSettingsPanelOpen,
    setTypingRecordEnabled,
    setViewMode,
    setViewMatrix,
    setKeyEditorZoom,
    defaultLayout,
    defaultAutoAdvance,
    defaultLayerPanelOpen,
    defaultBasicViewType,
    defaultSplitKeyMode,
    defaultQuickSelect,
    setDefaultLayout,
    setDefaultAutoAdvance,
    setDefaultLayerPanelOpen,
    setDefaultBasicViewType,
    setDefaultSplitKeyMode,
    setDefaultQuickSelect,
    autoLockTime,
    setAutoLockTime,
    applyDevicePrefs,
    remapLabel,
    isRemapped,
    remapKind,
    activeRewriteTable,
    activeLayoutName,
    pickerRemapLabel,
  }
}
