// SPDX-License-Identifier: GPL-2.0-or-later

import type { TypingTestResult } from '../../shared/types/pipette-settings'
import type { TypingTestConfig } from './types'
import type { WordResult } from './run-state'
import { computeKspc } from '../../shared/kspc'
import { classifyWordResults } from './error-classify'

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
 *  label: fileImport → the imported text name, every other mode →
 *  `mode (language)`. Both the recording side (`typingTestAnalyticsLabel`
 *  in useInputModes) and the Analyze run filter
 *  (`typingTestResultMaterialLabel`) funnel through this so the join key
 *  stays byte-identical on both ends. */
export function materialLabel(mode: string, language: string, fileImportName: string | undefined): string {
  if (mode === 'fileImport') return fileImportName ?? 'fileImport'
  // Tatoeba runs are sliced by their sentence-pack language, not the
  // (irrelevant) MonkeyType word language, so they get a dedicated label.
  if (mode === 'tatoeba') return `tatoeba-${language}`
  return `${mode} (${language})`
}

/** The material label a finished result was recorded under — used by the
 *  Analyze run filter to match a History row to its keystrokes. */
export function typingTestResultMaterialLabel(result: TypingTestResult): string {
  return materialLabel(result.mode ?? 'words', result.language ?? '', result.fileImportTextName)
}

/** Keystrokes per minute, derived from the stored char count and duration so
 *  it works for legacy rows too (no separate field needed). */
export function resultKpm(r: TypingTestResult): number {
  return r.durationSeconds > 0 ? Math.round((r.correctChars * 60) / r.durationSeconds) : 0
}

/** Derives a saved result's KSPC from its raw `kspcKeystrokes`/`kspcChars`
 *  fields (the `resultKpm` derived-field precedent) — `null` when either
 *  is absent (legacy row, or the run was KSPC-uncomputable) or the pair
 *  is otherwise invalid. */
export function resultKspc(r: TypingTestResult): number | null {
  if (r.kspcKeystrokes === undefined || r.kspcChars === undefined) return null
  return computeKspc(r.kspcKeystrokes, r.kspcChars)
}

/** Compact `YYYYMMDDHHmmss` timestamp from a result's ISO date. */
function compactTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Quick-insert chips for the result-name modal: the keyboard name (when
 *  known), the material label, a compact timestamp, then the headline metrics.
 *  Each string is inserted verbatim. `t` translates the metric labels
 *  (WPM / KPM / Accuracy) so the chips honour the i18n locale. */
export function buildResultNameChips(result: TypingTestResult, t: (key: string) => string, deviceName?: string): string[] {
  const chips: string[] = []
  if (deviceName) chips.push(deviceName)
  const label = typingTestResultMaterialLabel(result)
  if (label) chips.push(label)
  const ts = compactTimestamp(result.date)
  if (ts) chips.push(ts)
  chips.push(`${t('editor.typingTest.wpm')}${result.wpm}`)
  chips.push(`${t('editor.typingTest.kpm')}${resultKpm(result)}`)
  chips.push(`${t('editor.typingTest.accuracy')}${result.accuracy}`)
  return chips
}

