// SPDX-License-Identifier: GPL-2.0-or-later

import type { RefObject } from 'react'
import { TypingTestPane } from './TypingTestPane'
import type { KeymapEditorProps } from './keymap-editor-types'
import type { KleKey } from '../../../shared/kle/types'
import type { TypingTestConfig } from '../../typing-test/types'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
import type { RunKeystrokeLog } from '../../../shared/types/typing-run-log'
import type { useTypingTest } from '../../typing-test/useTypingTest'
import type { LineSnapshot } from '../../typing-test/TypingTestView'

/** `KeymapEditorProps` covers every plain pass-through field below (layers,
 *  layerNames, typingTestHistory, every "typingTest"/"onTypingTest"-prefixed
 *  setting, ...); these additions are the values `KeymapEditor` only has at
 *  render time — the running test's own state, this layer's keycodes/keys,
 *  and the shared refs/callbacks the surrounding editor owns. */
export interface KeymapTypingTestPaneProps extends KeymapEditorProps {
  typingTest: ReturnType<typeof useTypingTest>
  onConfigChange: (config: TypingTestConfig) => void
  onLanguageChange: (lang: string) => Promise<void>
  pressedKeys: Set<string>
  keycodes: Map<string, string>
  encoderKeycodes: Map<string, [string, string]>
  remappedKeys: Set<string>
  remappedEncoders?: Set<string>
  /** Overrides `KeymapEditorProps.scale` (optional there) — `KeymapEditor`
   *  always passes its own already-defaulted `scaleProp` local here, so
   *  this pane can rely on a definite number, same as `TypingTestPane`'s
   *  own required `scale`. */
  scale: number
  keys: KleKey[]
  layerLabel: string
  contentRef?: RefObject<HTMLDivElement | null>
  hasSavedMemory?: boolean
  finishedResult?: TypingTestResult | null
  onNameFinishedResult?: (name: string) => void
  /** The just-finished run's in-memory raw keystroke log — forwarded to
   *  `TypingTestPane`/`TypingTestView` so the completion screen can render
   *  the shared `KeystrokeTimelinePanel` inline, no IPC round-trip needed
   *  (Plan-completion-timeline-view PR-B). See `useTypingTestResultSave`'s
   *  own doc comment on `lastFinishedLog`. */
  lastFinishedLog?: RunKeystrokeLog | null
  onPauseTest?: () => void
  onResumeTest?: () => void
  onRestartTestFromStart?: () => void
  /** Owned by `KeymapEditor` (lowest common ancestor of this pane and
   *  `useInputModes`) — see `LineSnapshot`'s own doc comment. */
  lineSnapshotRef?: RefObject<LineSnapshot | null>
}

/** Renders the typing-test surface inside `KeymapEditor`'s keymap-surface
 *  container. Pure translation layer: every field here is either forwarded
 *  unchanged or renamed onto `TypingTestPane`'s own (differently-named)
 *  props — `viewOnly` vs. `typingTestViewOnly`, `hideKeymap` vs.
 *  `typingTestHideKeymap`, and so on for nearly every "typingTest"/
 *  "onTypingTest"-prefixed field. Imports the REAL `./TypingTestPane` module (not a
 *  re-export) so `KeymapEditor.typingTestNote.test.tsx` (which doesn't mock
 *  it) still renders the genuine component, and `vi.mock('../TypingTestPane',
 *  ...)` in the other KeymapEditor test suites still intercepts the same
 *  resolved module regardless of which file imports it. */
