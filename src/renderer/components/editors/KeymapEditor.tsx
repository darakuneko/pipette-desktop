// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useTileContentOverride } from '../../hooks/useTileContentOverride'
import { ViewMatrixPanel } from './ViewMatrixPanel'

// Extracted modules
import type { KeymapEditorProps as Props } from './keymap-editor-types'
import { PANEL_COLLAPSED_WIDTH } from './keymap-editor-types'
export type { KeymapEditorHandle } from './keymap-editor-types'
import { KeymapToolbar, ViewMatrixZoomRow } from './keymap-editor-toolbar'
import { useKeymapTabFooter } from './use-keymap-tab-footer'
import { PopoverForState, popoverInstanceKey } from './keymap-editor-popover'
import { useInputModes } from './useInputModes'
import { useKeymapMultiSelect } from './useKeymapMultiSelect'
import { useLayoutOptionsPanel } from './useLayoutOptionsPanel'
import { useKeymapSelectionHandlers } from './useKeymapSelectionHandlers'
import { useKeymapHistory } from './useKeymapHistory'
import { useKeyFlash } from './useKeyFlash'
import { useAppConfig } from '../../hooks/useAppConfig'
import { KeymapTypingTestPane } from './KeymapTypingTestPane'
import { useLayoutPicker } from './useLayoutPicker'
import { useKeymapJsonEditors } from './useKeymapJsonEditors'
import { useViewMatrixEditing } from './useViewMatrixEditing'
import { KeymapEditorModals } from './KeymapEditorModals'
import { useLayerKeycodes } from './use-layer-keycodes'
import { useKeymapRewrite } from './use-keymap-rewrite'
import { useKeymapPackTabs } from './use-keymap-pack-tabs'
import { KeymapPickerRegion } from './KeymapPickerRegion'
import { KeymapPrimaryPane } from './KeymapPrimaryPane'

