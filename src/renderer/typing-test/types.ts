// SPDX-License-Identifier: GPL-2.0-or-later

export type TypingTestMode = 'words' | 'time' | 'quote' | 'fileImport' | 'tatoeba'
export type QuoteLength = 'short' | 'medium' | 'long' | 'all'

export type TypingTestConfig =
  | { mode: 'words'; wordCount: number; punctuation: boolean; numbers: boolean }
  | { mode: 'time'; duration: number; punctuation: boolean; numbers: boolean }
  | { mode: 'quote'; quoteLength: QuoteLength }
  // Imported user text, played verbatim in order via the quote rendering
  // path. `textId` references an entry in the typing-test-texts store.
  | { mode: 'fileImport'; textId: string }
  // Tatoeba sentence pack (Hub-distributed). Sentences are played verbatim
  // in order via the same char-count/word-flow path as fileImport. `language`
  // selects the downloaded pack (e.g. 'english').
  | { mode: 'tatoeba'; language: string }

export interface Quote {
  id: number
  text: string
  source: string
  length: number
}

export const WORD_COUNT_OPTIONS = [15, 30, 60, 120] as const
export const TIME_DURATION_OPTIONS = [15, 30, 60, 120] as const
export const DEFAULT_LANGUAGE = 'english'

// Imported file-import-text display preferences (fileImport mode only).
export const DISPLAY_LINES_MIN = 2
export const DISPLAY_LINES_MAX = 10
export const DEFAULT_DISPLAY_LINES = 4
export const FONT_SIZE_MIN = 14
export const FONT_SIZE_MAX = 48
export const FONT_SIZE_STEP = 2
export const DEFAULT_FONT_SIZE = 24

/** Clamp + round a display-line-count to the supported range. */
export function clampDisplayLines(n: number): number {
  return Math.min(DISPLAY_LINES_MAX, Math.max(DISPLAY_LINES_MIN, Math.round(n)))
}

/** Clamp + snap a font size (px) to the supported even range. */
export function clampFontSize(px: number): number {
  const snapped = Math.round(px / FONT_SIZE_STEP) * FONT_SIZE_STEP
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, snapped))
}
export const DEFAULT_CONFIG: TypingTestConfig = {
  mode: 'words',
  wordCount: 30,
  punctuation: false,
  numbers: false,
}