export function configKey(result: TypingTestResult): string {
  return `${result.mode ?? 'words'}|${result.mode2 ?? ''}|${result.language ?? ''}|${result.punctuation ?? false}|${result.numbers ?? false}|${result.romajiInput ?? false}`
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
    case 'fileImport':
      // Group PBs per imported text via its id.
      return config.textId
    case 'tatoeba':
      // Group PBs per sentence-pack language + pattern + active unit (line
      // count or duration), mirroring how words/time bake their count/duration
      // into mode2 — otherwise a 5-line run and a 120s run of the same pack
      // would share one PB pool and condition label.
      return `${config.language}|${config.pattern}|${config.pattern === 'lines' ? config.lineCount : config.duration}`
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
  /** Imported-text display name (fileImport mode); ignored for other modes. */
  fileImportTextName?: string
  /** Run id of the finished run, linking History to analytics keystrokes. */
  runId?: string
  /** Whether romaji-keystroke judging was actually in effect for this run
   *  (see `isRomajiInputActive`) — not the raw `config.romajiInput` flag,
   *  since that now defaults to on and must still be gated by capability.
   *  Recorded verbatim as `romajiInput` below, so a run under every mode
   *  (including tatoeba/fileImport, which never recorded this before) is
   *  now grouped/labeled consistently with words/time runs. */
  romajiActive: boolean
  /** Per-run mistake tally (see `TypingTestState.mistakes`). Stored on the
   *  result only when non-empty — see `buildTypingTestResult`. */
  mistakes: Record<string, number>
  /** Total physical keystrokes observed this run (see
   *  `TypingTestState.totalKeystrokes`) — KSPC's numerator. */
  totalKeystrokes: number
  /** Mode-agnostic count of characters actually confirmed this run (see
   *  `TypingTestState.confirmedChars`) — KSPC's denominator. Accumulated
   *  by run-state.ts/romaji-input.ts at the moment each mode confirms a
   *  character, so this function does no mode-specific derivation of
   *  its own. */
  confirmedChars: number
  /** True when an IME composition made `totalKeystrokes` untrustworthy
   *  for this run (see `TypingTestState.kspcUncomputable`) — when true,
   *  neither KSPC field is stored regardless of the numeric values. */
  kspcUncomputable: boolean
  /** Finalized word pairs (see `TypingTestState.wordResults`), used to
   *  compute the error-class raw group (`errorSubstitutions`/
   *  `errorOmissions`/`errorInsertions`/`errorTargetChars` — see
   *  `classifyWordResults`). Optional and defaulted to `[]` so existing
   *  callers/tests that don't care about error classes don't have to
   *  thread it through; an empty (or omitted) list stores nothing, same
   *  as a romaji run (see `buildTypingTestResult`). */
  wordResults?: readonly WordResult[]
}

/** Narrows to the 'words' / 'time' config variants — the only ones carrying
 * punctuation/numbers toggles. A plain `mode === 'words' || mode === 'time'`
 * boolean stored in a separate variable doesn't narrow `config` itself at
 * the read site, so this needs to be a real type guard. */
function hasWordTimeToggles(
  config: TypingTestConfig,
): config is Extract<TypingTestConfig, { mode: 'words' | 'time' }> {
  return config.mode === 'words' || config.mode === 'time'
}

export function buildTypingTestResult(input: BuildTypingTestResultInput): TypingTestResult {
  const totalChars = input.correctChars + input.incorrectChars
  const rawWpm = computeRawWpm(totalChars, input.elapsedMs)
  const consistency = computeConsistency(input.wpmHistory)
  const config = input.config
  const wordTimeConfig = hasWordTimeToggles(config) ? config : undefined
  const hasPunctuation = wordTimeConfig?.punctuation
  const hasNumbers = wordTimeConfig?.numbers

  // Both-or-neither: KSPC is only stored when it was actually computable
  // for this run (see computeKspc's doc comment) — an uncomputable run,
  // or one with no confirmed characters at all, stores neither raw
  // field, so the display side reads it as "—" exactly like any other
  // legacy result.
  const kspc = input.kspcUncomputable ? null : computeKspc(input.totalKeystrokes, input.confirmedChars)

  // Error-class breakdown: non-romaji runs only, with at least one
  // finalized word (see error-classify.ts's module header for the romaji
  // rationale, classifyWordResults for the in-flight-word exclusion).
  const wordResults = input.wordResults ?? []
  const rawErrorClasses = !input.romajiActive && wordResults.length > 0
    ? classifyWordResults(wordResults)
    : null
  // Same division-by-zero guard as kspcChars above: a target-length sum
  // of 0 (every finalized word was an empty string, never expected in
  // practice) would make a downstream rate undefined, so store nothing
  // rather than a group with an unusable denominator.
  const errorClasses = rawErrorClasses && rawErrorClasses.targetChars > 0 ? rawErrorClasses : null

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
    fileImportTextName: input.config.mode === 'fileImport' ? input.fileImportTextName : undefined,
    // Tatoeba stores its sentence-pack language (from the config) so the
    // material label and PB grouping key it, not the MonkeyType word language.
    language: input.config.mode === 'tatoeba' ? input.config.language : input.language,
    punctuation: hasPunctuation,
    numbers: hasNumbers,
    romajiInput: input.romajiActive ? true : undefined,
    consistency,
    wpmHistory: input.wpmHistory,
    mistakes: Object.keys(input.mistakes).length > 0 ? input.mistakes : undefined,
    kspcKeystrokes: kspc !== null ? input.totalKeystrokes : undefined,
    kspcChars: kspc !== null ? input.confirmedChars : undefined,
    errorSubstitutions: errorClasses?.substitutions,
    errorOmissions: errorClasses?.omissions,
    errorInsertions: errorClasses?.insertions,
    errorTargetChars: errorClasses?.targetChars,
  }
}
