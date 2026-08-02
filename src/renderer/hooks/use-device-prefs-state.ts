// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef } from 'react'
import type { KeyboardLayoutId } from '../data/keyboard-layouts'
import type { TypingTestResult, TypingViewMenuTab, ViewMode, TypingTestMemory, TypingTestComparisonBaselines, ViewMatrixCell } from '../../shared/types/pipette-settings'
import type { TypingTestConfig } from '../typing-test/types'
import { DEFAULT_DISPLAY_LINES, DEFAULT_FONT_SIZE } from '../typing-test/types'
import type { BasicViewType, SplitKeyMode } from '../../shared/types/app-config'
import type { ValidatedPrefs } from './device-prefs-validate'

/**
 * Pairs a state value with a ref that always holds the latest value.
 * The ref is needed so that saveCurrentPrefs can read current values
 * inside a stable (never-recreated) callback.
 */
function useStateRef<T>(initial: T): [T, (v: T) => void, React.RefObject<T>] {
  const [value, setValue] = useState<T>(initial)
  const ref = useRef(value)
  const update = useCallback((v: T) => {
    ref.current = v
    setValue(v)
  }, [])
  return [value, update, ref]
}

export interface DevicePrefsInitialDefaults {
  defaultLayout: KeyboardLayoutId
  defaultAutoAdvance: boolean
  defaultLayerPanelOpen: boolean
  defaultBasicViewType: BasicViewType
  defaultSplitKeyMode: SplitKeyMode
  defaultQuickSelect: boolean
}