export function KeymapTypingTestPane({
  typingTest, onConfigChange, typingTestMonkeytypeConfig, onLanguageChange,
  layers, layerNames, typingTestHistory, onRenameTypingTestResult, onDeleteTypingTestResult, deviceName,
  pressedKeys, keycodes, encoderKeycodes, remappedKeys, remappedEncoders,
  remapLabel, layoutOptions, scale, keys, layerLabel, contentRef,
  hasSavedMemory, typingTestDisplayLines, typingTestFontSize, onTypingTestDisplayLinesChange, onTypingTestFontSizeChange,
  typingTestHideKeymap, typingTestHideStatsRow, typingTestHideControls, typingTestSaveUnnamed,
  finishedResult, onNameFinishedResult, lastFinishedLog, typingTestComparisonBaselines,
  onTypingTestHideKeymapChange, onTypingTestHideStatsRowChange, onTypingTestHideControlsChange, onTypingTestSaveUnnamedChange, onTypingTestComparisonBaselineChange,
  typingTestSettingsPanelOpen, onTypingTestSettingsPanelOpenChange,
  onPauseTest, onResumeTest, onRestartTestFromStart,
  typingTestViewOnly, onTypingTestViewOnlyChange,
  typingTestViewOnlyWindowSize, onTypingTestViewOnlyWindowSizeChange,
  typingTestViewOnlyAlwaysOnTop, onTypingTestViewOnlyAlwaysOnTopChange,
  typingRecordEnabled,
  typingHeatmapWindowMin,
  onViewAnalytics,
  keyboardUid, timelineHandoff,
  lineSnapshotRef,
}: KeymapTypingTestPaneProps): JSX.Element {
  return (
    <TypingTestPane
      typingTest={typingTest}
      onConfigChange={onConfigChange}
      monkeytypeConfig={typingTestMonkeytypeConfig}
      onLanguageChange={onLanguageChange}
      layers={layers}
      layerNames={layerNames}
      typingTestHistory={typingTestHistory}
      onRenameTypingTestResult={onRenameTypingTestResult}
      onDeleteTypingTestResult={onDeleteTypingTestResult}
      deviceName={deviceName}
      pressedKeys={pressedKeys}
      keycodes={keycodes}
      encoderKeycodes={encoderKeycodes}
      remappedKeys={remappedKeys}
      remappedEncoders={remappedEncoders}
      remapLabel={remapLabel}
      layoutOptions={layoutOptions}
      scale={scale}
      keys={keys}
      layerLabel={layerLabel}
      contentRef={contentRef}
      hasSavedMemory={hasSavedMemory}
      displayLines={typingTestDisplayLines}
      fontSize={typingTestFontSize}
      onDisplayLinesChange={onTypingTestDisplayLinesChange}
      onFontSizeChange={onTypingTestFontSizeChange}
      hideKeymap={typingTestHideKeymap}
      hideStatsRow={typingTestHideStatsRow}
      hideControls={typingTestHideControls}
      saveUnnamed={typingTestSaveUnnamed}
      finishedResult={finishedResult}
      onNameFinishedResult={onNameFinishedResult}
      lastFinishedLog={lastFinishedLog}
      comparisonBaselines={typingTestComparisonBaselines}
      onToggleHideKeymap={onTypingTestHideKeymapChange}
      onToggleHideStatsRow={onTypingTestHideStatsRowChange}
      onToggleHideControls={onTypingTestHideControlsChange}
      onToggleSaveUnnamed={onTypingTestSaveUnnamedChange}
      onComparisonBaselineChange={onTypingTestComparisonBaselineChange}
      settingsPanelOpen={typingTestSettingsPanelOpen}
      onToggleSettingsPanel={onTypingTestSettingsPanelOpenChange}
      onPauseTest={onPauseTest}
      onResumeTest={onResumeTest}
      onRestartTestFromStart={onRestartTestFromStart}
      viewOnly={typingTestViewOnly}
      onViewOnlyChange={onTypingTestViewOnlyChange}
      viewOnlyWindowSize={typingTestViewOnlyWindowSize}
      onViewOnlyWindowSizeChange={onTypingTestViewOnlyWindowSizeChange}
      viewOnlyAlwaysOnTop={typingTestViewOnlyAlwaysOnTop}
      onViewOnlyAlwaysOnTopChange={onTypingTestViewOnlyAlwaysOnTopChange}
      recordEnabled={typingRecordEnabled}
      heatmapWindowMin={typingHeatmapWindowMin}
      onViewAnalytics={onViewAnalytics}
      keyboardUid={keyboardUid}
      timelineHandoff={timelineHandoff}
      lineSnapshotRef={lineSnapshotRef}
    />
  )
}
