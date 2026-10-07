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

/** Save bookkeeping shared by `savePrefs` and the sync reload. */
export interface PatchTracker {
  /** Bumped by every save, so a reader can tell a save started meanwhile. */
  generation: number
  /** Saves whose IPC call has not settled yet. */
  inFlight: number
  /** Called each time `inFlight` drops back to 0. A single slot with one
   *  owner: `useDevicePrefsReload` (`use-device-prefs-reload.ts`) sets it
   *  on mount and clears it on unmount. Nothing else may assign it. */
  onSettled: (() => void) | null
}

export interface ApplyValidatedOptions {
  skip?: ReadonlySet<keyof ValidatedPrefs>
  onlyChanged?: boolean
}

/** Structural equality for the JSON-shaped prefs values. */
function isSameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
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
  const [viewMatrix, updateViewMatrix, viewMatrixRef] = useStateRef<Record<string, ViewMatrixCell> | undefined>(undefined)
  const [viewMatrixWires, updateViewMatrixWires, viewMatrixWiresRef] = useStateRef<boolean>(false)
  const [layerHoverPreview, updateLayerHoverPreview, layerHoverPreviewRef] = useStateRef<boolean>(true)
  const [entryHoverPreview, updateEntryHoverPreview, entryHoverPreviewRef] = useStateRef<boolean>(true)
  const [keycodeTabOrder, updateKeycodeTabOrder, keycodeTabOrderRef] = useStateRef<string[] | undefined>(undefined)
  const [appliedUid, setAppliedUid] = useState<string | null>(null)

  const uidRef = useRef('')
  const applySeqRef = useRef(0)
  const patchTrackerRef = useRef<PatchTracker>({ generation: 0, inFlight: 0, onSettled: null })

  /** Persists only the fields a setter changed. A field-level PATCH leaves
   *  every other field in the file untouched, so a value written by a sync
   *  merge is never overwritten with this renderer's stale copy. Clearable
   *  fields send `null`: the main-side merge skips `undefined`.
   *  Every call is counted in `patchTrackerRef`, which the sync reload
   *  (`use-device-prefs-reload.ts`) reads to drop a read that raced a save. */
  const savePrefs = useCallback((partial: PipetteSettingsPatch) => {
    const uid = uidRef.current
    if (!uid) return
    const tracker = patchTrackerRef.current
    tracker.generation++
    tracker.inFlight++
    let request: Promise<unknown>
    try {
      request = window.vialAPI.pipetteSettingsPatch(uid, { _rev: 1, ...partial })
    } catch (err) {
      // A synchronous throw still has to settle the count below.
      request = Promise.reject(err)
    }
    request
      .catch(() => {
        // IPC failure — best-effort save
      })
      .finally(() => {
        tracker.inFlight--
        if (tracker.inFlight === 0) tracker.onSettled?.()
      })
  }, [])

  /** Applies a resolved (defaulted/migrated) prefs snapshot to every state
   *  slot in one synchronous pass — no await between updates, so a caller
   *  can follow it immediately with `setAppliedUid` and rely on state being
   *  fully settled by then (view-mode routing gates on `appliedUid`).
   *  `options.skip` leaves the named slots as they are; `options.onlyChanged`
   *  leaves a slot alone when its value is equal to the current one, so an
   *  unchanged array or object keeps its identity. Returns the skipped
   *  slots whose current value differs from `resolved`. */
  const applyValidated = useCallback((resolved: ValidatedPrefs, options?: ApplyValidatedOptions): (keyof ValidatedPrefs)[] => {
    const differingSkipped: (keyof ValidatedPrefs)[] = []
    const put = <K extends keyof ValidatedPrefs>(
      key: K,
      ref: React.RefObject<ValidatedPrefs[K]>,
      update: (value: ValidatedPrefs[K]) => void,
    ): void => {
      if (options?.skip?.has(key)) {
        if (!isSameValue(ref.current, resolved[key])) differingSkipped.push(key)
        return
      }
      if (options?.onlyChanged && isSameValue(ref.current, resolved[key])) return
      update(resolved[key])
    }
    put('keyboardLayout', layoutRef, updateLayout)
    put('autoAdvance', autoAdvanceRef, updateAutoAdvance)
    put('layerPanelOpen', layerPanelOpenRef, updateLayerPanelOpen)
    put('basicViewType', basicViewTypeRef, updateBasicViewType)
    put('splitKeyMode', splitKeyModeRef, updateSplitKeyMode)
    put('quickSelect', quickSelectRef, updateQuickSelect)
    put('keymapScale', keymapScaleRef, updateKeymapScale)
    put('layerNames', layerNamesRef, updateLayerNames)
    put('typingTestResults', typingTestResultsRef, updateTypingTestResults)
    put('typingTestConfig', typingTestConfigRef, updateTypingTestConfig)
    put('typingTestMonkeytypeConfig', typingTestMonkeytypeConfigRef, updateTypingTestMonkeytypeConfig)
    put('typingTestLanguage', typingTestLanguageRef, updateTypingTestLanguage)
    put('typingTestViewOnly', typingTestViewOnlyRef, updateTypingTestViewOnly)
    put('typingTestViewOnlyWindowSize', typingTestViewOnlyWindowSizeRef, updateTypingTestViewOnlyWindowSize)
    put('typingTestViewOnlyAlwaysOnTop', typingTestViewOnlyAlwaysOnTopRef, updateTypingTestViewOnlyAlwaysOnTop)
    put('typingTestViewOnlyOpacity', typingTestViewOnlyOpacityRef, updateTypingTestViewOnlyOpacity)
    put('typingTestMemory', typingTestMemoryRef, updateTypingTestMemory)
    put('typingTestDisplayLines', typingTestDisplayLinesRef, updateTypingTestDisplayLines)
    put('typingTestFontSize', typingTestFontSizeRef, updateTypingTestFontSize)
    put('typingTestHideKeymap', typingTestHideKeymapRef, updateTypingTestHideKeymap)
    put('typingTestHideStatsRow', typingTestHideStatsRowRef, updateTypingTestHideStatsRow)
    put('typingTestHideControls', typingTestHideControlsRef, updateTypingTestHideControls)
    put('typingTestSaveUnnamed', typingTestSaveUnnamedRef, updateTypingTestSaveUnnamed)
    put('typingTestComparisonBaselines', typingTestComparisonBaselinesRef, updateTypingTestComparisonBaselines)
    put('typingTestSettingsPanelOpen', typingTestSettingsPanelOpenRef, updateTypingTestSettingsPanelOpen)
    put('typingRecordEnabled', typingRecordEnabledRef, updateTypingRecordEnabled)
    put('viewMode', viewModeRef, updateViewMode)
    put('keyEditorZoom', keyEditorZoomRef, updateKeyEditorZoom)
    put('viewMatrix', viewMatrixRef, updateViewMatrix)
    put('viewMatrixWires', viewMatrixWiresRef, updateViewMatrixWires)
    put('layerHoverPreview', layerHoverPreviewRef, updateLayerHoverPreview)
    put('entryHoverPreview', entryHoverPreviewRef, updateEntryHoverPreview)
    put('keycodeTabOrder', keycodeTabOrderRef, updateKeycodeTabOrder)
    return differingSkipped
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
    uidRef, applySeqRef, patchTrackerRef,
    savePrefs,
    applyValidated,
  }
}

export type DevicePrefsState = ReturnType<typeof useDevicePrefsState>
