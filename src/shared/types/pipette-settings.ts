// SPDX-License-Identifier: GPL-2.0-or-later

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
  layerPanelOpen?: boolean
  basicViewType?: 'ansi' | 'iso' | 'jis' | 'list'
  splitKeyMode?: 'split' | 'flat'
  quickSelect?: boolean
  keymapScale?: number
  viewMode?: ViewMode
  _updatedAt?: string // ISO 8601 — last update time
}
