// SPDX-License-Identifier: GPL-2.0-or-later

import type { FingerType } from '../kle/kle-ergonomics'
import type { AnalyzeFilterSettings } from './analyze-filters'
import { ALLOWED_TYPING_SYNC_SPAN_DAYS, type TypingSyncSpanDays } from './typing-analytics'

export interface TypingTestResult {
  date: string
  /** Run id linking this History entry to its analytics keystrokes
   *  (the `run_id` dimension). Absent for runs recorded before run
   *  tagging existed — those can't be sliced in Analyze. */
  runId?: string
  /** User-assigned label for comparing runs (e.g. "QWERTY baseline"). */
  name?: string
  wpm: number
  accuracy: number
  wordCount: number
  correctChars: number
  incorrectChars: number
  durationSeconds: number
  rawWpm?: number
  mode?: 'words' | 'time' | 'quote' | 'fileImport' | 'tatoeba'
  mode2?: number | string
  /** Human-readable imported-text name, snapshotted at test time (fileImport
   *  mode only). `mode2` keeps the stable textId for PB grouping; this is
   *  what History shows so the row isn't an opaque id. */
  fileImportTextName?: string
  language?: string
  punctuation?: boolean
  numbers?: boolean
  /** Sequential romaji-keystroke judging was on for this run (words/time
   *  kana packs only — see `ROMAJI_INPUT_LANGUAGES`). Kept alongside
   *  punctuation/numbers so PB grouping (`configKey`) and condition
   *  grouping (`resultConditionKey`) never mix romaji and verbatim runs of
   *  the same kana pack. */
  romajiInput?: boolean
  consistency?: number
  isPb?: boolean
  wpmHistory?: number[]
  /** Per-run tally of mistyped characters, keyed by the target character
   *  (verbatim mode) or the canonical romaji spelling of the mistyped kana
   *  segment (romaji mode — see `TypingTestState.mistakes` in run-state.ts
   *  for the counting rules). Omitted when the run had no mistakes. Phase 1
   *  of mistake analysis: stored on the result for the completion screen's
   *  "missed characters" list; not yet surfaced in Analyze. */
  mistakes?: Record<string, number>
  /** KSPC (keystrokes per confirmed character) raw numerator: total
   *  physical keystrokes observed this run (see
   *  `TypingTestState.totalKeystrokes`). Both-or-neither with
   *  `kspcChars` — stored only when the run was actually KSPC-computable
   *  (see `buildTypingTestResult`); the displayed ratio is derived via
   *  `resultKspc` rather than precomputed, mirroring the KPM
   *  (`resultKpm`) precedent. Omitted for runs saved before KSPC existed,
   *  or any run an IME composition made uncomputable. */
  kspcKeystrokes?: number
  /** KSPC raw denominator: the run's confirmed-character count (see
   *  `TypingTestState.confirmedChars`, accumulated mode-agnostically by
   *  run-state.ts/romaji-input.ts as each mode confirms a character). See
   *  `kspcKeystrokes` for the both-or-neither contract. */
  kspcChars?: number
  /** Average key-hold-duration raw pair (press→release ms), both-or-neither
   *  same shape as `kspcKeystrokes`/`kspcChars`: `holdSumMs` sums every
   *  keystroke's `releaseMs - pressMs` this run where a release was
   *  actually observed and the duration was positive (see
   *  `word-timeline.ts`'s `WordTimelineStats.holdSumMs`/`holdSamples` for
   *  the per-word raw counters this pools from), `holdSamples` is the
   *  qualifying keystroke count. The displayed mean is derived via
   *  `resultAvgHoldMs` rather than precomputed, mirroring the KPM
   *  (`resultKpm`)/KSPC (`resultKspc`) precedent. Omitted for a run with
   *  no qualifying keystroke (e.g. every key still held at run end) or one
   *  saved before this field existed. */
  holdSumMs?: number
  holdSamples?: number
  /** Error-class breakdown (see `error-classify.ts`'s `classifyWordResults`),
   *  a 4-field all-or-nothing raw group (same both-or-neither shape as
   *  `kspcKeystrokes`/`kspcChars`, just with four fields instead of two):
   *  `errorSubstitutions`/`errorOmissions`/`errorInsertions` are the raw
   *  counts from aligning every finalized word's target text against what
   *  was actually typed, and `errorTargetChars` is the WER/CER-style
   *  denominator (Σ target length of every classified word — NOT Σ typed
   *  length, which shrinks under omission and would inflate an omission
   *  rate computed against it). Display derives rate% = count /
   *  errorTargetChars × 100 at read time (never precomputed/stored) — an
   *  insertion rate can validly exceed 100% since insertions have no
   *  target-length ceiling. Stored only for non-romaji runs with at least
   *  one finalized word (see `buildTypingTestResult`) — romaji runs never
   *  get this group (see `error-classify.ts`'s module header for why a
   *  romaji comparison is structurally impossible, not merely skipped).
   *  Omitted entirely for runs saved before this existed. */
  errorSubstitutions?: number
  errorOmissions?: number
  errorInsertions?: number
  errorTargetChars?: number
}

