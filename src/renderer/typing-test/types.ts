// SPDX-License-Identifier: GPL-2.0-or-later

import type { RomajiStyle } from './romaji-engine'

export type TypingTestMode = 'words' | 'time' | 'quote' | 'fileImport' | 'tatoeba'
export type QuoteLength = 'short' | 'medium' | 'long' | 'all'

// Display-only case transform for the romaji guide row (Romaji Settings
// modal). Never affects acceptance — see `applyRomajiCaseStyle`.
export type RomajiCaseStyle = 'lower' | 'capital' | 'upper'

/** Romaji Settings modal fields (words/time modes only, kana packs only).
 *  Every field is optional and undefined means "default behaviour" — the
 *  modal omits a field entirely rather than persisting an explicit default
 *  value, so a stored config always shows exactly what the user changed. */
export interface RomajiDetailSettings {
  /** Display-only case transform for the guide row. Default: 'lower'. */
  caseStyle?: RomajiCaseStyle
  /** Preferred spelling styles for the guide's displayed representative —
   *  any combination may be selected at once. Empty/undefined shows the
   *  canonical Hepburn-based spelling. Passed straight through to
   *  `createRomajiMatcher`'s `guideStyles` opt. */
  guideStyles?: RomajiStyle[]
  /** Alternate-spelling families excluded from acceptance. Passed straight
   *  through to `createRomajiMatcher`'s `disabledStyles` opt. */
  disabledStyles?: RomajiStyle[]
}

export type TypingTestConfig =
  // `romajiInput` opts into sequential romaji-keystroke judging for kana
  // packs (japanese_hiragana / japanese_katakana). Defaults ON when unset:
  // an undefined value is treated as opted-in (subject to capability —
  // see `isRomajiCapable`), and only an explicit `false` falls back to the
  // verbatim-string matching behaviour. `romaji` holds the Romaji Settings
  // modal's detail fields and is only ever read while `romajiInput` is
  // honored (see `isRomajiInputActive`).
  | { mode: 'words'; wordCount: number; punctuation: boolean; numbers: boolean; romajiInput?: boolean; romaji?: RomajiDetailSettings }
  | { mode: 'time'; duration: number; punctuation: boolean; numbers: boolean; romajiInput?: boolean; romaji?: RomajiDetailSettings }
  | { mode: 'quote'; quoteLength: QuoteLength }
  // Imported user text, played verbatim in order via the quote rendering
  // path. `textId` references an entry in the typing-test-texts store.
  // `romajiInput`/`romaji` are only meaningful when the loaded text is
  // kana-pure — see `isRomajiCapable` in romaji-input.ts.
  | { mode: 'fileImport'; textId: string; romajiInput?: boolean; romaji?: RomajiDetailSettings }
  // Tatoeba sentence pack (Hub-distributed). Sentences are played verbatim
  // in order via the same char-count/word-flow path as fileImport. `language`
  // selects the downloaded pack (e.g. 'english'). Like words/time, Tatoeba
  // has its own Pattern (Lines / Time) with its own Units — `lineCount` and
  // `duration` are both always stored (not just the active pattern's field)
  // so switching Pattern preserves each independently, same as words/time
  // keep their own counts. `romajiInput`/`romaji` are only meaningful when
  // `language` is one of the kana packs — see `isRomajiCapable` in
  // romaji-input.ts.
  | { mode: 'tatoeba'; language: string; pattern: 'lines' | 'time'; lineCount: number; duration: number; romajiInput?: boolean; romaji?: RomajiDetailSettings }

export interface Quote {
  id: number
  text: string
  source: string
  length: number
}

export const WORD_COUNT_OPTIONS = [15, 30, 60, 120] as const
export const TIME_DURATION_OPTIONS = [15, 30, 60, 120] as const
// Tatoeba's Lines pattern reuses the same 15/30/60/120 TIME_DURATION_OPTIONS
// for its Time pattern — only Lines needs its own option set.
export const TATOEBA_LINE_OPTIONS = [5, 10, 20, 40] as const
export const DEFAULT_LANGUAGE = 'english'

/** True for every "time-bounded" run — monkeytype time mode, or the tatoeba
 *  Time pattern — the two config shapes whose word supply is an
 *  ever-extending stream (see `refillTimeModeWords`) rather than a fixed
 *  count, and whose run finishes on a countdown rather than on running out
 *  of words (see `advanceAfterWord`). Centralizes the check so tatoeba+time
 *  slots into the existing time logic without scattering
 *  `mode === 'time' || (mode === 'tatoeba' && pattern === 'time')`
 *  conditionals across run-state.ts / useTypingTest.ts. */
