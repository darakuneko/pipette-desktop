// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { TypingTestView } from '../../typing-test/TypingTestView'
import { buildResultNameChips } from '../../typing-test/result-builder'
import { PauseResumeModal } from '../../typing-test/PauseResumeModal'
import { TypingRecordingConsentModal } from '../../typing-test/TypingRecordingConsentModal'
import { errorClassGroup } from '../../typing-test/error-classify'
import { useTypingHeatmap } from '../../typing-test/useTypingHeatmap'
import { KeyboardPane } from './KeyboardPane'
import { useTypingTestPaneWindow } from './use-typing-test-pane-window'
import { useTypingTestPaneComparison } from './use-typing-test-pane-comparison'
import { TypingTestPaneViewOnlyMenu } from './TypingTestPaneViewOnlyMenu'
import { TypingTestPaneSettingsPanel } from './TypingTestPaneSettingsPanel'
import type { TypingTestPaneProps } from './typing-test-pane-types'

export type { TypingTestPaneProps } from './typing-test-pane-types'

export function TypingTestPane({
  typingTest,
  onConfigChange,
  monkeytypeConfig,
  onLanguageChange,
  layers,
  layerNames,
  typingTestHistory,
  deviceName,
  pressedKeys,
  keycodes,
  encoderKeycodes,
  remappedKeys,
  remappedEncoders,
  remapLabel,
  layoutOptions,
  scale,
  keys,
  layerLabel,
  contentRef,
  hasSavedMemory,
  onPauseTest,
  onResumeTest,
  onRestartTestFromStart,
  displayLines,
  fontSize,
  onDisplayLinesChange,
  onFontSizeChange,
  hideKeymap,
  hideStatsRow,
  hideControls,
  onToggleHideKeymap,
  onToggleHideStatsRow,
  onToggleHideControls,
  saveUnnamed = true,
  onToggleSaveUnnamed,
  finishedResult,
  onNameFinishedResult,
  comparisonBaselines,
  onComparisonBaselineChange,
  settingsPanelOpen = true,
  onToggleSettingsPanel,
  onRenameTypingTestResult,
  onDeleteTypingTestResult,
  viewOnly,
  onViewOnlyChange,
  viewOnlyWindowSize,
  onViewOnlyWindowSizeChange,
  viewOnlyAlwaysOnTop,
  onViewOnlyAlwaysOnTopChange,
  recordEnabled,
  onRecordEnabledChange,
  recordingConsentAccepted,
  onRecordingConsentAccepted,
  heatmapWindowMin,
  onHeatmapWindowMinChange,
  monitorAppEnabled,
  onMonitorAppEnabledChange,
  trayResident,
  onTrayResidentChange,
  startInTray,
  onStartInTrayChange,
  menuTab = 'window',
  onMenuTabChange,
  onViewAnalytics,
  keyboardUid,
  timelineHandoff,
}: TypingTestPaneProps) {
  const { t } = useTranslation()

  // Heatmap overlay for view-only + record mode. Gated on both flags
  // so the overlay never shows up in editor mode and never lingers
  // after the user toggles record off.
  const {
    cells: heatmapCells,
    maxTotal: heatmapMaxTotal,
    maxTap: heatmapMaxTap,
    maxHold: heatmapMaxHold,
  } = useTypingHeatmap({
    uid: keyboardUid ?? null,
    layer: typingTest.effectiveLayer,
    enabled: !!viewOnly && !!recordEnabled,
    windowMs: (heatmapWindowMin ?? 5) * 60 * 1_000,
  })
  const heatmapActive = heatmapMaxTotal > 0
  const [showLanguageModal, setShowLanguageModal] = useState(false)
  const [showConsentModal, setShowConsentModal] = useState(false)
  const [showResumeModal, setShowResumeModal] = useState(false)

  const {
    comparison,
    sameConditionResults,
    comparisonBaselineValue,
    handleComparisonChange,
  } = useTypingTestPaneComparison({
    typingTest,
    typingTestHistory,
    comparisonBaselines,
    onComparisonBaselineChange,
  })

  const {
    viewOnlyControlsOpen,
    setViewOnlyControlsOpen,
    mouseOver,
    alwaysOnTopSupported,
    controlsBarRef,
    paneWrapperRef,
    paneNaturalSizeRef,
    cssScale,
    getDefaultCompactSize,
    handleViewOnlyToggle,
  } = useTypingTestPaneWindow({
    typingTest,
    viewOnly,
    keys,
    layoutOptions,
    viewOnlyWindowSize,
    onViewOnlyWindowSizeChange,
    viewOnlyAlwaysOnTop,
    onViewOnlyChange,
  })

  const handleRecordToggle = useCallback(() => {
    if (!onRecordEnabledChange) return
    // Stopping is always allowed without re-prompting; only the
    // first transition from "off → on" needs the disclosure.
    if (recordEnabled) {
      onRecordEnabledChange(false)
      return
    }
    if (!recordingConsentAccepted) {
      // Hide the REC overlay so the modal isn't visually overlapped
      // by the popover; the cancel/accept handlers reopen it so the
      // user lands back where they started.
      setViewOnlyControlsOpen(false)
      setShowConsentModal(true)
      return
    }
    onRecordEnabledChange(true)
  }, [onRecordEnabledChange, recordEnabled, recordingConsentAccepted])

  const handleTrayResidentToggle = useCallback(() => {
    if (!onTrayResidentChange) return
    const next = !trayResident
    onTrayResidentChange(next)
    // Mirrors SettingsToolsTab: a hidden window with no tray icon to
    // reopen it would be unreachable, so turning tray residency off
    // also clears startInTray when it was on.
    if (!next && startInTray) {
      onStartInTrayChange?.(false)
    }
  }, [onTrayResidentChange, trayResident, startInTray, onStartInTrayChange])

  const handleConsentAccept = useCallback(() => {
    onRecordingConsentAccepted?.()
    setShowConsentModal(false)
    setViewOnlyControlsOpen(true)
    onRecordEnabledChange?.(true)
  }, [onRecordingConsentAccepted, onRecordEnabledChange])

  const handleConsentCancel = useCallback(() => {
    setShowConsentModal(false)
    setViewOnlyControlsOpen(true)
  }, [])

  return (
    <>
      {showConsentModal && (
        <TypingRecordingConsentModal
          onAccept={handleConsentAccept}
          onCancel={handleConsentCancel}
        />
      )}
      {showResumeModal && (
        <PauseResumeModal
          wordIndex={typingTest.state.currentWordIndex}
          totalWords={typingTest.state.words.length}
          onResume={() => { setShowResumeModal(false); onResumeTest?.() }}
          onRestart={() => { setShowResumeModal(false); onRestartTestFromStart?.() }}
          onCancel={() => setShowResumeModal(false)}
        />
      )}
      {/* Editor: config sidebar pinned top-left, reading window + keymap
          centred in the remaining space. View-only collapses the wrappers
          (`contents`) so its scaled-pane layout is untouched. */}
      <div className={viewOnly ? 'contents' : 'flex min-h-0 w-full flex-1 items-stretch gap-2'}>
      {!viewOnly && (
        <TypingTestPaneSettingsPanel
          typingTest={typingTest}
          showLanguageModal={showLanguageModal}
          onShowLanguageModal={setShowLanguageModal}
          onConfigChange={onConfigChange}
          monkeytypeConfig={monkeytypeConfig}
          onLanguageChange={onLanguageChange}
          layers={layers}
          layerNames={layerNames}
          typingTestHistory={typingTestHistory}
          deviceName={deviceName}
          displayLines={displayLines}
          fontSize={fontSize}
          onDisplayLinesChange={onDisplayLinesChange}
          onFontSizeChange={onFontSizeChange}
          hideKeymap={hideKeymap}
          hideStatsRow={hideStatsRow}
          hideControls={hideControls}
          onToggleHideKeymap={onToggleHideKeymap}
          onToggleHideStatsRow={onToggleHideStatsRow}
          onToggleHideControls={onToggleHideControls}
          saveUnnamed={saveUnnamed}
          onToggleSaveUnnamed={onToggleSaveUnnamed}
          settingsPanelOpen={settingsPanelOpen}
          onToggleSettingsPanel={onToggleSettingsPanel}
          onRenameTypingTestResult={onRenameTypingTestResult}
          onDeleteTypingTestResult={onDeleteTypingTestResult}
          keyboardUid={keyboardUid}
          timelineHandoff={timelineHandoff}
          sameConditionResults={sameConditionResults}
          comparisonBaselineValue={comparisonBaselineValue}
          handleComparisonChange={handleComparisonChange}
        />
      )}
      <div className={viewOnly ? 'contents' : 'flex min-w-0 flex-1 flex-col items-center'}>
      {!viewOnly && (
        <TypingTestView
          hideStatsRow={hideStatsRow}
          hideControls={hideControls}
          comparison={comparison}
          state={typingTest.state}
          wpm={typingTest.wpm}
          kpm={typingTest.kpm}
          accuracy={typingTest.accuracy}
          kspc={typingTest.kspc}
          elapsedSeconds={typingTest.elapsedSeconds}
          remainingSeconds={typingTest.remainingSeconds}
          config={typingTest.config}
          paused={typingTest.state.status === 'running' && !typingTest.windowFocused}
          onCompositionStart={typingTest.processCompositionStart}
          onCompositionUpdate={typingTest.processCompositionUpdate}
          onCompositionEnd={typingTest.processCompositionEnd}
          romajiGuide={typingTest.romajiGuide}
          onImeSpaceKey={() => typingTest.processKeyEvent(' ', false, false, false)}
          displayLines={displayLines}
          fontSize={fontSize}
          onNameResult={onNameFinishedResult}
          // Chips come from the just-finished result (held unsaved or saved).
          resultNameChips={finishedResult ? buildResultNameChips(finishedResult, t, deviceName) : []}
          // Error-class raw counts — null for a romaji run, a run with no
          // finalized words, or a legacy result, in which case the finish
          // screen omits the line (see errorClassGroup's all-or-nothing read).
          errorClasses={finishedResult ? errorClassGroup(finishedResult) : null}
          onStart={() => typingTest.restart()}
          onPause={() => onPauseTest?.()}
          onResume={() => setShowResumeModal(true)}
          hasSavedMemory={hasSavedMemory}
        />
      )}
      <div
        className={viewOnly ? 'flex min-h-0 w-full flex-1 cursor-pointer items-center justify-center overflow-hidden' : 'flex items-start justify-center overflow-auto'}
        onClick={viewOnly ? () => setViewOnlyControlsOpen((v) => !v) : undefined}
      >
        <div className={viewOnly ? 'relative' : 'relative w-full'} style={viewOnly && paneNaturalSizeRef.current.w > 0 ? { width: paneNaturalSizeRef.current.w * cssScale, height: paneNaturalSizeRef.current.h * cssScale, overflow: 'hidden' } : undefined}>
          {viewOnly && <div className="absolute inset-0 z-10" />}
          <div
            ref={viewOnly ? paneWrapperRef : undefined}
            className={viewOnly ? undefined : 'w-full'}
            style={viewOnly ? { transform: `scale(${cssScale})`, transformOrigin: 'top left' } : undefined}
          >
          {/* Editor: centre the keymap in the right pane. View-only must NOT
              add justify-center — natural-size measurement happens at width 0,
              where centring pushes content half-off and halves scrollWidth. */}
          <div className={`flex w-full items-start${viewOnly ? '' : ' justify-center'}`}>
          <div className="shrink-0">
          <div className="w-fit">
          {/* Keymap hidden only in the editor view — view-only mode is
              keyboard-focused, so the toggle never applies there. */}
          {!(hideKeymap && !viewOnly) && (
            <KeyboardPane
              paneId="primary"
              isActive={false}
              keys={keys}
              keycodes={keycodes}
              encoderKeycodes={encoderKeycodes}
              selectedKey={null}
              selectedEncoder={null}
              selectedMaskPart={false}
              selectedKeycode={null}
              pressedKeys={pressedKeys}
              everPressedKeys={undefined}
              remappedKeys={remappedKeys}
              remappedEncoders={remappedEncoders}
              remapLabel={remapLabel}
              layoutOptions={layoutOptions}
              heatmapCells={heatmapCells}
              heatmapMaxTotal={heatmapMaxTotal}
              heatmapMaxTap={heatmapMaxTap}
              heatmapMaxHold={heatmapMaxHold}
              scale={viewOnly ? 1 : scale}
              layerLabel={layerLabel}
              layerLabelTestId="layer-label"
              contentRef={contentRef}
            />
          )}
          </div>
          </div>
          </div>
          {heatmapActive && (
            <p
              data-testid="typing-test-heatmap-legend"
              className="mt-1 text-center text-xs text-content-muted"
            >
              {t('editor.typingTest.heatmap.legend', { minutes: heatmapWindowMin ?? 5 })}
            </p>
          )}
          {/* Layer-tracking note describes the keymap, so hide it with the keymap. */}
          {!viewOnly && !hideKeymap && (
            <p data-testid="typing-test-layer-note" className="text-center text-xs text-content-muted">
              {t('editor.typingTest.layerNote')}
            </p>
          )}
        </div>
        </div>
      </div>
      </div>
      </div>
      {viewOnly && (
        <TypingTestPaneViewOnlyMenu
          typingTest={typingTest}
          mouseOver={mouseOver}
          viewOnlyControlsOpen={viewOnlyControlsOpen}
          setViewOnlyControlsOpen={setViewOnlyControlsOpen}
          controlsBarRef={controlsBarRef}
          menuTab={menuTab}
          onMenuTabChange={onMenuTabChange}
          getDefaultCompactSize={getDefaultCompactSize}
          onViewOnlyWindowSizeChange={onViewOnlyWindowSizeChange}
          alwaysOnTopSupported={alwaysOnTopSupported}
          viewOnlyAlwaysOnTop={viewOnlyAlwaysOnTop}
          onViewOnlyAlwaysOnTopChange={onViewOnlyAlwaysOnTopChange}
          recordEnabled={recordEnabled}
          onRecordEnabledChange={onRecordEnabledChange}
          handleRecordToggle={handleRecordToggle}
          monitorAppEnabled={monitorAppEnabled}
          onMonitorAppEnabledChange={onMonitorAppEnabledChange}
          trayResident={trayResident}
          onTrayResidentChange={onTrayResidentChange}
          handleTrayResidentToggle={handleTrayResidentToggle}
          startInTray={startInTray}
          onStartInTrayChange={onStartInTrayChange}
          onViewAnalytics={onViewAnalytics}
          heatmapWindowMin={heatmapWindowMin}
          onHeatmapWindowMinChange={onHeatmapWindowMinChange}
          layers={layers}
          layerNames={layerNames}
          onViewOnlyChange={onViewOnlyChange}
          handleViewOnlyToggle={handleViewOnlyToggle}
        />
      )}
    </>
  )
}
