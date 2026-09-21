// SPDX-License-Identifier: GPL-2.0-or-later

import type { RefObject } from 'react'
import type { TypingTestState } from './useTypingTest'
import type { RomajiGuide, TypingTestConfig } from './types'
import type { KanaGuide } from './kana-input'
import type { ComparisonStats } from './comparison'
import type { RunKeystrokeLog } from '../../shared/types/typing-run-log'
import type { TypingTestResult } from '../../shared/types/pipette-settings'

/** A tagged snapshot of TypingTestView's own realized line rows (`lines` below
 *  — real or synthetic, same `number[][]` shape either way), written by
 *  a `useLayoutEffect` (never during render) into a caller-owned ref.
 *  `use-typing-test-result-save.ts` reads it at finish time to derive
 *  `RunKeystrokeLog.lineBreaks` for monkeytype modes (words/time/quote),
 *  which have no real `state.lineBreaks` of their own — see that file's
 *  own doc comment for the runId/wordCount match it requires before
 *  trusting a stale snapshot. `runId`/`wordCount` are the tag: a
 *  consumer must check both against its own current state before using
 *  `lines`, since this ref can otherwise still hold the PREVIOUS run's
 *  last-measured value for one render (the effect that clears it runs
 *  after the consumer's own effect in the same commit is not guaranteed
 *  to have fired first). `lines: null` means unmeasured (jsdom, or
 *  before the first paint) — distinct from an absent snapshot
 *  altogether (`lineSnapshotRef.current === null`, i.e. the effect has
 *  never run at all). */
export interface LineSnapshot {
  runId: string
  wordCount: number
  lines: number[][] | null
}

export interface Props {
  state: TypingTestState
  wpm: number
  /** Keystrokes per minute — shown instead of WPM in fileImport mode. */
  kpm?: number
  accuracy: number
  /** Keystrokes per confirmed character (see `useTypingTest`'s `kspc`).
   *  `null`/`undefined` shows '-', same as before measuring starts. */
  kspc?: number | null
  elapsedSeconds: number
  remainingSeconds: number | null
  config: TypingTestConfig
  paused: boolean
  /** Hide the stats / results (WPM) row. Persisted per keyboard. */
  hideStatsRow?: boolean
  /** Baseline metrics for the Measurement-row comparison delta, or null when
   *  comparison is off / no matching history. */
  comparison?: ComparisonStats | null
  onCompositionStart?: () => void
  onCompositionUpdate?: (data: string) => void
  onCompositionEnd?: (data: string) => void
  /** Current word's romaji-keystroke progress (romajiInput mode only), or
   *  null otherwise. Drives both the current word's kana coloring
   *  (forwarded to `WordDisplay`) and the typed/remaining romaji guide line
   *  shown below the reading window. */
  romajiGuide?: RomajiGuide | null
  /** Current word's kana-mode stroke progress (kana mode only — see
   *  kana-input.ts), or null otherwise. Mutually exclusive with
   *  `romajiGuide` by construction (isKanaInputActive/isRomajiInputActive
   *  can never both be true) — drives the same current-word kana coloring
   *  (forwarded to `WordDisplay`) plus the kana stroke guide row shown
   *  below the reading window. */
  kanaGuide?: KanaGuide | null
  /** Called when Space is input via IME (keydown swallowed by the IME layer). */
  onImeSpaceKey?: () => void
  /** Imported-text display: visible line count + font size (px). Ignored
   *  outside fileImport mode. */
  displayLines?: number
  fontSize?: number
  /** Name the just-finished result inline from the completion screen
   *  (imported fileImport text only). Keyed to the most recent saved result. */
  onNameResult?: (name: string) => void
  /** Quick-insert chips for the result-name modal (material label, timestamp,
   *  WPM / KPM / Accuracy of the just-finished result). */
  resultNameChips?: string[]
  /** Start a fresh run (Next Test / Restart — both restart the test). */
  onStart?: () => void
  /** Memory mode (imported fileImport text): pause the running run. */
  onPause?: () => void
  /** Memory mode: open the resume dialog for a paused / saved run. */
  onResume?: () => void
  /** A paused fileImport run is saved and can be resumed. */
  hasSavedMemory?: boolean
  /** Error-class raw counts (see `TypingTestResult.errorSubstitutions` et
   *  al.) from the just-finished result, or `null` when the result has
   *  none (romaji run, no finalized words, or a legacy pre-error-class
   *  result) — the completion screen's error-mix line is omitted
   *  entirely rather than showing a '-' placeholder, since (unlike WPM /
   *  KSPC) "the metric doesn't apply to this run" is common, not an
   *  in-progress state. */
  errorClasses?: { substitutions: number; omissions: number; insertions: number } | null
  /** Host-owned ref TypingTestView snapshots its own realized `lines` into —
   *  see `LineSnapshot`'s own doc comment. Optional so every existing
   *  mount (tests included) stays valid without threading it. */
  lineSnapshotRef?: RefObject<LineSnapshot | null>
  /** The just-finished run's in-memory raw keystroke log — null when
   *  recording consent was off, view-only, or nothing was saveable.
   *  Rendered as the shared `KeystrokeTimelinePanel` in place of the
   *  compact stats row ONLY while `status === 'finished'` AND `runId`
   *  matches the current run's own: a fresh run's finish effect can
   *  otherwise briefly still be carrying the PREVIOUS run's log for one
   *  render, which this guard exists to catch. */
  lastFinishedLog?: RunKeystrokeLog | null
  /** The just-finished result, reused as the panel's own `result` prop so
   *  the completion screen's unified stat block reads exactly like
   *  History's timeline modal for the same run (see
   *  `KeystrokeTimelinePanel`'s own doc comment on that prop). */
  finishedResult?: TypingTestResult | null
}

/** Group flat word indices into logical lines using the line-break set
 *  (imported fileImport text). Each entry is the global word indices of one
 *  line, in order. */
export function groupIntoLines(words: string[], lineBreaks: Set<number>): number[][] {
  const lines: number[][] = []
  let current: number[] = []
  for (let i = 0; i < words.length; i++) {
    current.push(i)
    if (lineBreaks.has(i)) {
      lines.push(current)
      current = []
    }
  }
  if (current.length > 0) lines.push(current)
  return lines
}

/** Which row (real line, per `groupIntoLines`, or synthetic, per
 *  `useVisualLines`) a word index sits on — both shapes are the same
 *  `number[][]` of word indices, so one lookup serves both. Falls back to
 *  the last row for an out-of-range index (e.g. `currentWordIndex ===
 *  words.length` once a run finishes). */
export function rowIndexForWord(lines: number[][], wordIndex: number): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(wordIndex)) return i
  }
  return Math.max(0, lines.length - 1)
}
