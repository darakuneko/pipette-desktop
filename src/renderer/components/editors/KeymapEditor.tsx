// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useMemo, useRef, useImperativeHandle, forwardRef } from 'react'
import { useTranslation } from 'react-i18next'
import { TabbedKeycodes } from '../keycodes/TabbedKeycodes'
import { useTileContentOverride } from '../../hooks/useTileContentOverride'
import { KeycodesOverlayPanel } from './KeycodesOverlayPanel'
import { ViewMatrixPanel } from './ViewMatrixPanel'
import { ZoomIn, ZoomOut, SlidersHorizontal } from 'lucide-react'
import { ICON_SM, ICON_MD } from '../../constants/ui-tokens'

// Extracted modules
import type { KeymapEditorProps as Props } from './keymap-editor-types'
import { MIN_SCALE, MAX_SCALE, PANEL_COLLAPSED_WIDTH } from './keymap-editor-types'
export type { KeymapEditorHandle } from './keymap-editor-types'
import { KeyboardPane } from './KeyboardPane'
import { LayerListPanel } from './LayerListPanel'
import { ScaleInput, ghostZoomButtonClass, KeymapToolbar } from './keymap-editor-toolbar'
import { PopoverForState } from './keymap-editor-popover'
import { Tooltip } from '../ui/Tooltip'
import { useInputModes } from './useInputModes'
import { useKeymapMultiSelect } from './useKeymapMultiSelect'
import { useLayoutOptionsPanel } from './useLayoutOptionsPanel'
import { useKeymapSelectionHandlers } from './useKeymapSelectionHandlers'
import { useKeymapHistory } from './useKeymapHistory'
import type { SingleHistoryEntry } from './useKeymapHistory'
import { useKeyFlash } from './useKeyFlash'
import { rewriteNumericKeycode } from '../../../shared/keymap/keymap-apply'
import type { KeymapRewriteTable, KeymapRewriteLayoutIds } from '../../../shared/keymap/keymap-apply'
import type { KeymapApplyResult } from './keymap-editor-types'
import { useAppConfig } from '../../hooks/useAppConfig'
import { TypingTestPane } from './TypingTestPane'
import { useLayoutPicker } from './useLayoutPicker'
import { useKeymapJsonEditors } from './useKeymapJsonEditors'
import { useViewMatrixEditing } from './useViewMatrixEditing'
import { KeymapEditorModals } from './KeymapEditorModals'
import { useLayerKeycodes } from './use-layer-keycodes'