export function useDevicePrefsState(defaults: DevicePrefsInitialDefaults) {
  const [layout, updateLayout, layoutRef] = useStateRef<KeyboardLayoutId>(defaults.defaultLayout)
  const [autoAdvance, updateAutoAdvance, autoAdvanceRef] = useStateRef<boolean>(defaults.defaultAutoAdvance)
  const [layerPanelOpen, updateLayerPanelOpen, layerPanelOpenRef] = useStateRef<boolean>(defaults.defaultLayerPanelOpen)
  const [basicViewType, updateBasicViewType, basicViewTypeRef] = useStateRef<BasicViewType>(defaults.defaultBasicViewType)
  const [splitKeyMode, updateSplitKeyMode, splitKeyModeRef] = useStateRef<SplitKeyMode>(defaults.defaultSplitKeyMode)
  const [quickSelect, updateQuickSelect, quickSelectRef] = useStateRef<boolean>(defaults.defaultQuickSelect)
  const [keymapScale, updateKeymapScale, keymapScaleRef] = useStateRef<number>(1)
  const [layerNames, updateLayerNames, layerNamesRef] = useStateRef<string[]>([])
  const [typingTestResults, updateTypingTestResults, typingTestResultsRef] = useStateRef<TypingTestResult[]>([])
  const [typingTestConfig, updateTypingTestConfig, typingTestConfigRef] = useStateRef<TypingTestConfig | undefined>(undefined)
  const [typingTestMonkeytypeConfig, updateTypingTestMonkeytypeConfig, typingTestMonkeytypeConfigRef] = useStateRef<TypingTestConfig | undefined>(undefined)
  const [typingTestLanguage, updateTypingTestLanguage, typingTestLanguageRef] = useStateRef<string | undefined>(undefined)
  const [typingTestViewOnly, updateTypingTestViewOnly, typingTestViewOnlyRef] = useStateRef<boolean>(false)
  const [typingTestViewOnlyWindowSize, updateTypingTestViewOnlyWindowSize, typingTestViewOnlyWindowSizeRef] = useStateRef<{ width: number; height: number } | undefined>(undefined)
  const [typingTestViewOnlyAlwaysOnTop, updateTypingTestViewOnlyAlwaysOnTop, typingTestViewOnlyAlwaysOnTopRef] = useStateRef<boolean>(false)
  const [typingTestMemory, updateTypingTestMemory, typingTestMemoryRef] = useStateRef<TypingTestMemory | undefined>(undefined)
  const [typingTestDisplayLines, updateTypingTestDisplayLines, typingTestDisplayLinesRef] = useStateRef<number>(DEFAULT_DISPLAY_LINES)
  const [typingTestFontSize, updateTypingTestFontSize, typingTestFontSizeRef] = useStateRef<number>(DEFAULT_FONT_SIZE)
  const [typingTestHideKeymap, updateTypingTestHideKeymap, typingTestHideKeymapRef] = useStateRef<boolean>(false)
  const [typingTestHideStatsRow, updateTypingTestHideStatsRow, typingTestHideStatsRowRef] = useStateRef<boolean>(false)
  const [typingTestHideControls, updateTypingTestHideControls, typingTestHideControlsRef] = useStateRef<boolean>(false)
  const [typingTestSaveUnnamed, updateTypingTestSaveUnnamed, typingTestSaveUnnamedRef] = useStateRef<boolean>(true)
  const [typingTestComparisonBaselines, updateTypingTestComparisonBaselines, typingTestComparisonBaselinesRef] = useStateRef<TypingTestComparisonBaselines>({})
  const [typingTestSettingsPanelOpen, updateTypingTestSettingsPanelOpen, typingTestSettingsPanelOpenRef] = useStateRef<boolean>(true)
  const [typingRecordEnabled, updateTypingRecordEnabled, typingRecordEnabledRef] = useStateRef<boolean>(false)
  const [typingViewMenuTab, updateTypingViewMenuTab, typingViewMenuTabRef] = useStateRef<TypingViewMenuTab>('window')
  const [viewMode, updateViewMode, viewModeRef] = useStateRef<ViewMode>('editor')
  const [keyEditorZoom, updateKeyEditorZoom, keyEditorZoomRef] = useStateRef<number | undefined>(undefined)
  const [viewMatrix, updateViewMatrix, viewMatrixRef] = useStateRef<Record<string, ViewMatrixCell> | undefined>(undefined)
  const [appliedUid, setAppliedUid] = useState<string | null>(null)

  const uidRef = useRef('')
  const applySeqRef = useRef(0)

  const saveCurrentPrefs = useCallback(() => {
    const uid = uidRef.current
    if (!uid) return
    window.vialAPI.pipetteSettingsPatch(uid, {
      _rev: 1,
      keyboardLayout: layoutRef.current,
      autoAdvance: autoAdvanceRef.current,
      layerPanelOpen: layerPanelOpenRef.current,
      basicViewType: basicViewTypeRef.current,
      splitKeyMode: splitKeyModeRef.current,
      quickSelect: quickSelectRef.current,
      keymapScale: keymapScaleRef.current,
      keyEditorZoom: keyEditorZoomRef.current,
      layerNames: layerNamesRef.current,
      typingTestResults: typingTestResultsRef.current,
      typingTestConfig: typingTestConfigRef.current as Record<string, unknown> | undefined,
      typingTestMonkeytypeConfig: typingTestMonkeytypeConfigRef.current as Record<string, unknown> | undefined,
      typingTestLanguage: typingTestLanguageRef.current,
      typingTestViewOnly: typingTestViewOnlyRef.current,
      typingTestViewOnlyWindowSize: typingTestViewOnlyWindowSizeRef.current,
      typingTestViewOnlyAlwaysOnTop: typingTestViewOnlyAlwaysOnTopRef.current,
      // `null` clears the persisted memory; the field-level PATCH skips
      // `undefined`, so a bare `undefined` would leave a stale paused run
      // on disk after finish / restart.
      typingTestMemory: typingTestMemoryRef.current ?? null,
      typingTestDisplayLines: typingTestDisplayLinesRef.current,
      typingTestFontSize: typingTestFontSizeRef.current,
      typingTestHideKeymap: typingTestHideKeymapRef.current,
      typingTestHideStatsRow: typingTestHideStatsRowRef.current,
      typingTestHideControls: typingTestHideControlsRef.current,
      typingTestSaveUnnamed: typingTestSaveUnnamedRef.current,
      typingTestComparisonBaselines: typingTestComparisonBaselinesRef.current,
      typingTestSettingsPanelOpen: typingTestSettingsPanelOpenRef.current,
      typingRecordEnabled: typingRecordEnabledRef.current,
      typingViewMenuTab: typingViewMenuTabRef.current,
      viewMode: viewModeRef.current,
      // `null` clears the persisted overrides when the ref holds `undefined`
      // (reset), mirroring `typingTestMemory` above — a bare `undefined`
      // would leave a stale map on disk instead of clearing it.
      viewMatrix: viewMatrixRef.current ?? null,
    }).catch(() => {
      // IPC failure — best-effort save
    })
  }, [])

  /** Applies a resolved (defaulted/migrated) prefs snapshot to every state
   *  slot in one synchronous pass — no await between updates, so a caller
   *  can follow it immediately with `setAppliedUid` and rely on state being
   *  fully settled by then (view-mode routing gates on `appliedUid`). */
  const applyValidated = useCallback((resolved: ValidatedPrefs) => {
    updateLayout(resolved.keyboardLayout)
    updateAutoAdvance(resolved.autoAdvance)
    updateLayerPanelOpen(resolved.layerPanelOpen)
    updateBasicViewType(resolved.basicViewType)
    updateSplitKeyMode(resolved.splitKeyMode)
    updateQuickSelect(resolved.quickSelect)
    updateKeymapScale(resolved.keymapScale)
    updateLayerNames(resolved.layerNames)
    updateTypingTestResults(resolved.typingTestResults)
    updateTypingTestConfig(resolved.typingTestConfig)
    updateTypingTestMonkeytypeConfig(resolved.typingTestMonkeytypeConfig)
    updateTypingTestLanguage(resolved.typingTestLanguage)
    updateTypingTestViewOnly(resolved.typingTestViewOnly)
    updateTypingTestViewOnlyWindowSize(resolved.typingTestViewOnlyWindowSize)
    updateTypingTestViewOnlyAlwaysOnTop(resolved.typingTestViewOnlyAlwaysOnTop)
    updateTypingTestMemory(resolved.typingTestMemory)
    updateTypingTestDisplayLines(resolved.typingTestDisplayLines)
    updateTypingTestFontSize(resolved.typingTestFontSize)
    updateTypingTestHideKeymap(resolved.typingTestHideKeymap)
    updateTypingTestHideStatsRow(resolved.typingTestHideStatsRow)
    updateTypingTestHideControls(resolved.typingTestHideControls)
    updateTypingTestSaveUnnamed(resolved.typingTestSaveUnnamed)
    updateTypingTestComparisonBaselines(resolved.typingTestComparisonBaselines)
    updateTypingTestSettingsPanelOpen(resolved.typingTestSettingsPanelOpen)
    updateTypingRecordEnabled(resolved.typingRecordEnabled)
    updateTypingViewMenuTab(resolved.typingViewMenuTab)
    updateViewMode(resolved.viewMode)
    updateKeyEditorZoom(resolved.keyEditorZoom)
    updateViewMatrix(resolved.viewMatrix)
  }, [])

  return {
    layout, updateLayout, layoutRef,
    autoAdvance, updateAutoAdvance, autoAdvanceRef,
    layerPanelOpen, updateLayerPanelOpen, layerPanelOpenRef,
    basicViewType, updateBasicViewType, basicViewTypeRef,
    splitKeyMode, updateSplitKeyMode, splitKeyModeRef,
    quickSelect, updateQuickSelect, quickSelectRef,
    keymapScale, updateKeymapScale, keymapScaleRef,
    layerNames, updateLayerNames, layerNamesRef,
    typingTestResults, updateTypingTestResults, typingTestResultsRef,
    typingTestConfig, updateTypingTestConfig, typingTestConfigRef,
    typingTestMonkeytypeConfig, updateTypingTestMonkeytypeConfig, typingTestMonkeytypeConfigRef,
    typingTestLanguage, updateTypingTestLanguage, typingTestLanguageRef,
    typingTestViewOnly, updateTypingTestViewOnly, typingTestViewOnlyRef,
    typingTestViewOnlyWindowSize, updateTypingTestViewOnlyWindowSize, typingTestViewOnlyWindowSizeRef,
    typingTestViewOnlyAlwaysOnTop, updateTypingTestViewOnlyAlwaysOnTop, typingTestViewOnlyAlwaysOnTopRef,
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
    typingViewMenuTab, updateTypingViewMenuTab, typingViewMenuTabRef,
    viewMode, updateViewMode, viewModeRef,
    keyEditorZoom, updateKeyEditorZoom, keyEditorZoomRef,
    viewMatrix, updateViewMatrix, viewMatrixRef,
    appliedUid, setAppliedUid,
    uidRef, applySeqRef,
    saveCurrentPrefs,
    applyValidated,
  }
}

export type DevicePrefsState = ReturnType<typeof useDevicePrefsState>
