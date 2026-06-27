// SPDX-License-Identifier: GPL-2.0-or-later

import type { TypingTestResult } from '../../shared/types/pipette-settings'
import type { TypingTestConfig } from './types'

export function computeRawWpm(totalChars: number, durationMs: number): number {
  if (durationMs <= 0) return 0
  const minutes = durationMs / 60000
  return Math.round((totalChars / 5) / minutes)
}

export function computeConsistency(wpmHistory: number[]): number {
  if (wpmHistory.length <= 1) return 100
  const mean = wpmHistory.reduce((a, b) => a + b, 0) / wpmHistory.length
  if (mean === 0) return 100
  const variance = wpmHistory.reduce((sum, v) => sum + (v - mean) ** 2, 0) / wpmHistory.length
  const stdDev = Math.sqrt(variance)
  const cv = (stdDev / mean) * 100
  return Math.max(0, Math.round(100 - cv))
}

/** The single source of truth for the analytics `typing_test` material
 *  label: custom → the imported text name, every other mode →
 *  `mode (language)`. Both the recording side (`typingTestAnalyticsLabel`
 *  in useInputModes) and the Analyze run filter
 *  (`typingTestResultMaterialLabel`) funnel through this so the join key
 *  stays byte-identical on both ends. */
export function materialLabel(mode: string, language: string, customName: string | undefined): string {
  if (mode === 'custom') return customName ?? 'custom'
  return `${mode} (${language})`
}

/** The material label a finished result was recorded under — used by the
 *  Analyze run filter to match a History row to its keystrokes. */
export function typingTestResultMaterialLabel(result: TypingTestResult): string {
  return materialLabel(result.mode ?? 'words', result.language ?? '', result.customTextName)
}

export function configKey(result: TypingTestResult): string {
  return `${result.mode ?? 'words'}|${result.mode2 ?? ''}|${result.language ?? ''}|${result.punctuation ?? false}|${result.numbers ?? false}`
}

export function isPbForConfig(result: TypingTestResult, history: TypingTestResult[]): boolean {
  const key = configKey(result)
  const sameConfig = history.filter((r) => configKey(r) === key)
  if (sameConfig.length === 0) return true
  const bestWpm = Math.max(...sameConfig.map((r) => r.wpm))
  return result.wpm > bestWpm
}

export function trimResults(results: TypingTestResult[], max: number): TypingTestResult[] {
  if (results.length <= max) return results
  return results.slice(0, max)
}

export function deriveMode2(config: TypingTestConfig): number | string {
  switch (config.mode) {
    case 'words':
      return config.wordCount
    case 'time':
      return config.duration
    case 'quote':
      return config.quoteLength
    case 'custom':
      // Group PBs per imported text via its id.
      return config.textId
  }
}

export interface BuildTypingTestResultInput {
  correctChars: number
  incorrectChars: number
  wordCount: number
  wpm: number
  accuracy: number
  elapsedMs: number
  config: TypingTestConfig
  language: string
  wpmHistory: number[]
  /** Imported-text display name (custom mode); ignored for other modes. */
  customTextName?: string
  /** Run id of the finished run, linking History to analytics keystrokes. */
  runId?: string
}

export function buildTypingTestResult(input: BuildTypingTestResultInput): TypingTestResult {
  const totalChars = input.correctChars + input.incorrectChars
  const rawWpm = computeRawWpm(totalChars, input.elapsedMs)
  const consistency = computeConsistency(input.wpmHistory)
  const hasToggles = input.config.mode === 'words' || input.config.mode === 'time'
  const hasPunctuation = hasToggles ? input.config.punctuation : undefined
  const hasNumbers = hasToggles ? input.config.numbers : undefined

  return {
    date: new Date().toISOString(),
    runId: input.runId,
    wpm: input.wpm,
    accuracy: input.accuracy,
    wordCount: input.wordCount,
    correctChars: input.correctChars,
    incorrectChars: input.incorrectChars,
    durationSeconds: Math.round(input.elapsedMs / 1000),
    rawWpm,
    mode: input.config.mode,
    mode2: deriveMode2(input.config),
    customTextName: input.config.mode === 'custom' ? input.customTextName : undefined,
    language: input.language,
    punctuation: hasPunctuation,
    numbers: hasNumbers,
    consistency,
    wpmHistory: input.wpmHistory,
  }
}
