// SPDX-License-Identifier: GPL-2.0-or-later

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
  /** Record toggle is NOT persisted here on purpose: recording is only
   * valid while the typing-view compact window is open, and every entry
   * starts from OFF so the user has to press Start explicitly. See the
   * "Record lifecycle" section in .claude/plans/typing-analytics.md. */
  typingViewMenuTab?: TypingViewMenuTab
  typingSyncSpanDays?: TypingSyncSpanDays
  layerPanelOpen?: boolean
  basicViewType?: 'ansi' | 'iso' | 'jis' | 'list'
  splitKeyMode?: 'split' | 'flat'
  quickSelect?: boolean
  keymapScale?: number
  viewMode?: ViewMode
  _updatedAt?: string // ISO 8601 — last update time
}
