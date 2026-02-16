// SPDX-License-Identifier: GPL-2.0-or-later

export type TypingTestMode = 'words' | 'time' | 'quote'
export type QuoteLength = 'short' | 'medium' | 'long' | 'all'

export type TypingTestConfig =
  | { mode: 'words'; wordCount: number; punctuation: boolean; numbers: boolean }
  | { mode: 'time'; duration: number; punctuation: boolean; numbers: boolean }
  | { mode: 'quote'; quoteLength: QuoteLength }

export interface Quote {
  id: number
  text: string
  source: string
  length: number
}

export const WORD_COUNT_OPTIONS = [15, 30, 60, 120] as const
export const TIME_DURATION_OPTIONS = [15, 30, 60, 120] as const
export const DEFAULT_LANGUAGE = 'english'
export const DEFAULT_CONFIG: TypingTestConfig = {
  mode: 'words',
  wordCount: 30,
  punctuation: false,
  numbers: false,
}
