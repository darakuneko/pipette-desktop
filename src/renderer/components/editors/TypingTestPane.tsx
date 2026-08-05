// SPDX-License-Identifier: GPL-2.0-or-later

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TypingTestView } from '../../typing-test/TypingTestView'
import { TypingTestControlsRow } from '../../typing-test/TypingTestControlsRow'
import { buildResultNameChips } from '../../typing-test/result-builder'
import { PauseResumeModal } from '../../typing-test/PauseResumeModal'
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
  lastFinishedLog,
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
  heatmapWindowMin,
  onViewAnalytics,
  keyboardUid,
  timelineHandoff,
  lineSnapshotRef,
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

  // Completion screen (Plan-completion-timeline-view PR-B): the keymap
  // pane + its layer-tracking note describe the KEYMAP, which is no
  // longer the point once a run finishes and the reading window gives
  // way to the inline keystroke timeline (see TypingTestView) — hidden
  // alongside it. Editor-only: view-only's own keyboard display is
  // deliberately independent of both `hideKeymap` and this (see the
  // existing "Keymap hidden only in the editor view" comment below), so
  // a view-only run reaching 'finished' keeps showing its keyboard.
  const hideKeyboardForFinish = !viewOnly && typingTest.state.status === 'finished'

  return (
    <>
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
      {/* `min-h-0` (added alongside the pre-existing `flex-1`) is part of
          the completion screen's flex-height chain — see
          TypingTestView.tsx's own "Completion screen" comment for the
          full chain this is one link of. Without it, this flex item
          defaults to `min-height: auto` (its own content's natural
          height), which can grow past what its parent (KeymapEditor's
          `overflow-auto` content pane, several levels up) actually has
          available, instead of correctly deferring to it. */}
      <div className={viewOnly ? 'contents' : 'flex min-h-0 min-w-0 flex-1 flex-col items-center'}>
      {!viewOnly && (
        <TypingTestView
          hideStatsRow={hideStatsRow}
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
          kanaGuide={typingTest.kanaGuide}
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
          lineSnapshotRef={lineSnapshotRef}
          lastFinishedLog={lastFinishedLog}
          finishedResult={finishedResult}
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
              keyboard-focused, so the toggle never applies there. Same
              editor-only carve-out for the finished-state hide (see
              `hideKeyboardForFinish`'s own doc comment above). */}
          {!(hideKeymap && !viewOnly) && !hideKeyboardForFinish && (
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
          {/* Layer-tracking note describes the keymap, so hide it with the
              keymap — and, like the keymap itself, with the finished
              completion screen. */}
          {!viewOnly && !hideKeymap && !hideKeyboardForFinish && (
            <p data-testid="typing-test-layer-note" className="text-center text-xs text-content-muted">
              {t('editor.typingTest.layerNote')}
            </p>
          )}
        </div>
        </div>
      </div>
      {/* Non-finished controls row (Next Test / Pause / Resume / Restart) —
          moved here, BELOW the keyboard pane and its layer note, so the
          reading window sits directly above the keyboard the user is
          actually typing on. The finished-state row is unaffected — it
          still renders inside TypingTestView, at the very bottom of the
          completion screen (below the timeline panel), since the keyboard
          itself is hidden once finished (hideKeyboardForFinish). Gated the
          same way the old in-TypingTestView row was: !viewOnly (view-only
          never showed this row) and !hideControls (the "operation"
          toggle), plus the finished check TypingTestView itself no longer
          needs to make since this row never renders for it. */}
      {!viewOnly && typingTest.state.status !== 'finished' && !hideControls && (
        <div className="mt-2 flex w-full justify-center">
          <TypingTestControlsRow
            state={typingTest.state}
            config={typingTest.config}
            onStart={() => typingTest.restart()}
            onPause={() => onPauseTest?.()}
            onResume={() => setShowResumeModal(true)}
            hasSavedMemory={hasSavedMemory}
          />
        </div>
      )}
      </div>
      </div>
      {viewOnly && (
        <TypingTestPaneViewOnlyMenu
          typingTest={typingTest}
          mouseOver={mouseOver}
          viewOnlyControlsOpen={viewOnlyControlsOpen}
          setViewOnlyControlsOpen={setViewOnlyControlsOpen}
          getDefaultCompactSize={getDefaultCompactSize}
          onViewOnlyWindowSizeChange={onViewOnlyWindowSizeChange}
          alwaysOnTopSupported={alwaysOnTopSupported}
          viewOnlyAlwaysOnTop={viewOnlyAlwaysOnTop}
          onViewOnlyAlwaysOnTopChange={onViewOnlyAlwaysOnTopChange}
          recordEnabled={recordEnabled}
          layers={layers}
          layerNames={layerNames}
          onViewAnalytics={onViewAnalytics}
          onViewOnlyChange={onViewOnlyChange}
          handleViewOnlyToggle={handleViewOnlyToggle}
        />
      )}
    </>
  )
}
