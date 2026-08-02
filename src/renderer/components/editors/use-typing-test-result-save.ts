// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { useTypingTest } from '../../typing-test/useTypingTest'
import { buildTypingTestResult, isPbForConfig } from '../../typing-test/result-builder'
import { isRomajiInputActive } from '../../typing-test/romaji-input'
import type { TypingTestResult, TypingTestMemory } from '../../../shared/types/pipette-settings'
import type { TypingAnalyticsKeyboard } from '../../../shared/types/typing-analytics'
import type { UseRunLogRecorderReturn } from './use-run-log-recorder'

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
}

export interface UseTypingTestResultSaveReturn {
  /** The just-finished result — the held unsaved one when save-unnamed is off,
   *  else the saved latest; null until a test finishes. For result-name chips. */
  finishedResult: TypingTestResult | null
  /** Name the just-finished result: persists a held unsaved result under the
   *  name (save-unnamed off; blank → discarded) or renames the saved latest. */
  nameFinishedResult: (name: string) => void
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
}: UseTypingTestResultSaveOptions): UseTypingTestResultSaveReturn {
  const { resetMatrixPressTracking } = typingTest

  // Auto-save typing test result when test finishes. With save-unnamed on
  // (default) the result is persisted immediately; with it off the built
  // result is held in `pendingUnnamedResult` and only saved once the user
  // names it (commitPendingResult), so an unnamed run is discarded.
  const savedResultRef = useRef(false)
  const [pendingUnnamedResult, setPendingUnnamedResult] = useState<TypingTestResult | null>(null)
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
      // Finalize the per-run raw keystroke log — discards outright when
      // there's no active keyboard uid to save under; otherwise builds and
      // saves it (itself a no-op unless this run was actually
      // recorder-gated — see `record`'s own gate). Never
      // truncated-and-saved: finish() refuses instead.
      runLog.finishAndSave(uid, typingTest.state.wordResults, {
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
      })
      // A completed test makes any saved pause snapshot obsolete.
      if (savedMemoryRef.current) onMemoryChangeRef.current?.(undefined)
    }
    if (typingTest.state.status !== 'finished') {
      savedResultRef.current = false
      // Leaving the finished state (next test / restart) drops an unsaved,
      // still-unnamed result.
      if (pendingUnnamedResult) setPendingUnnamedResult(null)
    }
  }, [typingTest.state.status, typingTest.state.startTime, typingTest.state.endTime,
    typingTest.state.correctChars, typingTest.state.incorrectChars,
    typingTest.state.currentWordIndex, typingTest.state.wpmHistory,
    typingTest.state.currentQuote, typingTest.state.runId, typingTest.state.romajiCapable,
    typingTest.state.totalKeystrokes, typingTest.state.confirmedChars, typingTest.state.kspcUncomputable,
    typingTest.state.currentInput, typingTest.state.romajiKeystrokes, typingTest.state.words,
    typingTest.wpm, typingTest.accuracy,
    typingTest.config, typingTest.language,
    typingTestHistory, onSaveTypingTestResult, saveUnnamed, pendingUnnamedResult,
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

  return { finishedResult, nameFinishedResult }
}
