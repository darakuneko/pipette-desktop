// SPDX-License-Identifier: GPL-2.0-or-later

/** Pause/capture/restore snapshot logic for useTypingTest's fileImport
 *  memory mode. Pure functions with no React dependency — the host hook
 *  keeps thin useCallback wrappers around these plus its own seqRef
 *  staleness guard (shared with restart/setConfig/setLanguage — see
 *  useTypingTest.ts's doc comments on why that guard lives in the host
 *  rather than here). */

import type { TypingTestConfig } from './types'
import type { TypingTestState } from './run-state'
import type { TypingTestMemory } from '../../shared/types/pipette-settings'
import type { WordsForConfig } from './word-supply'

/** Snapshot the in-progress test so it can be persisted and resumed.
 *  Returns null unless an imported fileImport text is active. */
export function buildMemorySnapshot(state: TypingTestState, config: TypingTestConfig): TypingTestMemory | null {
  if (config.mode !== 'fileImport') return null
  return {
    textId: config.textId,
    runId: state.runId,
    currentWordIndex: state.currentWordIndex,
    currentInput: state.currentInput,
    wordResults: state.wordResults.map((w) => ({ word: w.word, typed: w.typed, correct: w.correct })),
    correctChars: state.correctChars,
    incorrectChars: state.incorrectChars,
    // startTime already folds in any earlier paused/resumed segments.
    elapsedMs: state.startTime ? Date.now() - state.startTime : 0,
    wpmHistory: state.wpmHistory,
    // Persisted together — see TypingTestMemory's doc comment for why a
    // memory saved before KSPC existed has neither field.
    totalKeystrokes: state.totalKeystrokes,
    confirmedChars: state.confirmedChars,
    kspcUncomputable: state.kspcUncomputable,
    savedAt: new Date().toISOString(),
  }
}

/** Build the restored run state from a persisted snapshot plus the
 *  freshly (re)loaded text data for it. `resume=true` continues the timer
 *  (status 'running'); `resume=false` shows it frozen ('paused') — used
 *  on re-entry so the user must confirm before continuing. The caller
 *  (useTypingTest's restoreState) is responsible for the
 *  `text.words.length === 0` "can no longer be loaded" bail-out before
 *  calling this — this builder assumes a non-empty `text.words`. */
export function buildRestoredState(memory: TypingTestMemory, resume: boolean, text: WordsForConfig): TypingTestState {
  const { words, quote, lineBreaks, lineIndents, romajiCapable } = text
  const idx = Math.min(Math.max(0, memory.currentWordIndex), words.length - 1)
  const startTime = Date.now() - memory.elapsedMs
  // A memory saved before KSPC existed carries none of these three
  // fields — validateTypingTestMemory (useDevicePrefs.ts) already
  // enforces that they arrive either all-present or all-absent, so
  // defaulting each independently here can't produce an inconsistent
  // mix: absent means "uncomputable", so kspcUncomputable defaults to
  // true (not false) when unset.
  const totalKeystrokes = memory.totalKeystrokes ?? 0
  const confirmedChars = memory.confirmedChars ?? 0
  const kspcUncomputable = memory.kspcUncomputable ?? true
  return {
    status: resume ? 'running' : 'paused',
    // Keep the original run's id so a paused/resumed run stays one run in
    // analytics. Older memories without a runId fall back to a fresh id.
    runId: memory.runId ?? crypto.randomUUID(),
    words,
    currentWordIndex: idx,
    currentInput: memory.currentInput,
    compositionText: '',
    wordResults: memory.wordResults.map((w) => ({ word: w.word, typed: w.typed, correct: w.correct })),
    startTime,
    // Paused: pin endTime so elapsed/WPM display stays frozen at the saved time.
    endTime: resume ? null : Date.now(),
    correctChars: memory.correctChars,
    incorrectChars: memory.incorrectChars,
    totalKeystrokes,
    confirmedChars,
    kspcUncomputable,
    currentQuote: quote,
    wpmHistory: memory.wpmHistory,
    lineBreaks: new Set(lineBreaks),
    lineIndents,
    romajiKeystrokes: '',
    romajiCapable,
    // Pause/resume memory doesn't carry per-run mistake tracking (it was
    // never part of TypingTestMemory) — any mistakes tallied before the
    // pause are lost on resume, same as they would be on any other field
    // absent from the persisted snapshot. Acceptable: Phase 1 mistake
    // tracking is best-effort per run, not a durable record.
    mistakes: {},
    romajiSegmentErred: false,
    missedPositions: [],
  }
}