export const KeymapEditor = forwardRef<import('./keymap-editor-types').KeymapEditorHandle, Props>(function KeymapEditor(props, ref) {
  // Kept as a whole object (not just destructured) so the typing-test
  // surface below can forward it wholesale to `KeymapTypingTestPane` via
  // `{...props}` — most of that pane's props are plain pass-through from
  // here, and only a handful of runtime-computed values need to be listed
  // explicitly at that call site (see the comment there).
  const {
    keyboardUid, layout, layers, currentLayer, onLayerChange, keymap, encoderLayout, encoderCount,
    layoutOptions, layoutLabels, packedLayoutOptions, onSetLayoutOptions,
    remapLabel, isRemapped, remapKind, pickerRemapLabel, onSetKey, onSetKeysBulk, onSetEncoder,
    rows, cols, getMatrixState, unlocked, onUnlock,
    tapDanceEntries, onSetTapDanceEntry,
    macroCount, macroBufferSize, macroBuffer, vialProtocol, parsedMacros, onSaveMacros,
    tapHoldSupported, mouseKeysSupported, magicSupported, graveEscapeSupported,
    autoShiftSupported, oneShotKeysSupported, comboSettingsSupported,
    supportedQsids, qmkSettingsGet, qmkSettingsSet, qmkSettingsReset, onSettingsUpdate,
    autoAdvance = true, viewMatrix, onViewMatrixChange,
    basicViewType, splitKeyMode,
    quickSelect, keyboardLayout = 'qwerty',
    keymapPackName, onRequestKeymapApply,
    keymapApplyOpen, keymapApplyLabelName, keymapApplyBusy, onKeymapApplyConfirm, onKeymapApplyCancel, keymapApplyError,
    onMatrixModeChange, onOpenLighting,
    comboEntries, onOpenCombo, onSetComboEntry,
    keyOverrideEntries, onOpenKeyOverride, onSetKeyOverrideEntry,
    altRepeatKeyEntries, onOpenAltRepeatKey, onSetAltRepeatKeyEntry,
    layerNames,
    layerPanelOpen: layerPanelOpenProp, onLayerPanelOpenChange,
    scale: scaleProp = 1, onScaleChange,
    typingTestMode, onTypingTestModeChange, onSaveTypingTestResult, onRenameTypingTestResult, typingTestHistory,
    typingTestConfig: savedTypingTestConfig, typingTestLanguage: savedTypingTestLanguage,
    onTypingTestConfigChange, onTypingTestLanguageChange,
    typingTestViewOnly,
    typingTestMemory: savedTypingTestMemory, onTypingTestMemoryChange,
    typingTestSaveUnnamed = true,
    typingRecordEnabled, onRecKeystroke,
    typingRecordingConsentAccepted,
    onTypingTestRunningChange,
    tappingTermMs,
    deviceName, isDummy,
    favHubOrigin, favHubNeedsDisplayName, favHubUploading, favHubUploadResult,
    onFavUploadToHub, onFavUpdateOnHub, onFavRemoveFromHub, onFavRenameOnHub,
    devices, connectedDevice, onDeviceListActiveChange,
  } = props
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
    recordingConsentAccepted: typingRecordingConsentAccepted,
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
    selectedKey, selectedEncoder, selectedMaskPart, popoverState, closePopover,
    selectedKeycode, isMaskKey, isLMMask,
    handleKeyClick, handleEncoderClick, handleKeyDoubleClick, handleEncoderDoubleClick,
    handleKeycodeSelect, handlePopoverKeycodeSelect, handlePopoverRawKeycodeSelect,
    handlePopoverModMaskChange, popoverUndoKeycode, handlePopoverUndo,
    popoverRedoKeycode, handlePopoverRedo,
    handleUndo, handleRedo,
    handleDeselect, handleDeselectClick,
    tdModalIndex, macroModalIndex, handleTdModalSave, handleTdModalClose, handleMacroModalClose,
  } = useKeymapSelectionHandlers({
    keymap, encoderLayout, currentLayer,
    selectableKeys, autoAdvance, viewMatrix,
    onSetKey, onSetKeysBulk, onSetEncoder, keyboardContentRef, unlocked, onUnlock,
    multiSelect, history,
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
  // instead of a second undo stack. See `useKeymapRewrite` for the full
  // destructive-one-shot / freshness-check / unmount-guard contract.
  const { applyKeymapRewrite } = useKeymapRewrite({
    keymap, encoderLayout, onSetKey, onSetEncoder, history, triggerFlash,
  })

  useImperativeHandle(ref, () => ({
    toggleMatrix: handleMatrixToggle, toggleTypingTest: handleTypingTestToggle,
    matrixMode, hasMatrixTester,
    applyKeymapRewrite,
    clearHistory: history.clear,
  }), [handleMatrixToggle, handleTypingTestToggle, matrixMode, hasMatrixTester, applyKeymapRewrite, history.clear])

  // --- Layer keycode builders (current layer / typing test / picker) ---
  const {
    deserializedMacros, configuredKeycodes,
    buildKeycodesForLayer, buildEncoderKeycodesForLayer,
    layerKeycodes, remappedKeys, layerEncoderKeycodes, layerEncoderRemapped,
    typingTestKeycodes, typingTestRemapped, typingTestEncoderKeycodes, typingTestEncoderRemapped,
  } = useLayerKeycodes({
    parsedMacros, macroBuffer, macroCount, vialProtocol, tapDanceEntries,
    remapLabel, isRemapped, keymap, encoderLayout, encoderCount, currentLayer,
    typingTestMode, typingTestEffectiveLayer: typingTest.effectiveLayer,
  })

  // --- Simulation/Base tab (Plan-qwerty-select-no-rewrite v7). See
  // `useKeymapPackTabs` for the full tab-visibility / read-only / Base-tab
  // raw-data contract. ---
  const {
    packTab, showPackTabs, packTabReadOnly,
    primaryKeycodes, primaryEncoderKeycodes, primaryRemappedKeys, primaryRemappedEncoders, primaryRemapLabel,
    handlePackTabChange, resetPackTab,
  } = useKeymapPackTabs({
    keyboardLayout, remapKind, keymap, encoderLayout, encoderCount, currentLayer,
    typingTestMode, viewMatrixActive: viewMatrixMode.active, handleDeselect,
    parsedMacros, macroBuffer, macroCount, vialProtocol, tapDanceEntries,
    remapLabel, layerKeycodes, layerEncoderKeycodes, remappedKeys, layerEncoderRemapped,
  })

  // Clear history and exit View Matrix mode on keyboard/context switch or
  // disconnect — kept in this component (rather than folded into
  // `useKeymapPackTabs`) because it also owns `history`/`viewMatrixMode`,
  // not just the pack tab.
  const prevUidRef = useRef(keyboardUid)
  const keymapSize = keymap.size
  useEffect(() => {
    if (keyboardUid !== prevUidRef.current || keymapSize === 0) {
      prevUidRef.current = keyboardUid
      history.clear()
      viewMatrixMode.exit()
      resetPackTab()
    }
  }, [keyboardUid, keymapSize, history.clear, viewMatrixMode.exit, resetPackTab])

  // --- Layout picker (device browse / file browse / probe / keyboard view) ---
  // The Keyboard tab's keyboard-as-picker (`LayoutPickerContent`'s
  // secondary `<KeyboardPane>`) has its OWN click handler
  // (`handlePickerKeyClick`), entirely separate from `TabbedKeycodes`'
  // `onKeycodeSelect`/`onKeycodeMultiSelect` gated below — gating those
  // alone left this surface fully live during the simulation tab (it can
  // paste into whatever `selectedKey`/`selectedEncoder` the shared state
  // holds, or start a picker multi-select, regardless of what's selected
  // on THIS surface). Same `packTabReadOnly` gate as every other edit path.
  const { layoutPickerContent } = useLayoutPicker({
    layout, layers, layerNames, keymap, effectiveLayoutOptions, remapLabel,
    scale: scaleProp, onScaleChange,
    devices, connectedDevice, onDeviceListActiveChange,
    selectedKey, selectedEncoder,
    handleKeycodeSelect: packTabReadOnly ? undefined : handleKeycodeSelect,
    handlePickerMultiSelect: packTabReadOnly ? undefined : handlePickerMultiSelect,
    pickerSelectedIndices, clearPickerSelection: multiSelect.clearPickerSelection,
    buildKeycodesForLayer, buildEncoderKeycodesForLayer,
  })

  // --- Tab footer ---
  const tabFooterContent = useKeymapTabFooter({
    tapDanceEntries, comboEntries, keyOverrideEntries, altRepeatKeyEntries, deserializedMacros,
    tapHoldSupported, mouseKeysSupported, magicSupported, graveEscapeSupported, autoShiftSupported, oneShotKeysSupported, comboSettingsSupported,
    onOpenLighting, openSettings, tdJson, comboJson, koJson, arkJson, macroJson,
  })

  const tabContentOverride = useTileContentOverride({
    tapDanceEntries,
    deserializedMacros,
    // Same simulation-tab read-only gate as the picker's own
    // onKeycodeSelect below — the "configured" tile overlay is another
    // click-driven edit entry point into the shared selection state.
    // `useTileContentOverride`'s own `onSelect` is optional, so `undefined`
    // is enough (it falls back to its own internal no-op).
    onSelect: packTabReadOnly ? undefined : gatedHandleKeycodeSelect,
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
        {/* Single container for the active keymap surface (TypingTestPane OR
            KeyboardPane — only one renders at a time). `remap-simulated`
            (style.css) overrides `--key-label-remap` for every descendant
            KeyWidget/EncoderWidget, so a permutation pack's Display Only
            tint is a pure CSS cascade override rather than a `remapKind`
            prop threaded through KeyboardPane/TypingTestPane/KeyboardWidget/
            KeyWidget/EncoderWidget. The key picker and popover render as
            siblings further down (or in the sibling `TabbedKeycodes` block),
            never inside this container, so their "actual" tint is
            unaffected — see `useDevicePrefs.ts`'s `remapKind` doc comment
            for the simulated/actual decision itself. */}
        <div
          data-testid="keymap-surface"
          className={`${typingTestMode
            ? 'flex min-h-0 min-w-0 flex-1 flex-col gap-3'
            // View Matrix mode stacks the keymap above its relocated zoom
            // row (sketch: "keymap" over "zoom controls" in the right
            // column); normal mode keeps the single-child centered row.
            : viewMatrixMode.active ? 'flex min-w-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto' : 'flex min-w-0 flex-1 items-center justify-center gap-4 overflow-auto'
          }${remapKind === 'simulated' && (!showPackTabs || packTab === 'pack') ? ' remap-simulated' : ''}`}
        >
          {typingTestMode ? (
            // Forwards the full `props` object; only the values genuinely
            // computed HERE at render time are listed explicitly (see
            // `KeymapTypingTestPane` for which fields are plain
            // `KeymapEditorProps` pass-throughs). `layoutOptions`, `scale`,
            // and `typingTestSaveUnnamed` all override the raw spread value
            // with the already-effective/defaulted local instead.
            <KeymapTypingTestPane
              {...props}
              typingTest={typingTest}
              onConfigChange={handleTypingTestConfigChange}
              onLanguageChange={handleTypingTestLanguageChange}
              pressedKeys={pressedKeys}
              keycodes={typingTestKeycodes}
              encoderKeycodes={typingTestEncoderKeycodes}
              remappedKeys={typingTestRemapped}
              remappedEncoders={typingTestEncoderRemapped}
              layoutOptions={effectiveLayoutOptions}
              scale={scaleProp}
              typingTestSaveUnnamed={typingTestSaveUnnamed}
              keys={layout.keys}
              layerLabel={layerLabel(typingTest.effectiveLayer)}
              contentRef={keyboardContentRef}
              hasSavedMemory={!!savedTypingTestMemory}
              finishedResult={finishedResult}
              onNameFinishedResult={nameFinishedResult}
              onPauseTest={pauseTypingTest}
              onResumeTest={resumeTypingTest}
              onRestartTestFromStart={restartTypingTestFromStart}
            />
          ) : (
            <>
              {/* Simulation/Base tabs (Plan-qwerty-select-no-rewrite v7):
                  the vertical tab strip sits to the RIGHT of the keymap
                  pane, attached flush to its edge (index/sticky-note style
                  — see `KeymapPackTabs`). The wrapping `flex items-stretch`
                  div (in `KeymapPrimaryPane`) with no gap is what keeps the
                  strip touching the pane regardless of this row's own
                  `gap-4` (which only spaces this pane+tabs unit from its
                  own siblings, e.g. the overlay-panel spacer). View Matrix
                  mode is excluded from `showPackTabs` above, so it can
                  never overlap with either tab. */}
              <KeymapPrimaryPane
                showPackTabs={showPackTabs} packTab={packTab}
                keys={layout.keys} layerKeycodes={layerKeycodes} layerEncoderKeycodes={layerEncoderKeycodes}
                remappedKeys={remappedKeys} layerEncoderRemapped={layerEncoderRemapped}
                matrixMode={matrixMode} pressedKeys={pressedKeys} everPressedKeys={everPressedKeys}
                layoutOptions={effectiveLayoutOptions} scale={scaleProp} remapLabel={remapLabel}
                currentLayerLabel={layerLabel(currentLayer)}
                onRequestKeymapApply={onRequestKeymapApply} keymapApplyBusy={keymapApplyBusy} keymapApplyError={keymapApplyError}
                contentRef={keyboardContentRef}
                primaryKeycodes={primaryKeycodes} primaryEncoderKeycodes={primaryEncoderKeycodes}
                selectedKey={selectedKey} selectedEncoder={selectedEncoder} selectedMaskPart={selectedMaskPart} selectedKeycode={selectedKeycode}
                primaryRemappedKeys={primaryRemappedKeys} primaryRemappedEncoders={primaryRemappedEncoders}
                flash={flash} viewMatrixMode={viewMatrixMode} multiSelectedKeys={multiSelectedKeys}
                viewMatrixLabelOverrides={viewMatrixLabelOverrides} viewMatrixDuplicateKeyColors={viewMatrixDuplicateKeyColors}
                primaryRemapLabel={primaryRemapLabel}
                handleViewMatrixKeyClick={handleViewMatrixKeyClick} handleKeyClick={handleKeyClick}
                handleKeyDoubleClick={handleKeyDoubleClick} handleEncoderClick={handleEncoderClick} handleEncoderDoubleClick={handleEncoderDoubleClick}
                handleDeselect={handleDeselect} handlePackTabChange={handlePackTabChange} keymapPackName={keymapPackName}
              />
              {/* The relocated zoom row the toolbar comment above points to
                  — see `ViewMatrixZoomRow` for what it contains and why. */}
              {viewMatrixMode.active && (
                <ViewMatrixZoomRow scale={scaleProp} onScaleChange={onScaleChange} />
              )}
            </>
          )}
        </div>
        {!typingTestMode && <div style={{ width: PANEL_COLLAPSED_WIDTH }} className="shrink-0" />}
      </div>

      {!typingTestMode && popoverState && (
        <PopoverForState
          key={popoverInstanceKey(popoverState)}
          popoverState={popoverState} keymap={keymap} encoderLayout={encoderLayout}
          currentLayer={currentLayer} layers={layers}
          onLayerChange={onLayerChange} layerNames={layerNames}
          onKeycodeSelect={handlePopoverKeycodeSelect} onRawKeycodeSelect={handlePopoverRawKeycodeSelect}
          onModMaskChange={handlePopoverModMaskChange}
          onClose={closePopover} quickSelect={quickSelect}
          previousKeycode={popoverUndoKeycode} onUndo={handlePopoverUndo}
          nextKeycode={popoverRedoKeycode} onRedo={handlePopoverRedo}
          remapLabel={pickerRemapLabel}
        />
      )}

      {/* The entire keycode picker area — tabs, tiles, and the overlay panel
          (incl. its own View Matrix Edit/Done button) — is hidden while
          View Matrix mode is active; ViewMatrixPanel above is the mode's
          only surface, and its own toggle is the sole way back to normal
          editing. Rendered as a SIBLING of `keymap-surface` above, never
          inside it — see `KeymapPickerRegion`. */}
      {!typingTestMode && !viewMatrixMode.active && (
        <KeymapPickerRegion
          {...props}
          layerPanelCollapsed={layerPanelCollapsed} toggleLayerPanel={toggleLayerPanel}
          layoutPickerContent={layoutPickerContent} packTabReadOnly={packTabReadOnly}
          gatedHandleKeycodeSelect={gatedHandleKeycodeSelect} handlePickerMultiSelect={handlePickerMultiSelect}
          pickerSelectedIndices={pickerSelectedIndices} selectedKey={selectedKey} selectedEncoder={selectedEncoder}
          handleDeselect={handleDeselect} clearPickerSelection={multiSelect.clearPickerSelection}
          configuredKeycodes={configuredKeycodes} isMaskKey={isMaskKey} isLMMask={isLMMask}
          tabFooterContent={tabFooterContent} tabContentOverride={tabContentOverride}
          layoutButtonRef={layoutButtonRef} layoutPanelOpen={layoutPanelOpen} setLayoutPanelOpen={setLayoutPanelOpen}
          layoutPanelRef={layoutPanelRef}
          hasLayoutOptions={hasLayoutOptions} parsedLayoutOptions={parsedOptions} layoutValues={layoutValues}
          handleLayoutOptionChange={handleLayoutOptionChange} autoAdvance={autoAdvance}
          viewMatrixActive={viewMatrixMode.active} onToggleViewMatrixMode={handleToggleViewMatrixMode}
          matrixMode={matrixMode} hasMatrixTester={hasMatrixTester} handleMatrixToggle={handleMatrixToggle}
        />
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
        keymapApplyOpen={keymapApplyOpen} keymapApplyLabelName={keymapApplyLabelName} keymapApplyBusy={keymapApplyBusy}
        onKeymapApplyConfirm={onKeymapApplyConfirm} onKeymapApplyCancel={onKeymapApplyCancel}
      />
    </div>
  )
})