export const KeymapEditor = forwardRef<import('./keymap-editor-types').KeymapEditorHandle, Props>(function KeymapEditor({
  keyboardUid, layout, layers, currentLayer, onLayerChange, keymap, encoderLayout, encoderCount,
  layoutOptions, layoutLabels, packedLayoutOptions, onSetLayoutOptions,
  remapLabel, isRemapped, onSetKey, onSetKeysBulk, onSetEncoder,
  rows, cols, getMatrixState, unlocked, onUnlock,
  tapDanceEntries, onSetTapDanceEntry,
  macroCount, macroBufferSize, macroBuffer, vialProtocol, parsedMacros, onSaveMacros,
  tapHoldSupported, mouseKeysSupported, magicSupported, graveEscapeSupported,
  autoShiftSupported, oneShotKeysSupported, comboSettingsSupported,
  supportedQsids, qmkSettingsGet, qmkSettingsSet, qmkSettingsReset, onSettingsUpdate,
  autoAdvance = true, onAutoAdvanceChange, viewMatrix, onViewMatrixChange,
  basicViewType, onBasicViewTypeChange, splitKeyMode, onSplitKeyModeChange,
  quickSelect, onQuickSelectChange, keyboardLayout: _keyboardLayout = 'qwerty', onKeyboardLayoutChange: _onKeyboardLayoutChange,
  onAppliedKeymapLayoutChange,
  onLock, onMatrixModeChange, onOpenLighting,
  comboEntries, onOpenCombo, onSetComboEntry,
  keyOverrideEntries, onOpenKeyOverride, onSetKeyOverrideEntry,
  altRepeatKeyEntries, onOpenAltRepeatKey, onSetAltRepeatKeyEntry,
  toolsExtra, dataPanel, onOverlayOpen,
  layerNames, onSetLayerName,
  layerPanelOpen: layerPanelOpenProp, onLayerPanelOpenChange,
  scale: scaleProp = 1, onScaleChange,
  keyEditorZoom, onKeyEditorZoomChange,
  typingTestMode, onTypingTestModeChange, onSaveTypingTestResult, onRenameTypingTestResult, onDeleteTypingTestResult, typingTestHistory,
  typingTestConfig: savedTypingTestConfig, typingTestMonkeytypeConfig, typingTestLanguage: savedTypingTestLanguage,
  onTypingTestConfigChange, onTypingTestLanguageChange,
  typingTestViewOnly, onTypingTestViewOnlyChange,
  typingTestViewOnlyWindowSize, onTypingTestViewOnlyWindowSizeChange,
  typingTestViewOnlyAlwaysOnTop, onTypingTestViewOnlyAlwaysOnTopChange,
  typingTestMemory: savedTypingTestMemory, onTypingTestMemoryChange,
  typingTestDisplayLines, typingTestFontSize, onTypingTestDisplayLinesChange, onTypingTestFontSizeChange,
  typingTestHideKeymap, typingTestHideStatsRow, typingTestHideControls, typingTestSaveUnnamed = true, typingTestComparisonBaselines, onTypingTestHideKeymapChange, onTypingTestHideStatsRowChange, onTypingTestHideControlsChange, onTypingTestSaveUnnamedChange, onTypingTestComparisonBaselineChange,
  typingTestSettingsPanelOpen, onTypingTestSettingsPanelOpenChange,
  typingRecordEnabled, onTypingRecordEnabledChange, onRecKeystroke,
  typingRecordingConsentAccepted, onTypingRecordingConsentAccepted,
  typingHeatmapWindowMin, onTypingHeatmapWindowMinChange,
  typingMonitorAppEnabled, onTypingMonitorAppEnabledChange,
  typingTrayResident, onTypingTrayResidentChange, typingStartInTray, onTypingStartInTrayChange,
  typingViewMenuTab, onTypingViewMenuTabChange,
  onViewAnalytics, onTypingTestRunningChange,
  tappingTermMs,
  deviceName, isDummy, onExportLayoutPdfAll, onExportLayoutPdfCurrent,
  favHubOrigin, favHubNeedsDisplayName, favHubUploading, favHubUploadResult,
  onFavUploadToHub, onFavUpdateOnHub, onFavRemoveFromHub, onFavRenameOnHub,
  devices, connectedDevice, onDeviceListActiveChange,
}, ref) {
  const { t } = useTranslation()
  const keyboardContentRef = useRef<HTMLDivElement>(null)

  // --- Input modes (matrix tester + typing test) ---
  const {
    matrixMode, pressedKeys, everPressedKeys, hasMatrixTester,
    handleMatrixToggle, handleTypingTestToggle,
    typingTest, handleTypingTestConfigChange, handleTypingTestLanguageChange,
    finishedResult, nameFinishedResult,
    pauseTypingTest, resumeTypingTest, restartTypingTestFromStart,
  } = useInputModes({
    rows, cols, getMatrixState, unlocked, onUnlock, onMatrixModeChange, keymap,
    typingTestMode, onTypingTestModeChange, savedTypingTestConfig, savedTypingTestLanguage,
    onTypingTestConfigChange, onTypingTestLanguageChange, onSaveTypingTestResult, onRenameTypingTestResult, saveUnnamed: typingTestSaveUnnamed, typingTestHistory,
    savedTypingTestMemory, onTypingTestMemoryChange,
    typingTestViewOnly, typingRecordEnabled, onRecKeystroke,
    typingRecordKeyboard: keyboardUid && connectedDevice
      ? {
          uid: keyboardUid,
          vendorId: connectedDevice.vendorId,
          productId: connectedDevice.productId,
          productName: connectedDevice.productName ?? deviceName ?? '',
        }
      : undefined,
    tappingTermMs,
  })

  // --- Layout options ---
  const {
    parsedOptions, hasLayoutOptions, layoutValues, effectiveLayoutOptions,
    handleLayoutOptionChange, keyboardAreaMinHeight, selectableKeys,
    layoutPanelOpen, setLayoutPanelOpen, layoutPanelRef, layoutButtonRef,
  } = useLayoutOptionsPanel({ layout, layoutLabels, packedLayoutOptions, onSetLayoutOptions, layoutOptions, scale: scaleProp })

  // --- Multi-selection ---
  const hasActiveSingleSelectionRef = useRef(false)
  const multiSelect = useKeymapMultiSelect({ hasActiveSingleSelectionRef })

  // --- Keymap history ---
  const { config: appCfg } = useAppConfig()
  const history = useKeymapHistory(appCfg.maxKeymapHistory)

  // --- Key flash (Key Label "apply to keymap" bulk rewrite, and undo/redo)
  // — must run before `useKeymapSelectionHandlers` below so `triggerFlash`
  // exists to pass in as `onHistoryApplied`. ---
  const { flash, triggerFlash } = useKeyFlash(currentLayer)

  // --- Selection + handlers ---
  const {
    selectedKey, selectedEncoder, selectedMaskPart, popoverState, setPopoverState,
    selectedKeycode, isMaskKey, isLMMask,
    handleKeyClick, handleEncoderClick, handleKeyDoubleClick, handleEncoderDoubleClick,
    handleKeycodeSelect, handlePopoverKeycodeSelect, handlePopoverRawKeycodeSelect,
    handlePopoverModMaskChange, popoverUndoKeycode, handlePopoverUndo,
    popoverRedoKeycode, handlePopoverRedo,
    handleUndo, handleRedo,
    handleDeselect, handleDeselectClick,
    tdModalIndex, macroModalIndex, handleTdModalSave, handleTdModalClose, handleMacroModalClose,
  } = useKeymapSelectionHandlers({
    layout, keymap, encoderLayout, currentLayer,
    selectableKeys, autoAdvance, viewMatrix,
    onSetKey, onSetKeysBulk, onSetEncoder, unlocked, onUnlock,
    multiSelect, history,
    onAppliedKeymapLayoutChange,
    onHistoryApplied: triggerFlash,
    tapDanceEntries, onSetTapDanceEntry,
    macroCount, macroBufferSize, macroBuffer, onSaveMacros,
  })

  hasActiveSingleSelectionRef.current = !!(selectedKey || selectedEncoder)
  const { multiSelectedKeys, pickerSelectedIndices, handlePickerMultiSelect } = multiSelect

  // --- View Matrix mode ---
  const {
    viewMatrixMode, handleToggleViewMatrixMode, handleViewMatrixKeyClick,
    viewMatrixSelectedPositions, viewMatrixEffectiveSingle, handleViewMatrixAxisChange,
    viewMatrixAxisOptionCount, viewMatrixLabelOverrides, viewMatrixDuplicateKeyColors,
    gatedHandleKeycodeSelect,
  } = useViewMatrixEditing({
    layout, viewMatrix, onViewMatrixChange, rows, cols, selectableKeys,
    matrixMode, handleMatrixToggle, handleDeselect, handleKeycodeSelect,
  })

  // Clear history and exit View Matrix mode on keyboard/context switch or disconnect
  const prevUidRef = useRef(keyboardUid)
  const keymapSize = keymap.size
  useEffect(() => {
    if (keyboardUid !== prevUidRef.current || keymapSize === 0) {
      prevUidRef.current = keyboardUid
      history.clear()
      viewMatrixMode.exit()
    }
  }, [keyboardUid, keymapSize, history.clear, viewMatrixMode.exit])

  // Surface the editor test's run state so the host can disable the
  // StatusBar "View Analytics" button mid-run (it lives in the footer, not
  // this component). False whenever the test isn't running or mode is off.
  useEffect(() => {
    onTypingTestRunningChange?.(!!typingTestMode && typingTest.state.status === 'running')
  }, [typingTestMode, typingTest.state.status, onTypingTestRunningChange])

  // --- Escape clears picker selection ---
  useEffect(() => {
    if (pickerSelectedIndices.size === 0) return
    function onKeyDown(e: KeyboardEvent) { if (e.key === 'Escape') multiSelect.clearPickerSelection() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pickerSelectedIndices.size, multiSelect])

  // --- QMK settings modals + Tap Dance / Combo / Key Override / Alt Repeat
  // Key / Macro "Edit JSON" modals ---
  const {
    openSettings, closeSettings, visibleModals,
    tdJson, comboJson, koJson, arkJson, macroJson,
  } = useKeymapJsonEditors({
    unlocked, onUnlock,
    tapDanceEntries, onSetTapDanceEntry,
    comboEntries, onSetComboEntry,
    keyOverrideEntries, onSetKeyOverrideEntry,
    altRepeatKeyEntries, onSetAltRepeatKeyEntry,
    onSaveMacros, macroBufferSize, vialProtocol,
    tapHoldSupported, mouseKeysSupported, magicSupported, graveEscapeSupported,
    autoShiftSupported, oneShotKeysSupported, comboSettingsSupported,
  })

  // --- Layer panel ---
  const layerPanelCollapsed = layerPanelOpenProp === false
  const toggleLayerPanel = useCallback(() => { onLayerPanelOpenChange?.(!layerPanelOpenProp) }, [onLayerPanelOpenChange, layerPanelOpenProp])

  // --- Key Label "apply to keymap" bulk rewrite (Plan-key-label-keymap-apply
  // Phase 3). Reachable from the footer's layout select via the imperative
  // handle below, so the write lands on this same `history` instance
  // instead of a second undo stack. Writes go through `onSetKey` /
  // `onSetEncoder` sequentially (not `onSetKeysBulk`) so a mid-way failure
  // leaves both the local keymap state and the pushed history entry
  // containing only the positions that actually succeeded.
  //
  // Same "ref mirrors the latest prop for use inside a stable callback"
  // idiom as `hasActiveSingleSelectionRef` above: `keymap`/`encoderLayout`
  // are re-read fresh from these refs before every single write below, so a
  // concurrent edit that lands on a position between two `await`s (or
  // during a re-render triggered by one of this function's own writes) is
  // detected instead of silently clobbered.
  const keymapRef = useRef(keymap)
  keymapRef.current = keymap
  const encoderLayoutRef = useRef(encoderLayout)
  encoderLayoutRef.current = encoderLayout
  const isApplyingRewriteRef = useRef(false)
  // Belt-and-braces unmount guard: the editor-footer Analyze button can open
  // AnalyzePage (unmounting this component) while a rewrite's sequential
  // `await`ed device writes are still in flight — the caller-side guard in
  // App.tsx disables that button while a rewrite is running, but this ref
  // is the last line of defense so a rewrite already past that guard still
  // stops cleanly instead of pushing history / firing callbacks / setting
  // state on an unmounted component.
  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => { isMountedRef.current = false }
  }, [])

  const applyKeymapRewrite = useCallback(async (
    table: KeymapRewriteTable,
    layoutIds?: KeymapRewriteLayoutIds,
  ): Promise<KeymapApplyResult> => {
    // Re-entrancy guard: a double Apply click (or any other concurrent
    // caller) must never interleave two rewrite passes against the same
    // undo stack. No-op rather than throwing — the in-flight call already
    // owns the operation.
    if (isApplyingRewriteRef.current) return { appliedCount: 0 }
    isApplyingRewriteRef.current = true

    try {
      const keyChanges: { layer: number; row: number; col: number; oldKeycode: number; newKeycode: number }[] = []
      for (const [posKey, code] of keymap) {
        const newKeycode = rewriteNumericKeycode(code, table)
        if (newKeycode === code) continue
        const [layer, row, col] = posKey.split(',').map(Number)
        keyChanges.push({ layer, row, col, oldKeycode: code, newKeycode })
      }
      const encoderChanges: { layer: number; idx: number; dir: number; oldKeycode: number; newKeycode: number }[] = []
      for (const [posKey, code] of encoderLayout) {
        const newKeycode = rewriteNumericKeycode(code, table)
        if (newKeycode === code) continue
        const [layer, idx, dir] = posKey.split(',').map(Number)
        encoderChanges.push({ layer, idx, dir, oldKeycode: code, newKeycode })
      }

      const applied: SingleHistoryEntry[] = []
      let error: string | undefined
      try {
        for (const c of keyChanges) {
          // Stop immediately once the component has unmounted (e.g. the
          // Analyze button navigated away mid-rewrite) — no further writes.
          if (!isMountedRef.current) break
          // Freshness check: skip this position if a concurrent edit
          // already moved it away from the value this rewrite was
          // computed against, instead of overwriting whatever that edit
          // just wrote.
          const current = keymapRef.current.get(`${c.layer},${c.row},${c.col}`) ?? 0
          if (current !== c.oldKeycode) continue
          await onSetKey(c.layer, c.row, c.col, c.newKeycode)
          applied.push({ kind: 'key', layer: c.layer, row: c.row, col: c.col, oldKeycode: c.oldKeycode, newKeycode: c.newKeycode })
        }
        for (const c of encoderChanges) {
          if (!isMountedRef.current) break
          const current = encoderLayoutRef.current.get(`${c.layer},${c.idx},${c.dir}`) ?? 0
          if (current !== c.oldKeycode) continue
          await onSetEncoder(c.layer, c.idx, c.dir, c.newKeycode)
          applied.push({ kind: 'encoder', layer: c.layer, idx: c.idx, dir: c.dir as 0 | 1, oldKeycode: c.oldKeycode, newKeycode: c.newKeycode })
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }

      // Unmounted mid-rewrite: skip ALL bookkeeping below (history push,
      // appliedKeymapLayout persistence, post-apply flash state/timer) —
      // the component is gone, so there is nothing left to flash and no
      // history stack of this instance to push onto. The device is left
      // mid-rewrite exactly like a partial-failure apply; the counts are
      // still returned to the caller for its own error surfacing.
      if (applied.length > 0 && isMountedRef.current) {
        // Only attach appliedKeymapLayout bookkeeping when the rewrite
        // completed without error. A partial failure leaves the keymap in
        // a MIXED state (some positions rewritten, some not) — it's
        // neither still `layoutIds.before` nor fully `layoutIds.after`, so
        // claiming either would be wrong. Push a plain batch instead: undo
        // needs no bookkeeping to correctly return the keymap (and
        // appliedKeymapLayout, left untouched) to its prior state.
        const bookkeepable = error === undefined ? layoutIds : undefined
        history.push(
          bookkeepable
            ? { kind: 'batch', entries: applied, appliedLayoutBefore: bookkeepable.before, appliedLayoutAfter: bookkeepable.after }
            : { kind: 'batch', entries: applied },
        )
        // Persist PipetteSettings.appliedKeymapLayout immediately on a
        // successful rewrite (Plan-key-label-keymap-apply, 追加要求
        // 2026-07-18) — undo/redo of the batch entry just pushed keeps it
        // in sync afterwards via the same callback (useKeymapSelectionHandlers).
        if (bookkeepable) onAppliedKeymapLayoutChange?.(bookkeepable.after)

        // Flash the rewritten positions (see `useKeyFlash`) — only for a
        // clean, error-free pass. A partial failure leaves the keymap
        // mixed, which isn't the "here's what changed" story this visual
        // is telling.
        if (error === undefined) triggerFlash(applied)
      }
      return { appliedCount: applied.length, error }
    } finally {
      isApplyingRewriteRef.current = false
    }
  }, [keymap, encoderLayout, onSetKey, onSetEncoder, history, onAppliedKeymapLayoutChange, triggerFlash])

  useImperativeHandle(ref, () => ({
    toggleMatrix: handleMatrixToggle, toggleTypingTest: handleTypingTestToggle,
    matrixMode, hasMatrixTester,
    applyKeymapRewrite,
  }), [handleMatrixToggle, handleTypingTestToggle, matrixMode, hasMatrixTester, applyKeymapRewrite])

  // --- Layer keycode builders (current layer / typing test / picker) ---
  const {
    deserializedMacros, configuredKeycodes,
    buildKeycodesForLayer, buildEncoderKeycodesForLayer,
    layerKeycodes, remappedKeys, layerEncoderKeycodes,
    typingTestKeycodes, typingTestRemapped, typingTestEncoderKeycodes,
  } = useLayerKeycodes({
    parsedMacros, macroBuffer, macroCount, vialProtocol, tapDanceEntries,
    remapLabel, isRemapped, keymap, encoderLayout, encoderCount, currentLayer,
    typingTestMode, typingTestEffectiveLayer: typingTest.effectiveLayer,
  })

  // --- Layout picker (device browse / file browse / probe / keyboard view) ---
  const { layoutPickerContent } = useLayoutPicker({
    layout, layers, layerNames, keymap, effectiveLayoutOptions, remapLabel,
    scale: scaleProp, onScaleChange,
    devices, connectedDevice, onDeviceListActiveChange,
    selectedKey, selectedEncoder, handleKeycodeSelect, handlePickerMultiSelect,
    pickerSelectedIndices, clearPickerSelection: multiSelect.clearPickerSelection,
    buildKeycodesForLayer, buildEncoderKeycodesForLayer,
  })

  // --- Tab footer ---
  const tabFooterContent = useMemo(() => {
    const btnClass = 'rounded border border-edge px-3 py-1 text-xs text-content-secondary hover:text-content hover:bg-surface-dim'
    const buttonDefs = [
      { tab: 'tapDance', key: 'tdJsonEditor', label: t('editor.tapDance.editJson'), onClick: tdJson.open, testId: 'tap-dance-json-editor-btn', enabled: !!tapDanceEntries && tapDanceEntries.length > 0 },
      { tab: 'tapDance', key: 'tapHold', label: t('editor.keymap.tapHoldLabel'), onClick: () => openSettings('tapHold'), testId: 'tap-hold-settings-btn', enabled: tapHoldSupported },
      { tab: 'system', key: 'mouseKeys', label: t('editor.keymap.mouseKeysLabel'), onClick: () => openSettings('mouseKeys'), testId: 'mouse-keys-settings-btn', enabled: mouseKeysSupported },
      { tab: 'modifiers', key: 'graveEscape', label: t('editor.keymap.graveEscapeLabel'), onClick: () => openSettings('graveEscape'), testId: 'grave-escape-settings-btn', enabled: graveEscapeSupported },
      { tab: 'modifiers', key: 'oneShotKeys', label: t('editor.keymap.oneShotKeysLabel'), onClick: () => openSettings('oneShotKeys'), testId: 'one-shot-keys-settings-btn', enabled: oneShotKeysSupported },
      { tab: 'behavior', key: 'magic', label: t('editor.keymap.magicLabel'), onClick: () => openSettings('magic'), testId: 'magic-settings-btn', enabled: magicSupported },
      { tab: 'behavior', key: 'autoshift', label: t('editor.keymap.autoShiftLabel'), onClick: () => openSettings('autoShift'), testId: 'auto-shift-settings-btn', enabled: autoShiftSupported },
      { tab: 'macro', key: 'macroJsonEditor', label: t('editor.tapDance.editJson'), onClick: macroJson.openGated, testId: 'macro-json-editor-btn', enabled: !!deserializedMacros && deserializedMacros.length > 0 },
      { tab: 'combo', key: 'comboJsonEditor', label: t('editor.tapDance.editJson'), onClick: comboJson.open, testId: 'combo-json-editor-btn', enabled: !!comboEntries && comboEntries.length > 0 },
      { tab: 'combo', key: 'combo', label: t('common.configuration'), onClick: () => openSettings('combo'), testId: 'combo-settings-btn', enabled: comboSettingsSupported },
      { tab: 'keyOverride', key: 'koJsonEditor', label: t('editor.tapDance.editJson'), onClick: koJson.open, testId: 'ko-json-editor-btn', enabled: !!keyOverrideEntries && keyOverrideEntries.length > 0 },
      { tab: 'altRepeatKey', key: 'arkJsonEditor', label: t('editor.tapDance.editJson'), onClick: arkJson.open, testId: 'ark-json-editor-btn', enabled: !!altRepeatKeyEntries && altRepeatKeyEntries.length > 0 },
      { tab: 'lighting', key: 'lighting', label: t('common.configuration'), onClick: onOpenLighting, testId: 'lighting-settings-btn', enabled: !!onOpenLighting },
    ]
    const content: Record<string, React.ReactNode> = {}
    const grouped = new Map<string, typeof buttonDefs>()
    for (const def of buttonDefs) { if (!def.enabled) continue; const existing = grouped.get(def.tab); if (existing) existing.push(def); else grouped.set(def.tab, [def]) }
    for (const [tab, defs] of grouped) {
      content[tab] = (
        <div className="flex items-center gap-2">
          <span className="text-xs text-content-secondary/70">{t('common.settingsLabel')}</span>
          {defs.map((d) => (<button key={d.key} type="button" className={btnClass} onClick={d.onClick} data-testid={d.testId}>{d.label}</button>))}
        </div>
      )
    }
    return content
  }, [tapDanceEntries, comboEntries, keyOverrideEntries, altRepeatKeyEntries, deserializedMacros, tapHoldSupported, mouseKeysSupported, magicSupported, autoShiftSupported, graveEscapeSupported, oneShotKeysSupported, comboSettingsSupported, onOpenLighting, t, openSettings, tdJson.open, comboJson.open, koJson.open, arkJson.open, macroJson.openGated])

  const tabContentOverride = useTileContentOverride({
    tapDanceEntries,
    deserializedMacros,
    onSelect: gatedHandleKeycodeSelect,
    settings: { comboEntries, onOpenCombo, keyOverrideEntries, onOpenKeyOverride, altRepeatKeyEntries, onOpenAltRepeatKey },
  })

  if (!layout) return <div className="p-4 text-content-muted">{t('common.loading')}</div>

  function layerLabel(layer: number): string {
    return layerNames?.[layer] || t('editor.keymap.layerN', { n: layer })
  }

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${typingTestMode && typingTestViewOnly ? '' : 'gap-3'}`}>
      <div
        className={typingTestMode
          ? (typingTestViewOnly ? 'flex flex-1 items-stretch gap-2' : 'flex min-h-0 flex-1 items-stretch gap-2 overflow-auto')
          // View Matrix mode hides the keycode picker row entirely (see
          // below), so this row alone must fill the remaining vertical
          // space it would otherwise have shared with the picker.
          : viewMatrixMode.active ? 'flex min-h-0 flex-1 items-start gap-2 overflow-auto' : 'flex items-start gap-2 overflow-auto'}
        style={!typingTestMode && keyboardAreaMinHeight ? { minHeight: keyboardAreaMinHeight } : undefined}
        onClick={!typingTestMode ? handleDeselectClick : undefined}
      >
        {/* The toolbar (undo/redo/zoom) is empty in typing-test mode — all its
            controls are editor-only — so drop the whole 50px column there.
            View Matrix mode also drops it: undo/redo are hidden (keymap
            edits are disabled for the mode's duration) and zoom relocates
            to a row under the keymap pane (see below), so nothing would be
            left in the column. */}
        {!typingTestMode && !viewMatrixMode.active && (
          <KeymapToolbar
            typingTestMode={typingTestMode} viewMatrixActive={viewMatrixMode.active}
            canUndo={history.canUndo} canRedo={history.canRedo}
            onUndo={handleUndo} onRedo={handleRedo}
            scale={scaleProp} onScaleChange={onScaleChange}
          />
        )}
        {/* View Matrix mode's left pane — replaces the layer selector slot
            that normally sits below, since this row is now the only one
            rendered (the keycode picker row is hidden for the mode's
            duration). Its Edit toggle (rendered ON) is the sole way back
            to normal editing now that the overlay panel's own toggle is
            hidden along with the rest of the picker. */}
        {!typingTestMode && viewMatrixMode.active && (
          <ViewMatrixPanel
            onReset={() => onViewMatrixChange?.(undefined)}
            onToggle={handleToggleViewMatrixMode}
            selectionCount={viewMatrixSelectedPositions.length}
            effectiveRow={viewMatrixEffectiveSingle?.row ?? 0}
            effectiveCol={viewMatrixEffectiveSingle?.col ?? 0}
            matrixRows={viewMatrixAxisOptionCount}
            matrixCols={viewMatrixAxisOptionCount}
            onAxisChange={handleViewMatrixAxisChange}
          />
        )}
        <div className={typingTestMode
          ? 'flex min-h-0 min-w-0 flex-1 flex-col gap-3'
          // View Matrix mode stacks the keymap above its relocated zoom
          // row (sketch: "keymap" over "zoom controls" in the right
          // column); normal mode keeps the single-child centered row.
          : viewMatrixMode.active ? 'flex min-w-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto' : 'flex min-w-0 flex-1 items-center justify-center gap-4 overflow-auto'}>
          {typingTestMode ? (
            <TypingTestPane
              typingTest={typingTest}
              onConfigChange={handleTypingTestConfigChange}
              monkeytypeConfig={typingTestMonkeytypeConfig}
              onLanguageChange={handleTypingTestLanguageChange}
              layers={layers}
              layerNames={layerNames}
              typingTestHistory={typingTestHistory}
              onRenameTypingTestResult={onRenameTypingTestResult}
              onDeleteTypingTestResult={onDeleteTypingTestResult}
              deviceName={deviceName}
              pressedKeys={pressedKeys}
              keycodes={typingTestKeycodes}
              encoderKeycodes={typingTestEncoderKeycodes}
              remappedKeys={typingTestRemapped}
              remapLabel={remapLabel}
              layoutOptions={effectiveLayoutOptions}
              scale={scaleProp}
              keys={layout.keys}
              layerLabel={layerLabel(typingTest.effectiveLayer)}
              contentRef={keyboardContentRef}
              hasSavedMemory={!!savedTypingTestMemory}
              displayLines={typingTestDisplayLines}
              fontSize={typingTestFontSize}
              onDisplayLinesChange={onTypingTestDisplayLinesChange}
              onFontSizeChange={onTypingTestFontSizeChange}
              hideKeymap={typingTestHideKeymap}
              hideStatsRow={typingTestHideStatsRow}
              hideControls={typingTestHideControls}
              saveUnnamed={typingTestSaveUnnamed}
              finishedResult={finishedResult}
              onNameFinishedResult={nameFinishedResult}
              comparisonBaselines={typingTestComparisonBaselines}
              onToggleHideKeymap={onTypingTestHideKeymapChange}
              onToggleHideStatsRow={onTypingTestHideStatsRowChange}
              onToggleHideControls={onTypingTestHideControlsChange}
              onToggleSaveUnnamed={onTypingTestSaveUnnamedChange}
              onComparisonBaselineChange={onTypingTestComparisonBaselineChange}
              settingsPanelOpen={typingTestSettingsPanelOpen}
              onToggleSettingsPanel={onTypingTestSettingsPanelOpenChange}
              onPauseTest={pauseTypingTest}
              onResumeTest={resumeTypingTest}
              onRestartTestFromStart={restartTypingTestFromStart}
              viewOnly={typingTestViewOnly}
              onViewOnlyChange={onTypingTestViewOnlyChange}
              viewOnlyWindowSize={typingTestViewOnlyWindowSize}
              onViewOnlyWindowSizeChange={onTypingTestViewOnlyWindowSizeChange}
              viewOnlyAlwaysOnTop={typingTestViewOnlyAlwaysOnTop}
              onViewOnlyAlwaysOnTopChange={onTypingTestViewOnlyAlwaysOnTopChange}
              recordEnabled={typingRecordEnabled}
              onRecordEnabledChange={onTypingRecordEnabledChange}
              recordingConsentAccepted={typingRecordingConsentAccepted}
              onRecordingConsentAccepted={onTypingRecordingConsentAccepted}
              heatmapWindowMin={typingHeatmapWindowMin}
              onHeatmapWindowMinChange={onTypingHeatmapWindowMinChange}
              monitorAppEnabled={typingMonitorAppEnabled}
              onMonitorAppEnabledChange={onTypingMonitorAppEnabledChange}
              trayResident={typingTrayResident}
              onTrayResidentChange={onTypingTrayResidentChange}
              startInTray={typingStartInTray}
              onStartInTrayChange={onTypingStartInTrayChange}
              menuTab={typingViewMenuTab}
              onMenuTabChange={onTypingViewMenuTabChange}
              onViewAnalytics={onViewAnalytics}
              keyboardUid={keyboardUid}
            />
          ) : (
            <>
              <KeyboardPane
                paneId="primary" isActive={true}              keys={layout.keys} keycodes={layerKeycodes} encoderKeycodes={layerEncoderKeycodes}
                selectedKey={selectedKey} selectedEncoder={selectedEncoder} selectedMaskPart={selectedMaskPart} selectedKeycode={selectedKeycode}
                pressedKeys={matrixMode ? pressedKeys : undefined} everPressedKeys={matrixMode ? everPressedKeys : undefined}
                remappedKeys={remappedKeys} flash={flash} multiSelectedKeys={viewMatrixMode.active ? viewMatrixMode.selectedKeys : multiSelectedKeys}
                layoutOptions={effectiveLayoutOptions} scale={scaleProp}
                labelOverrides={viewMatrixLabelOverrides} keyColors={viewMatrixDuplicateKeyColors} remapLabel={remapLabel}
                layerLabel={viewMatrixMode.active ? undefined : layerLabel(currentLayer)} layerLabelTestId="layer-label"
                onKeyClick={viewMatrixMode.active ? handleViewMatrixKeyClick : handleKeyClick}
                onKeyDoubleClick={viewMatrixMode.active ? undefined : handleKeyDoubleClick}
                onEncoderClick={viewMatrixMode.active ? undefined : handleEncoderClick}
                onEncoderDoubleClick={viewMatrixMode.active ? undefined : handleEncoderDoubleClick}
                onDeselect={viewMatrixMode.active ? viewMatrixMode.clearSelection : handleDeselect} contentRef={keyboardContentRef}
              />
              {/* View Matrix mode's relocated zoom row — same controls as
                  the normal-mode toolbar, moved below the keymap pane —
                  plus the same Ctrl/Shift multi-select hint the keycode
                  picker shows in normal mode (reused key: the picker is
                  hidden entirely for the mode's duration, but the
                  Ctrl+click / Shift+click gestures it describes still
                  drive this mode's own multi-selection). */}
              {viewMatrixMode.active && (
                <div className="flex flex-col items-center gap-1">
                  <p className="text-xs text-content-muted">{t('editor.keymap.pickerHint')}</p>
                  {/* Same arrangement as the picker Keyboard tab's zoom
                      row: ZoomOut, scale, ZoomIn in ghost styling. */}
                  {onScaleChange && (
                    <div className="flex items-center gap-1">
                      <Tooltip content={t('editor.keymap.zoomOut')}>
                        <button type="button" data-testid="zoom-out-button" aria-label={t('editor.keymap.zoomOut')}
                          className={ghostZoomButtonClass} disabled={scaleProp <= MIN_SCALE} onClick={() => onScaleChange(-0.1)}>
                          <ZoomOut size={ICON_SM} aria-hidden="true" />
                        </button>
                      </Tooltip>
                      <ScaleInput scale={scaleProp} onScaleChange={onScaleChange} />
                      <Tooltip content={t('editor.keymap.zoomIn')}>
                        <button type="button" data-testid="zoom-in-button" aria-label={t('editor.keymap.zoomIn')}
                          className={ghostZoomButtonClass} disabled={scaleProp >= MAX_SCALE} onClick={() => onScaleChange(0.1)}>
                          <ZoomIn size={ICON_SM} aria-hidden="true" />
                        </button>
                      </Tooltip>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        {!typingTestMode && <div style={{ width: PANEL_COLLAPSED_WIDTH }} className="shrink-0" />}
      </div>

      {!typingTestMode && popoverState && (
        <PopoverForState
          popoverState={popoverState} keymap={keymap} encoderLayout={encoderLayout}
          currentLayer={currentLayer} layers={layers}
          onLayerChange={onLayerChange} layerNames={layerNames}
          onKeycodeSelect={handlePopoverKeycodeSelect} onRawKeycodeSelect={handlePopoverRawKeycodeSelect}
          onModMaskChange={handlePopoverModMaskChange}
          onClose={() => setPopoverState(null)} quickSelect={quickSelect}
          previousKeycode={popoverUndoKeycode} onUndo={handlePopoverUndo}
          nextKeycode={popoverRedoKeycode} onRedo={handlePopoverRedo}
          remapLabel={remapLabel}
        />
      )}

      {/* The entire keycode picker area — tabs, tiles, and the overlay panel
          (incl. its own View Matrix Edit/Done button) — is hidden while
          View Matrix mode is active; ViewMatrixPanel above is the mode's
          only surface, and its own toggle is the sole way back to normal
          editing. */}
      {!typingTestMode && !viewMatrixMode.active && (
        <div className="flex min-h-0 flex-1 gap-2">
          {onLayerChange && layers > 1 && (
            <LayerListPanel layers={layers} currentLayer={currentLayer} onLayerChange={onLayerChange}
              layerNames={layerNames} onSetLayerName={onSetLayerName} collapsed={layerPanelCollapsed} onToggleCollapse={toggleLayerPanel} />
          )}
          <TabbedKeycodes
            keyboardPickerContent={layoutPickerContent}
            onKeycodeSelect={gatedHandleKeycodeSelect} onKeycodeMultiSelect={handlePickerMultiSelect}
            pickerSelectedIndices={pickerSelectedIndices}
            pickerMultiSelectEnabled={!selectedKey && !selectedEncoder}
            onBackgroundClick={handleDeselect}
            onTabChange={() => { multiSelect.clearPickerSelection() }}
            highlightedKeycodes={configuredKeycodes} maskOnly={isMaskKey} lmMode={isLMMask} showHint={!isMaskKey}
            tabFooterContent={tabFooterContent} tabContentOverride={tabContentOverride}
            basicViewType={basicViewType} onBasicViewTypeChange={onBasicViewTypeChange} splitKeyMode={splitKeyMode} remapLabel={remapLabel}
            tabBarRight={
              <Tooltip content={t('editorSettings.title')}>
                <button ref={layoutButtonRef} type="button" aria-label={t('editorSettings.title')}
                  aria-expanded={layoutPanelOpen} aria-controls="keycodes-overlay-panel"
                  className={`rounded p-1 transition-colors ${layoutPanelOpen ? 'bg-surface-dim text-accent' : 'text-content-secondary hover:bg-surface-dim hover:text-content'}`}
                  onClick={() => { setLayoutPanelOpen((prev) => { if (!prev) onOverlayOpen?.(); return !prev }) }}
                >
                  <SlidersHorizontal size={ICON_MD} aria-hidden="true" />
                </button>
              </Tooltip>
            }
            panelOverlay={
              <div id="keycodes-overlay-panel" ref={layoutPanelRef}
                className={`absolute inset-y-0 right-0 z-10 w-fit min-w-keycode-panel max-w-keycode-panel rounded-l-lg rounded-r-panel-connector border-l border-edge-subtle bg-surface-alt shadow-lg transition-transform duration-200 ease-out ${layoutPanelOpen ? 'translate-x-0' : 'translate-x-full'}`}
                inert={!layoutPanelOpen || undefined}
              >
                <KeycodesOverlayPanel
                  hasLayoutOptions={hasLayoutOptions} layoutOptions={parsedOptions} layoutValues={layoutValues}
                  onLayoutOptionChange={handleLayoutOptionChange} autoAdvance={autoAdvance} onAutoAdvanceChange={onAutoAdvanceChange}
                  viewMatrixActive={viewMatrixMode.active} onToggleViewMatrixMode={handleToggleViewMatrixMode}
                  splitKeyMode={splitKeyMode} onSplitKeyModeChange={onSplitKeyModeChange}
                  quickSelect={quickSelect} onQuickSelectChange={onQuickSelectChange}
                  matrixMode={matrixMode} hasMatrixTester={hasMatrixTester} onToggleMatrix={viewMatrixMode.active ? undefined : handleMatrixToggle}
                  unlocked={unlocked ?? false} onLock={onLock} isDummy={isDummy}
                  toolsExtra={toolsExtra} dataPanel={dataPanel}
                  keyEditorZoom={keyEditorZoom} onKeyEditorZoomChange={onKeyEditorZoomChange}
                  onExportLayoutPdfAll={onExportLayoutPdfAll} onExportLayoutPdfCurrent={onExportLayoutPdfCurrent}
                />
              </div>
            }
          />
        </div>
      )}

      <KeymapEditorModals
        tdModalIndex={tdModalIndex} tapDanceEntries={tapDanceEntries} onSetTapDanceEntry={onSetTapDanceEntry}
        handleTdModalSave={handleTdModalSave} handleTdModalClose={handleTdModalClose}
        macroModalIndex={macroModalIndex} macroBuffer={macroBuffer} macroCount={macroCount}
        macroBufferSize={macroBufferSize} vialProtocol={vialProtocol} onSaveMacros={onSaveMacros}
        parsedMacros={parsedMacros} handleMacroModalClose={handleMacroModalClose}
        unlocked={unlocked} onUnlock={onUnlock} autoAdvance={autoAdvance} layers={layers}
        isDummy={isDummy} deserializedMacros={deserializedMacros} quickSelect={quickSelect}
        splitKeyMode={splitKeyMode} basicViewType={basicViewType}
        favHubOrigin={favHubOrigin} favHubNeedsDisplayName={favHubNeedsDisplayName}
        favHubUploading={favHubUploading} favHubUploadResult={favHubUploadResult}
        onFavUploadToHub={onFavUploadToHub} onFavUpdateOnHub={onFavUpdateOnHub}
        onFavRemoveFromHub={onFavRemoveFromHub} onFavRenameOnHub={onFavRenameOnHub}
        comboEntries={comboEntries} keyOverrideEntries={keyOverrideEntries} altRepeatKeyEntries={altRepeatKeyEntries}
        tdJson={tdJson} comboJson={comboJson} koJson={koJson} arkJson={arkJson} macroJson={macroJson}
        supportedQsids={supportedQsids} qmkSettingsGet={qmkSettingsGet} qmkSettingsSet={qmkSettingsSet}
        qmkSettingsReset={qmkSettingsReset} onSettingsUpdate={onSettingsUpdate}
        visibleModals={visibleModals} closeSettings={closeSettings}
      />

    </div>
  )
})
