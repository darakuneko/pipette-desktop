// SPDX-License-Identifier: GPL-2.0-or-later

import type { FingerType } from '../kle/kle-ergonomics'
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
 * vs. recording + analytics). */
export const TYPING_VIEW_MENU_TABS = ['window', 'rec'] as const
export type TypingViewMenuTab = typeof TYPING_VIEW_MENU_TABS[number]

export function isTypingViewMenuTab(value: unknown): value is TypingViewMenuTab {
  return typeof value === 'string' && (TYPING_VIEW_MENU_TABS as readonly string[]).includes(value)
}

export function isTypingSyncSpanDays(value: unknown): value is TypingSyncSpanDays {
  return typeof value === 'number' && (ALLOWED_TYPING_SYNC_SPAN_DAYS as readonly number[]).includes(value)
}

/** Per-keyboard Analyze-tab settings. Lives under `PipetteSettings.analyze`
 * so future analyze settings (filter persistence etc.) can share the same
 * namespace without cluttering the top-level PipetteSettings shape. */
export interface AnalyzeSettings {
  /** Override map from `"row,col"` to FingerType. When a key is absent,
   * the Ergonomics tab falls back to the geometry-based estimate. The
   * hand is always derived from the finger, so it isn't stored separately. */
  fingerAssignments?: Record<string, FingerType>
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