/** A saved result tagged with the keyboard it belongs to. Returned by the
 *  cross-keyboard pool so the comparison picker can show a Keyboard column. */
export interface PooledTypingTestResult extends TypingTestResult {
  keyboardName: string
}

export const VIEW_MODES = ['editor', 'typingView', 'typingTest'] as const
export type ViewMode = typeof VIEW_MODES[number]

/** Measurement-row comparison baseline. Comparison is always within the same
 *  condition: `previous` (default) / `best` / `average` compute from
 *  same-condition results pooled across all local keyboards; `pinned` fixes the
 *  baseline to one chosen same-condition result (by its History `date` key);
 *  `off` hides the delta. The baseline is remembered per condition (see
 *  `typingTestComparisonBaselines`), so switching the typing-test condition
 *  recalls the baseline saved for it. */
export const COMPARISON_BASELINE_KINDS = ['previous', 'best', 'average', 'pinned', 'off'] as const
export type ComparisonBaselineKind = typeof COMPARISON_BASELINE_KINDS[number]

export interface TypingTestComparisonBaseline {
  kind: ComparisonBaselineKind
  /** History key (`date`, ISO string) of the chosen result when kind === 'pinned'. */
  pinnedDate?: string
}

export function isTypingTestComparisonBaseline(value: unknown): value is TypingTestComparisonBaseline {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (!(COMPARISON_BASELINE_KINDS as readonly string[]).includes(v.kind as string)) return false
  if ('pinnedDate' in v && v.pinnedDate != null && typeof v.pinnedDate !== 'string') return false
  return true
}

/** Map of condition key → baseline. Each typing-test condition (mode + params,
 *  or imported text) keeps its own remembered baseline. */
export type TypingTestComparisonBaselines = Record<string, TypingTestComparisonBaseline>

export function isTypingTestComparisonBaselines(value: unknown): value is TypingTestComparisonBaselines {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every((v) => isTypingTestComparisonBaseline(v))
}

export const DEFAULT_COMPARISON_BASELINE: TypingTestComparisonBaseline = { kind: 'previous' }

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
  /** Show the population-benchmark reference line on the WPM / Interval
   * time-series charts (see `src/shared/typing-benchmarks.ts`). Absent
   * means shown — older settings files predate this field, and the
   * overlay is meant to be on by default. */
  showBenchmark?: boolean
}

/** Fallback used when no per-keyboard goal has been saved yet. */
export const DEFAULT_GOAL_KEYSTROKES = 1000
export const DEFAULT_GOAL_DAYS = 10

/** One key's user-assigned position in the View Matrix — the logical
 * (row, col) the keymap editor's Auto Move (auto-advance) walk should use
 * instead of the key's physical Vial matrix position. */
export interface ViewMatrixCell {
  row: number
  col: number
}

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

/** Serializable per-word result for resuming a paused fileImport typing test. */
export interface TypingTestMemoryWord {
  word: string
  typed: string
  correct: boolean
}

/** Snapshot of an in-progress imported (fileImport) typing test, persisted so
 * the user can pause and resume later. One slot per keyboard. Words and
 * line breaks are regenerated from `textId`, so only progress is stored. */
export interface TypingTestMemory {
  /** typing-test-texts store id of the imported text being typed. */
  textId: string
  /** Run id of the paused run, so resume keeps it one run in analytics.
   *  Absent in memories saved before run tagging existed. */
  runId?: string
  currentWordIndex: number
  currentInput: string
  wordResults: TypingTestMemoryWord[]
  correctChars: number
  incorrectChars: number
  /** Accumulated typing time in ms (excludes the paused interval). */
  elapsedMs: number
  wpmHistory: number[]
  /** Total physical keystrokes observed so far (see
   *  `TypingTestState.totalKeystrokes`), persisted alongside
   *  `confirmedChars`/`kspcUncomputable` so KSPC keeps counting correctly
   *  across pause/resume. All-or-nothing: a memory saved before KSPC
   *  existed has none of the three fields, and restoring it makes the
   *  resumed run permanently KSPC-uncomputable (see
   *  `useTypingTest.restoreState`) — a bare `totalKeystrokes` with no
   *  `kspcUncomputable` would otherwise conflate a genuine 0 with
   *  "unknown, pre-KSPC format". */
  totalKeystrokes?: number
  /** Mode-agnostic confirmed-character count so far (see
   *  `TypingTestState.confirmedChars`) — KSPC's denominator. See
   *  `totalKeystrokes` for the all-or-nothing contract. */
  confirmedChars?: number
  /** True once an IME composition fired during this run before it was
   *  paused (see `TypingTestState.kspcUncomputable`). See
   *  `totalKeystrokes` for the all-or-nothing contract. */
  kspcUncomputable?: boolean
  /** ISO 8601 save time. */
  savedAt: string
}

