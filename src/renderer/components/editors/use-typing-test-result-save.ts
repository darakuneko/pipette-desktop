// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { useTypingTest, TypingTestState } from '../../typing-test/useTypingTest'
import { buildTypingTestResult, isPbForConfig } from '../../typing-test/result-builder'
import { isRomajiInputActive } from '../../typing-test/romaji-input'
import type { TypingTestConfig } from '../../typing-test/types'
import type { LineSnapshot } from '../../typing-test/TypingTestView'
import type { TypingTestResult, TypingTestMemory } from '../../../shared/types/pipette-settings'
import type { TypingAnalyticsKeyboard } from '../../../shared/types/typing-analytics'
import type { RunKeystrokeLog } from '../../../shared/types/typing-run-log'
import type { UseRunLogRecorderReturn } from './use-run-log-recorder'

/** A run's config carries REAL line semantics (a newline in the source
 *  text advances via Enter, not Space) only for `fileImport` and
 *  `tatoeba` — the only two `createWordsForConfig*` branches
 *  (word-supply.ts) that ever populate `WordsForConfig.lineBreaks` with
 *  anything non-empty:
 *   - `fileImportTextToWords` (word-supply.ts) forwards
 *     `data.lineBreaks`, itself produced by `parseFileImportText`
 *     (typing-test-text-store.ts) — used for BOTH a user's own imported
 *     `.txt` file and an Aozora Bunko import (aozora-import.ts saves the
 *     cleaned text through the same typing-test-text-store, so it's
 *     just another `fileImport` `textId` by the time a run reads it —
 *     no separate discriminator needed).
 *   - `tatobaWordsForConfig` (word-supply.ts) spreads `tatoebaRun`
 *     (tatoeba-pack.ts), which ALSO calls `parseFileImportText` under
 *     the hood (one sampled sentence per line) — true for both the
 *     Lines and Time tatoeba patterns, and for `refillTimeModeWords`'s
 *     own tatoeba-time refill batches.
 *  `quote`/`words`/`time` always return `lineBreaks: []` from every
 *  `createWordsForConfig*` branch — never real, regardless of whether
 *  `state.lineBreaks` happens to be empty at the moment this reads it.
 *  This is why the source must be chosen by `config.mode`, not by
 *  `state.lineBreaks.size` — an emptiness check can't tell "single-line
 *  real text" (must still persist as explicit `[]`) apart from "no real
 *  line source at all" (must fall through to the snapshot, or omit). */
function hasRealLineStructure(mode: TypingTestConfig['mode']): boolean {
  return mode === 'fileImport' || mode === 'tatoeba'
}

/** Derive `RunKeystrokeLog.lineBreaks` for the just-finished run —
 *  Plan-line-keystroke-timeline PR1. Two sources, chosen by
 *  `config.mode` (see `hasRealLineStructure`), both clamped to
 *  `persistedWordCount` (the run can end with an in-flight word —
 *  `wordResults` itself never counts it — see the caller) with a
 *  STRICT bound: an index must be `< persistedWordCount - 1`, not just
 *  `< persistedWordCount`. A line break describes where a line ENDS
 *  before ANOTHER FOLLOWS — the run's own last persisted word can never
 *  be one, mirroring `parseFileImportText`'s own terminal-break removal
 *  (typing-test-text-store.ts) and `isValidLineBreaks`'s matching bound
 *  (typing-run-log-store.ts):
 *   1. `hasRealLineStructure(config.mode)` — REAL line breaks
 *      (tatoeba/fileImport text, `state.lineBreaks`). Always used for
 *      these modes, persisted EVEN WHEN EMPTY (a genuinely single-line
 *      run) — `[]` is not "no line source", it means "one line".
 *   2. Otherwise (`words`/`time`/`quote` — no real line source of their
 *      own): the monkeytype line-row snapshot TypingTestView wrote into
 *      `lineSnapshotRef`, only trusted when it's tagged for THIS exact
 *      run (`runId` and `wordCount` both match the live state), so a
 *      stale snapshot left over from a previous render (or run) can
 *      never be misattributed. Line-end index = each row's own last
 *      word index, EXCEPT the final row (its end is the run's own end,
 *      not a line break) — the strict clamp above then also drops any
 *      row whose last index still lands exactly on the persisted
 *      boundary (e.g. a time-bounded run interrupted mid-row, before
 *      `state.words` itself ran out).
 *  Returns `undefined` (omit — the saved log falls back to per-word
 *  rendering) when neither source applies. An empty REAL-source result
 *  is returned as `[]`, never collapsed to `undefined` — see
 *  `RunKeystrokeLog.lineBreaks`'s own doc comment. */
