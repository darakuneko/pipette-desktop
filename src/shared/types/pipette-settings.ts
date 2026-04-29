// SPDX-License-Identifier: GPL-2.0-or-later

import type { FingerType } from '../kle/kle-ergonomics'
import type { AnalyzeFilterSettings } from './analyze-filters'
import { ALLOWED_TYPING_SYNC_SPAN_DAYS, type TypingSyncSpanDays } from './typing-analytics'

export interface TypingTestResult {
  date: string
  wpm: number
  accuracy: number
  wordCount: number
  correctChars: number
  incorrectChars: number
  durationSeconds: number
  rawWpm?: number
  mode?: 'words' | 'time' | 'quote'
  mode2?: number | string
  language?: string
  punctuation?: boolean
  numbers?: boolean
  consistency?: number
  isPb?: boolean
  wpmHistory?: number[]
}

export const VIEW_MODES = ['editor', 'typingView', 'typingTest'] as const
export type ViewMode = typeof VIEW_MODES[number]

/** Which tab of the typing-view menu is currently open. Persisted so
 * the next entry restores the user's last-chosen pane (Window controls
 * vs. recording + analytics). The Monitor App toggle lives inline in
 * the REC tab — it is not its own pane. */
export const TYPING_VIEW_MENU_TABS = ['window', 'rec'] as const
export type TypingViewMenuTab = typeof TYPING_VIEW_MENU_TABS[number]

export function isTypingViewMenuTab(value: unknown): value is TypingViewMenuTab {
  return typeof value === 'string' && (TYPING_VIEW_MENU_TABS as readonly string[]).includes(value)
}

export function isTypingSyncSpanDays(value: unknown): value is TypingSyncSpanDays {
  return typeof value === 'number' && (ALLOWED_TYPING_SYNC_SPAN_DAYS as readonly number[]).includes(value)
}

/** One entry of the per-keyboard goal change history. Kept in ISO 8601
 * timestamp form so same-day edits can still be ordered (the "keep
 * latest within a day" rule is UI-driven; the store only normalizes
 * and validates shape). `days` / `keystrokes` carry the snapshot that
 * was active from `effectiveFrom` until the next entry (or "now" for
 * the last one). */
export interface GoalHistoryEntry {
  days: number
  keystrokes: number
  effectiveFrom: string
}

/** Per-keyboard Analyze-tab settings. Lives under `PipetteSettings.analyze`
 * so future analyze settings (filter persistence etc.) can share the same
 * namespace without cluttering the top-level PipetteSettings shape. */
export interface AnalyzeSettings {
  /** Override map from `"row,col"` to FingerType. When a key is absent,
   * the Ergonomics tab falls back to the geometry-based estimate. The
   * hand is always derived from the finger, so it isn't stored separately. */
  fingerAssignments?: Record<string, FingerType>
  /** Current daily keystroke goal (streak threshold) used by the Analyze
   * Streak / Goal cards. Minimum 1 — the UI and the main validator
   * reject zero / negative values so the `>= goal` semantics stay
   * intact. Hit-day count is local-calendar (`strftime('%Y-%m-%d', ...,
   * 'localtime')`). */
  goalKeystrokes?: number
  /** Number of consecutive goal-met days required to "record" one
   * achievement cycle. Reaching this threshold resets the Current streak
   * card to `0/{goalDays}` and appends a new entry to the derived
   * achievement list. Minimum 1. */
  goalDays?: number
  /** Timeline of goal edits. The Current card recomputes against this
   * so past cycles stay valued at the goal that was active when they
   * were earned. Latest entry is the still-active goal snapshot; older
   * entries cover the window `[effectiveFrom, nextEntry.effectiveFrom)`. */
  goalHistory?: GoalHistoryEntry[]
  /** Per-tab filter state for the Analyze dashboard (device scope,
   * heatmap ranking controls, WPM / Interval / Activity / Layer view
   * modes). `range` intentionally stays renderer-local — the default
   * 7-day window reopens each session so users aren't greeted with a
   * stale absolute window. */
  filters?: AnalyzeFilterSettings
  /** Same shape as `filters`, but bound to the secondary "compare"
   * pane in the Analyze split-view. Lets the user keep an independent
   * device scope / view mode / sub-tab limits in Pane B even when both
   * panes have the same uid loaded. Optional so panes A and B start
   * from defaults on first use. */
  compareFilters?: AnalyzeFilterSettings
}

/** Fallback used when no per-keyboard goal has been saved yet. */
export const DEFAULT_GOAL_KEYSTROKES = 1000
export const DEFAULT_GOAL_DAYS = 10

/** Minimum-valid `PipetteSettings` used to bootstrap the settings
 * file when `pipetteSettingsGet` resolves to `null` (brand-new
 * keyboard, no prior write). Consumers spread their own `analyze` /
 * other-field edits onto this base so a first-time edit can create
 * the file instead of silently dropping the write. `_rev` / keyboard
 * layout / `autoAdvance` / `layerNames` are the fields the
 * main-process validator requires. */
export const DEFAULT_PIPETTE_SETTINGS: PipetteSettings = {
  _rev: 1,
  keyboardLayout: 'qwerty',
  autoAdvance: true,
  layerNames: [],
}

export interface PipetteSettings {
  _rev: 1
  keyboardLayout: string
  autoAdvance: boolean
  layerNames: string[]
  typingTestResults?: TypingTestResult[]
  typingTestConfig?: Record<string, unknown>
  typingTestLanguage?: string
  typingTestViewOnly?: boolean
  typingTestViewOnlyWindowSize?: { width: number; height: number }
  typingTestViewOnlyAlwaysOnTop?: boolean
  /** User-chosen record toggle. Persisted + synced so the setting
   * survives reloads and follows the keyboard across machines. Actual
   * recording is gated additionally on typingTestViewOnly at the
   * analyticsSink layer — leaving the typing view stops recording
   * without touching this value. See the "Record lifecycle" section
   * in .claude/plans/typing-analytics.md. */
  typingRecordEnabled?: boolean
  typingViewMenuTab?: TypingViewMenuTab
  typingSyncSpanDays?: TypingSyncSpanDays
  layerPanelOpen?: boolean
  basicViewType?: 'ansi' | 'iso' | 'jis' | 'list'
  splitKeyMode?: 'split' | 'flat'
  quickSelect?: boolean
  keymapScale?: number
  viewMode?: ViewMode
  analyze?: AnalyzeSettings
  _updatedAt?: string // ISO 8601 — last update time
}