export interface PipetteSettings {
  _rev: 1
  keyboardLayout: string
  autoAdvance: boolean
  layerNames: string[]
  typingTestResults?: TypingTestResult[]
  typingTestConfig?: Record<string, unknown>
  /** Last words/time/quote config, restored when switching back from fileImport
   *  (imported text) so normal-mode Pattern/Units/Option settings survive. */
  typingTestMonkeytypeConfig?: Record<string, unknown>
  typingTestLanguage?: string
  typingTestViewOnly?: boolean
  typingTestViewOnlyWindowSize?: { width: number; height: number }
  typingTestViewOnlyAlwaysOnTop?: boolean
  /** Paused fileImport typing-test snapshot (memory mode). Cleared on finish,
   * "start over", text change, or device switch. */
  typingTestMemory?: TypingTestMemory
  /** Imported-text display: visible line count (2–10, default 4). */
  typingTestDisplayLines?: number
  /** Imported-text display: font size in px (14–48, default 24). */
  typingTestFontSize?: number
  /** Editor typing-test: hide the keymap (keyboard) pane. Default false. */
  typingTestHideKeymap?: boolean
  /** Editor typing-test: hide the stats / results (WPM) row. Default false. */
  typingTestHideStatsRow?: boolean
  /** Editor typing-test: hide the operation (Next Test button) controls row.
   *  Default false. Force-shown once a test finishes. */
  typingTestHideControls?: boolean
  /** Editor typing-test: auto-save finished results even without a name.
   *  Default true (every result is saved, the user may name it after).
   *  When false a finished result is held unsaved until the user gives it a
   *  name — leaving it unnamed discards it. */
  typingTestSaveUnnamed?: boolean
  /** Editor typing-test: Measurement-row comparison baseline per condition
   *  key. Unset conditions default to `{ kind: 'previous' }`. */
  typingTestComparisonBaselines?: TypingTestComparisonBaselines
  /** Editor typing-test: the left Settings panel is expanded. Default true. */
  typingTestSettingsPanelOpen?: boolean
  /** User-chosen record toggle. Persisted + synced so the setting
   * survives reloads and follows the keyboard across machines. Actual
   * recording is gated additionally on typingTestViewOnly at the
   * analyticsSink layer — leaving the typing view stops recording
   * without touching this value. See the "Record lifecycle" section
   * in .claude/plans/typing-analytics.md. */
  typingRecordEnabled?: boolean
  typingSyncSpanDays?: TypingSyncSpanDays
  layerPanelOpen?: boolean
  basicViewType?: 'ansi' | 'iso' | 'jis' | 'list'
  splitKeyMode?: 'split' | 'flat'
  quickSelect?: boolean
  keymapScale?: number
  keyEditorZoom?: number
  viewMode?: ViewMode
  /** Auto Move (auto-advance) order override, keyed by the key's PHYSICAL
   * matrix position (`"row,col"`). Sparse — only overridden keys are
   * stored here; a key absent from this map falls back to its physical
   * Vial matrix row/col for ordering purposes. The value is the logical
   * (row, col) the key should sort by instead. */
  viewMatrix?: Record<string, ViewMatrixCell>
  analyze?: AnalyzeSettings
  _updatedAt?: string // ISO 8601 — last update time
}

/** Field-level patch for {@link PipetteSettings}. Each key is optional; a
 * value applies as-is, `undefined` leaves the persisted value untouched
 * (so a writer never erases a field it doesn't own), and `null` explicitly
 * clears the field (removes the key). The full-prefs writer uses `null` to
 * clear owned fields like `typingTestMemory`; sub-field writers just omit
 * what they don't own. */
export type PipetteSettingsPatch = {
  [K in keyof PipetteSettings]?: PipetteSettings[K] | null
}
