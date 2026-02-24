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

export interface PipetteSettings {
  _rev: 1
  keyboardLayout: string
  autoAdvance: boolean
  layerNames: string[]
  typingTestResults?: TypingTestResult[]
  typingTestConfig?: Record<string, unknown>
  typingTestLanguage?: string
  layerPanelOpen?: boolean
  basicViewType?: 'list' | 'keyboard'
  _updatedAt?: string // ISO 8601 — last update time
}