function deriveLineBreaksForLog(
  config: TypingTestConfig, state: TypingTestState, persistedWordCount: number, snapshot: LineSnapshot | null,
): number[] | undefined {
  if (hasRealLineStructure(config.mode)) {
    return [...state.lineBreaks].filter((i) => i < persistedWordCount - 1).sort((a, b) => a - b)
  }
  if (
    snapshot && snapshot.lines != null
    && snapshot.runId === state.runId && snapshot.wordCount === state.words.length
  ) {
    const ends: number[] = []
    // Every row but the last — the last row's own end is the run's end,
    // not a line break.
    for (let i = 0; i < snapshot.lines.length - 1; i++) {
      const row = snapshot.lines[i]
      if (row.length > 0) ends.push(row[row.length - 1])
    }
    return ends.filter((i) => i < persistedWordCount - 1)
  }
  return undefined
}

export interface UseTypingTestResultSaveOptions {
  typingTest: ReturnType<typeof useTypingTest>
  typingTestViewOnly?: boolean
  onSaveTypingTestResult?: (result: TypingTestResult) => void
  saveUnnamed: boolean
  typingTestHistory?: TypingTestResult[]
  onRenameTypingTestResult?: (date: string, name: string) => void
  /** Host-owned — a completed test makes any saved pause snapshot
   *  obsolete. */
  savedMemoryRef: RefObject<TypingTestMemory | undefined>
  onMemoryChangeRef: RefObject<((memory: TypingTestMemory | undefined) => void) | undefined>
  /** From use-typing-analytics-sink — read as a ref (not a dep) since the
   *  active keyboard is deliberately excluded from the finish effect's
   *  own dependency array. */
  keyboardRef: RefObject<TypingAnalyticsKeyboard | undefined>
  flushAfterPendingEmits: (drained: Promise<void>, uid: string) => void
  runLog: UseRunLogRecorderReturn
  /** TypingTestView's own realized-lines snapshot (monkeytype modes only
   *  — see `deriveLineBreaksForLog`). Optional so a caller that never
   *  renders TypingTestView (or an older test) doesn't have to thread
   *  one. */
  lineSnapshotRef?: RefObject<LineSnapshot | null>
}

export interface UseTypingTestResultSaveReturn {
  /** The just-finished result — the held unsaved one when save-unnamed is off,
   *  else the saved latest; null until a test finishes. For result-name chips. */
  finishedResult: TypingTestResult | null
  /** Name the just-finished result: persists a held unsaved result under the
   *  name (save-unnamed off; blank → discarded) or renames the saved latest. */
  nameFinishedResult: (name: string) => void
  /** The in-memory log `runLog.finishAndSave` just built for the run that
   *  finished (null when recording consent was off / view-only / nothing
   *  saveable) — surfaced so the completion screen can render the shared
   *  `KeystrokeTimelinePanel` inline, without an IPC round-trip for the
   *  log it already holds (Plan-completion-timeline-view PR-B). Cleared
   *  in the same `status !== 'finished'` branch that resets
   *  `savedResultRef`, so a Next Test / Restart never leaves a stale run's
   *  log rendering on the fresh one — callers should also check
   *  `lastFinishedLog.runId` against the current run before rendering it
   *  (see the codex-review note in Plan-completion-timeline-view.md), as
   *  a belt-and-braces guard against the effect's own timing. */
  lastFinishedLog: RunKeystrokeLog | null
}

