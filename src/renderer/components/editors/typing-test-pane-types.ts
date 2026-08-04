// SPDX-License-Identifier: GPL-2.0-or-later

import type { RefObject } from 'react'
import type { TypingTestResult, TypingTestComparisonBaseline, TypingTestComparisonBaselines } from '../../../shared/types/pipette-settings'
import type { RunKeystrokeLog } from '../../../shared/types/typing-run-log'
import type { TypingTestConfig } from '../../typing-test/types'
import type { KleKey } from '../../../shared/kle/types'
import type { useTypingTest } from '../../typing-test/useTypingTest'
import type { LineSnapshot } from '../../typing-test/TypingTestView'
import type { TimelineHandoff } from '../../hooks/useRunTimelineHandoff'

export interface TypingTestPaneProps {
  typingTest: ReturnType<typeof useTypingTest>
  onConfigChange: (config: TypingTestConfig) => void
  /** Last normal (words/time/quote) config, restored when leaving fileImport. */
  monkeytypeConfig?: TypingTestConfig
  onLanguageChange: (lang: string) => Promise<void>
  layers: number
  layerNames?: string[]
  typingTestHistory?: TypingTestResult[]
  deviceName?: string
  pressedKeys: Set<string>
  keycodes: Map<string, string>
  encoderKeycodes: Map<string, [string, string]>
  remappedKeys: Set<string>
  /** Encoder analogue of `remappedKeys` — see `KeyboardWidget`'s
   *  `remappedEncoders`. */
  remappedEncoders?: Set<string>
  /** Active Key Label pack's per-key legend override — see
   *  `KeyboardWidget`'s `remapLabel`. */
  remapLabel?: (qmkId: string) => string
  layoutOptions: Map<number, number>
  scale: number
  keys: KleKey[]
  layerLabel: string
  contentRef?: React.RefObject<HTMLDivElement | null>
  /** Memory mode (imported fileImport text): a paused snapshot is saved. */
  hasSavedMemory?: boolean
  onPauseTest?: () => void
  onResumeTest?: () => void
  onRestartTestFromStart?: () => void
  /** Imported-text display preferences (fileImport mode). */
  displayLines?: number
  fontSize?: number
  onDisplayLinesChange?: (lines: number) => void
  onFontSizeChange?: (px: number) => void
  /** Editor view toggles — hide the keymap pane / the stats (WPM) row.
   *  Persisted per keyboard; only meaningful outside view-only mode. */
  hideKeymap?: boolean
  hideStatsRow?: boolean
  hideControls?: boolean
  onToggleHideKeymap?: (hidden: boolean) => void
  onToggleHideStatsRow?: (hidden: boolean) => void
  onToggleHideControls?: (hidden: boolean) => void
  /** Auto-save finished results without a name (default true). Drives only the
   *  toggle button — the save/name behavior lives in `useInputModes`. */
  saveUnnamed?: boolean
  onToggleSaveUnnamed?: (enabled: boolean) => void
  /** The just-finished result (held unsaved or saved latest), for name chips. */
  finishedResult?: TypingTestResult | null
  /** Name the just-finished result (save under name when held, else rename). */
  onNameFinishedResult?: (name: string) => void
  /** The just-finished run's in-memory raw keystroke log — forwarded to
   *  `TypingTestView` so the completion screen can render the shared
   *  `KeystrokeTimelinePanel` inline, no IPC round-trip needed
   *  (Plan-completion-timeline-view PR-B). See `useTypingTestResultSave`'s
   *  own doc comment on `lastFinishedLog`. */
  lastFinishedLog?: RunKeystrokeLog | null
  /** Per-condition Measurement-row comparison baselines (persisted per
   *  keyboard, synced). Keyed by condition; the current condition's baseline
   *  is looked up and applied. */
  comparisonBaselines?: TypingTestComparisonBaselines
  onComparisonBaselineChange?: (conditionKey: string, baseline: TypingTestComparisonBaseline) => void
  /** Left Settings panel expanded state (persisted per keyboard). */
  settingsPanelOpen?: boolean
  onToggleSettingsPanel?: (open: boolean) => void
  /** Label a saved result (by ISO date) from the History modal. */
  onRenameTypingTestResult?: (date: string, name: string) => void
  /** Delete a saved result (by ISO date) from the History modal. */
  onDeleteTypingTestResult?: (date: string) => void
  viewOnly?: boolean
  onViewOnlyChange?: (enabled: boolean) => void
  viewOnlyWindowSize?: { width: number; height: number }
  onViewOnlyWindowSizeChange?: (size: { width: number; height: number }) => void
  viewOnlyAlwaysOnTop?: boolean
  onViewOnlyAlwaysOnTopChange?: (enabled: boolean) => void
  /** REC toggle state — drives the heatmap overlay (enabled only in
   *  view-only + recording) and the panel's hint text. The toggle
   *  itself lives in the footer's Record button/modal, not here. */
  recordEnabled?: boolean
  /** Window length in minutes for the typing-view heatmap overlay and
   * its legend text; data older than the window is dropped, data
   * within decays smoothly. Backed by AppConfig.typingHeatmapWindowMin
   * — edited from the footer's TypingRecordModal, read-only here. */
  heatmapWindowMin?: number
  /** Keyboard uid used for the typing-view heatmap query. The heatmap
   * stays hidden while this is unset or recording is off so a session
   * without a device never sees stale overlay data. */
  keyboardUid?: string
  /** Analyze -> Typing Test "open timeline" handoff (consume-once):
   * forwarded straight to HistoryToggle, which auto-opens History and
   * this run's keystroke timeline for it. */
  timelineHandoff?: TimelineHandoff | null
  /** Forwarded to `TypingTestView` — see `LineSnapshot`'s own doc comment
   *  and `useTypingTestResultSave`'s consumption of it at finish time
   *  (Plan-line-keystroke-timeline PR1). Owned by `KeymapEditor` (the
   *  lowest common ancestor of this view and `useInputModes`), not this
   *  pane. */
  lineSnapshotRef?: RefObject<LineSnapshot | null>
}