export function isTimeBoundedRun(
  config: TypingTestConfig,
): config is Extract<TypingTestConfig, { mode: 'time' }> | (Extract<TypingTestConfig, { mode: 'tatoeba' }> & { pattern: 'time' }) {
  return config.mode === 'time' || (config.mode === 'tatoeba' && config.pattern === 'time')
}

/** The configured duration (seconds) for a time-bounded run (see
 *  `isTimeBoundedRun`), or null for every other mode/pattern. Derived from
 *  the predicate so the two never disagree. */
export function runDurationSeconds(config: TypingTestConfig): number | null {
  return isTimeBoundedRun(config) ? config.duration : null
}

/** Word-language packs the romaji-keystroke matcher supports (kana word
 *  lists only). Drives the SettingsBar toggle's visibility, and — via
 *  `isRomajiCapable` / `isRomajiInputActive` in romaji-input.ts — whether the
 *  (default-on, unless explicitly `false`) `romajiInput` choice is actually
 *  honored for words/time (by the active language) and tatoeba (by the
 *  pack's `language` id). The flag itself is never stripped from the config
 *  (same as `punctuation`/`numbers`): it stays saved across language
 *  switches, mount, and `setConfig` calls, and is simply inert whenever the
 *  relevant language isn't in this set. Selecting a kana pack again picks it
 *  back up automatically. */
export const ROMAJI_INPUT_LANGUAGES = new Set(['japanese_hiragana', 'japanese_katakana'])

/** Current word's confirmed romaji + canonical remaining spelling, plus the
 *  count of kana characters fully confirmed so far (romajiInput mode only).
 *  `lookahead` holds the full canonical romaji spelling of up to the next
 *  two upcoming words (empty entries once fewer remain), letting the guide
 *  row preview what's coming after the current word. Produced by
 *  `useTypingTest`'s `romajiGuide` selector from a `RomajiMatcher` (see
 *  romaji-engine.ts), consumed by `WordDisplay` (kana coloring) and
 *  `TypingTestView` (the guide line below the reading window). */
export interface RomajiGuide {
  typed: string
  remaining: string
  kanaCompleted: number
  lookahead: string[]
}

/** Capitalizes only the first character of a whole word (used for
 *  lookahead entries, which have no typed/remaining split of their own). */
function capitalizeWord(word: string): string {
  return word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word
}

/** Applies the Romaji Settings modal's display-only case transform to a
 *  guide's typed/remaining strings, and to each `lookahead` entry. Never
 *  touches acceptance/matching — `createRomajiMatcher` always works in
 *  lowercase; this only changes what `TypingTestView`'s guide row renders.
 *  'upper' uppercases the whole string (and each lookahead word in full);
 *  'capital' uppercases only the first character of the word as a whole
 *  (the first char of `typed` once anything is typed, otherwise the first
 *  char of `remaining`; each lookahead word gets its own first character
 *  capitalized, since each is a whole word with no typed portion);
 *  'lower'/undefined is a no-op. */
export function applyRomajiCaseStyle(guide: RomajiGuide, caseStyle: RomajiCaseStyle | undefined): RomajiGuide {
  if (!caseStyle || caseStyle === 'lower') return guide
  if (caseStyle === 'upper') {
    return {
      ...guide,
      typed: guide.typed.toUpperCase(),
      remaining: guide.remaining.toUpperCase(),
      lookahead: guide.lookahead.map((word) => word.toUpperCase()),
    }
  }
  const lookahead = guide.lookahead.map(capitalizeWord)
  if (guide.typed.length > 0) {
    return { ...guide, typed: capitalizeWord(guide.typed), lookahead }
  }
  if (guide.remaining.length > 0) {
    return { ...guide, remaining: capitalizeWord(guide.remaining), lookahead }
  }
  return { ...guide, lookahead }
}

// Imported file-import-text display preferences (fileImport mode only).
export const DISPLAY_LINES_MIN = 2
export const DISPLAY_LINES_MAX = 10
export const DEFAULT_DISPLAY_LINES = 4
export const FONT_SIZE_MIN = 14
export const FONT_SIZE_MAX = 48
export const FONT_SIZE_STEP = 2
export const DEFAULT_FONT_SIZE = 24

/** Every selectable font size (px), in ascending order — shared by every
 *  font-size <select> (the reading window's Settings > Font and the Romaji
 *  Settings modal's own font-size field). */
export const FONT_OPTIONS = Array.from(
  { length: (FONT_SIZE_MAX - FONT_SIZE_MIN) / FONT_SIZE_STEP + 1 },
  (_, i) => FONT_SIZE_MIN + i * FONT_SIZE_STEP,
)

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
