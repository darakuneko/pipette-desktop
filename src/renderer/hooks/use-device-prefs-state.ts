// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef } from 'react'
import type { KeyboardLayoutId } from '../data/keyboard-layouts'
import type { PipetteSettingsPatch, TypingTestResult, ViewMode, TypingTestMemory, TypingTestComparisonBaselines, ViewMatrixCell } from '../../shared/types/pipette-settings'
import { VIEW_ONLY_OPACITY_DEFAULT } from '../../shared/types/pipette-settings'
import type { TypingTestConfig } from '../typing-test/types'
import { DEFAULT_DISPLAY_LINES, DEFAULT_FONT_SIZE } from '../typing-test/types'
import type { BasicViewType, SplitKeyMode } from '../../shared/types/app-config'
import type { ValidatedPrefs } from './device-prefs-validate'

/**
 * Pairs a state value with a ref that always holds the latest value.
 * The ref lets setters that compare against or derive from the current
 * value read it inside a stable callback.
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
  const [layout, updateLayout] = useStateRef<KeyboardLayoutId>(defaults.defaultLayout)
  const [autoAdvance, updateAutoAdvance] = useStateRef<boolean>(defaults.defaultAutoAdvance)
  const [layerPanelOpen, updateLayerPanelOpen] = useStateRef<boolean>(defaults.defaultLayerPanelOpen)
  const [basicViewType, updateBasicViewType] = useStateRef<BasicViewType>(defaults.defaultBasicViewType)
  const [splitKeyMode, updateSplitKeyMode] = useStateRef<SplitKeyMode>(defaults.defaultSplitKeyMode)
  const [quickSelect, updateQuickSelect] = useStateRef<boolean>(defaults.defaultQuickSelect)
  const [keymapScale, updateKeymapScale] = useStateRef<number>(1)
  const [layerNames, updateLayerNames] = useStateRef<string[]>([])
  const [typingTestResults, updateTypingTestResults, typingTestResultsRef] = useStateRef<TypingTestResult[]>([])
  const [typingTestConfig, updateTypingTestConfig, typingTestConfigRef] = useStateRef<TypingTestConfig | undefined>(undefined)
  const [typingTestMonkeytypeConfig, updateTypingTestMonkeytypeConfig] = useStateRef<TypingTestConfig | undefined>(undefined)
  const [typingTestLanguage, updateTypingTestLanguage] = useStateRef<string | undefined>(undefined)
  const [typingTestViewOnly, updateTypingTestViewOnly] = useStateRef<boolean>(false)
  const [typingTestViewOnlyWindowSize, updateTypingTestViewOnlyWindowSize] = useStateRef<{ width: number; height: number } | undefined>(undefined)
  const [typingTestViewOnlyAlwaysOnTop, updateTypingTestViewOnlyAlwaysOnTop] = useStateRef<boolean>(false)
  const [typingTestViewOnlyOpacity, updateTypingTestViewOnlyOpacity, typingTestViewOnlyOpacityRef] = useStateRef<number>(VIEW_ONLY_OPACITY_DEFAULT)
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
  const [viewMode, updateViewMode, viewModeRef] = useStateRef<ViewMode>('editor')
  const [keyEditorZoom, updateKeyEditorZoom, keyEditorZoomRef] = useStateRef<number | undefined>(undefined)
  const [viewMatrix, updateViewMatrix] = useStateRef<Record<string, ViewMatrixCell> | undefined>(undefined)
  const [viewMatrixWires, updateViewMatrixWires] = useStateRef<boolean>(false)
  const [layerHoverPreview, updateLayerHoverPreview] = useStateRef<boolean>(true)
  const [entryHoverPreview, updateEntryHoverPreview] = useStateRef<boolean>(true)
  const [keycodeTabOrder, updateKeycodeTabOrder] = useStateRef<string[] | undefined>(undefined)
  const [appliedUid, setAppliedUid] = useState<string | null>(null)

  const uidRef = useRef('')
  const applySeqRef = useRef(0)

  /** Persists only the fields a setter changed. A field-level PATCH leaves
   *  every other field in the file untouched, so a value written by a sync
   *  merge is never overwritten with this renderer's stale copy. Clearable
   *  fields send `null`: the main-side merge skips `undefined`. */
  const savePrefs = useCallback((partial: PipetteSettingsPatch) => {
    const uid = uidRef.current
    if (!uid) return
    window.vialAPI.pipetteSettingsPatch(uid, { _rev: 1, ...partial }).catch(() => {
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
    updateTypingTestViewOnlyOpacity(resolved.typingTestViewOnlyOpacity)
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
    updateViewMode(resolved.viewMode)
    updateKeyEditorZoom(resolved.keyEditorZoom)
    updateViewMatrix(resolved.viewMatrix)
    updateViewMatrixWires(resolved.viewMatrixWires)
    updateLayerHoverPreview(resolved.layerHoverPreview)
    updateEntryHoverPreview(resolved.entryHoverPreview)
    updateKeycodeTabOrder(resolved.keycodeTabOrder)
  }, [])

  return {
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
    typingTestViewOnlyOpacity, updateTypingTestViewOnlyOpacity, typingTestViewOnlyOpacityRef,
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
    viewMatrixWires, updateViewMatrixWires,
    layerHoverPreview, updateLayerHoverPreview,
    entryHoverPreview, updateEntryHoverPreview,
    keycodeTabOrder, updateKeycodeTabOrder,
    appliedUid, setAppliedUid,
    uidRef, applySeqRef,
    savePrefs,
    applyValidated,
  }
}

export type DevicePrefsState = ReturnType<typeof useDevicePrefsState>