/** Owns the auto-save-on-finish lifecycle for an editor typing test run:
 *  building and persisting the TypingTestResult row, flushing the run's
 *  analytics, finalizing the per-run raw keystroke log (see
 *  run-log-recorder.ts), and the save-unnamed naming flow. Called after
 *  useTypingTest (needs `typingTest.state`) and after
 *  use-typing-analytics-sink (consumes its keyboardRef/
 *  flushAfterPendingEmits/runLog). */
export function useTypingTestResultSave({
  typingTest,
  typingTestViewOnly,
  onSaveTypingTestResult,
  saveUnnamed,
  typingTestHistory,
  onRenameTypingTestResult,
  savedMemoryRef,
  onMemoryChangeRef,
  keyboardRef,
  flushAfterPendingEmits,
  runLog,
  lineSnapshotRef,
}: UseTypingTestResultSaveOptions): UseTypingTestResultSaveReturn {
  const { resetMatrixPressTracking } = typingTest

  // Auto-save typing test result when test finishes. With save-unnamed on
  // (default) the result is persisted immediately; with it off the built
  // result is held in `pendingUnnamedResult` and only saved once the user
  // names it (commitPendingResult), so an unnamed run is discarded.
  const savedResultRef = useRef(false)
  const [pendingUnnamedResult, setPendingUnnamedResult] = useState<TypingTestResult | null>(null)
  const [lastFinishedLog, setLastFinishedLog] = useState<RunKeystrokeLog | null>(null)
  useEffect(() => {
    if (typingTestViewOnly) return
    if (typingTest.state.status === 'finished' && !savedResultRef.current && onSaveTypingTestResult) {
      savedResultRef.current = true
      const elapsed = typingTest.state.startTime && typingTest.state.endTime
        ? typingTest.state.endTime - typingTest.state.startTime
        : 0
      const result = buildTypingTestResult({
        correctChars: typingTest.state.correctChars,
        incorrectChars: typingTest.state.incorrectChars,
        wordCount: typingTest.state.currentWordIndex,
        wpm: typingTest.wpm,
        accuracy: typingTest.accuracy,
        elapsedMs: elapsed,
        config: typingTest.config,
        language: typingTest.language,
        wpmHistory: typingTest.state.wpmHistory,
        fileImportTextName: typingTest.config.mode === 'fileImport' ? typingTest.state.currentQuote?.source : undefined,
        runId: typingTest.state.runId,
        romajiActive: isRomajiInputActive(typingTest.config, typingTest.language, typingTest.state.romajiCapable),
        mistakes: typingTest.state.mistakes,
        totalKeystrokes: typingTest.state.totalKeystrokes,
        confirmedChars: typingTest.state.confirmedChars,
        kspcUncomputable: typingTest.state.kspcUncomputable,
        wordResults: typingTest.state.wordResults,
      })
      result.isPb = isPbForConfig(result, typingTestHistory ?? [])
      if (saveUnnamed) {
        onSaveTypingTestResult(result)
      } else {
        setPendingUnnamedResult(result)
      }
      // Flush the test's analytics so the just-finished minute/session
      // lands in the cache promptly (Analyze can show it without waiting
      // for the minute-close / before-quit flush). Keystrokes are recorded
      // regardless of whether the result row is saved. See
      // flushAfterPendingEmits for why the drain and the chain tail must
      // both settle first.
      const uid = keyboardRef.current?.uid
      if (uid) flushAfterPendingEmits(resetMatrixPressTracking(), uid)
      // The word the run ended on without submitting (e.g. a timed run
      // expiring mid-word) — undefined when the run ended cleanly on a
      // word boundary (currentWordIndex === words.length, every
      // words/quote-mode finish) or with nothing typed into it yet.
      // `currentInput` covers verbatim mode; `romajiKeystrokes` covers
      // romaji mode (currentInput stays '' there — see handleRomajiChar
      // in romaji-input.ts). See run-log-recorder.ts's `finish()`.
      const typedSoFar = typingTest.state.currentInput || typingTest.state.romajiKeystrokes
      const inFlightWord = typingTest.state.currentWordIndex < typingTest.state.words.length && typedSoFar.length > 0
        ? { display: typingTest.state.words[typingTest.state.currentWordIndex], typed: typedSoFar }
        : undefined
      // Line structure for the saved log (Plan-line-keystroke-timeline
      // PR1) — see `deriveLineBreaksForLog`'s own doc comment for the two
      // sources and the persisted-word clamp (`wordResults` plus the
      // in-flight word above, exactly what `runLog.finishAndSave` is
      // about to persist as `words`).
      const persistedWordCount = typingTest.state.wordResults.length + (inFlightWord ? 1 : 0)
      const lineBreaksForLog = deriveLineBreaksForLog(
        typingTest.config, typingTest.state, persistedWordCount, lineSnapshotRef?.current ?? null,
      )
      // Finalize the per-run raw keystroke log — discards outright when
      // there's no active keyboard uid to save under; otherwise builds and
      // saves it (itself a no-op unless this run was actually
      // recorder-gated — see `record`'s own gate). Never
      // truncated-and-saved: finish() refuses instead.
      const finishedLog = runLog.finishAndSave(uid, typingTest.state.wordResults, {
        runId: typingTest.state.runId,
        startedAtMs: typingTest.state.startTime ?? Date.now(),
        durationMs: elapsed,
        mode: typingTest.config.mode,
        language: typingTest.language,
        charCorrelationUnavailable: typingTest.state.kspcUncomputable,
        // Reuse the same isRomajiInputActive determination already made
        // for `result.romajiInput` above, rather than recomputing it —
        // see RunLogFinishMeta.romajiInput's own doc comment.
        romajiInput: result.romajiInput === true,
        inFlightWord,
        lineBreaks: lineBreaksForLog,
      })
      setLastFinishedLog(finishedLog)
      // A completed test makes any saved pause snapshot obsolete.
      if (savedMemoryRef.current) onMemoryChangeRef.current?.(undefined)
    }
    if (typingTest.state.status !== 'finished') {
      savedResultRef.current = false
      // Leaving the finished state (next test / restart) drops an unsaved,
      // still-unnamed result.
      if (pendingUnnamedResult) setPendingUnnamedResult(null)
      // ...and the just-finished run's raw log, so the completion screen's
      // timeline panel never renders a stale run's data once a fresh one
      // starts (see `lastFinishedLog`'s own doc comment).
      if (lastFinishedLog) setLastFinishedLog(null)
    }
  }, [typingTest.state.status, typingTest.state.startTime, typingTest.state.endTime,
    typingTest.state.correctChars, typingTest.state.incorrectChars,
    typingTest.state.currentWordIndex, typingTest.state.wpmHistory,
    typingTest.state.currentQuote, typingTest.state.runId, typingTest.state.romajiCapable,
    typingTest.state.totalKeystrokes, typingTest.state.confirmedChars, typingTest.state.kspcUncomputable,
    typingTest.state.currentInput, typingTest.state.romajiKeystrokes, typingTest.state.words,
    typingTest.wpm, typingTest.accuracy,
    typingTest.config, typingTest.language,
    typingTestHistory, onSaveTypingTestResult, saveUnnamed, pendingUnnamedResult, lastFinishedLog,
    resetMatrixPressTracking, flushAfterPendingEmits, runLog.finishAndSave])

  // The just-finished result, exposed so the pane can build name chips: the
  // held unsaved one (save-unnamed off) until named, else the saved latest.
  const finishedResult = typingTest.state.status === 'finished'
    ? (pendingUnnamedResult ?? typingTestHistory?.[0] ?? null)
    : null

  // Name the just-finished result. A held unsaved result (save-unnamed off) is
  // persisted under the name — blank keeps it discarded; otherwise the already
  // saved latest result is renamed (save-unnamed on; blank clears its name).
  const nameFinishedResult = useCallback((name: string) => {
    if (pendingUnnamedResult) {
      const trimmed = name.trim()
      if (!trimmed) return
      onSaveTypingTestResult?.({ ...pendingUnnamedResult, name: trimmed })
      setPendingUnnamedResult(null)
      return
    }
    const date = typingTestHistory?.[0]?.date
    if (date) onRenameTypingTestResult?.(date, name)
  }, [pendingUnnamedResult, onSaveTypingTestResult, onRenameTypingTestResult, typingTestHistory])

  return { finishedResult, nameFinishedResult, lastFinishedLog }
}
