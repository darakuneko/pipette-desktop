// SPDX-License-Identifier: GPL-2.0-or-later

/** Owns the per-session RunLogRecorder instance (see run-log-recorder.ts)
 *  and the refs it needs to gate on, so `useInputModes` doesn't have to.
 *  Exposes exactly the five call shapes it needs:
 *   - `record` at the per-minute analytics emit seam.
 *   - `noteRegistration` — a direct drop-in for useTypingTest's
 *     `onNoteKeystrokeRegistration` option (same signature, no wrapping
 *     needed at the call site).
 *   - `noteCharContext` — the same drop-in shape for
 *     `onNoteCharContext`, resolving its thunk itself before forwarding
 *     to the recorder's own (non-thunk) `noteCharContext` — see its own
 *     doc comment for why this keeps the "derivation is free while
 *     gated off" property matching `noteRegistration`'s.
 *   - `finishAndSave` for the finished-run effect: discards outright when
 *     there's no active keyboard uid to save under, otherwise finalizes
 *     and saves.
 *   - `discardRun` for the pause handler (see useInputModes's
 *     `pauseTypingTest`) — a paused run's raw timeline would otherwise
 *     be corrupted by the pause gap once resumed (see
 *     run-log-recorder.ts's `discardRun()`), so the summary result still
 *     pauses/resumes normally but the raw log does not, even once typing
 *     resumes under the same runId.
 *  Also owns the two discard-on-teardown effects (consent revoked
 *  mid-run, active keyboard changed). */

import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { RunLogRecorder, type RunLogRecordContext, type RunLogFinishMeta } from '../../typing-test/run-log-recorder'
import type { TypingAnalyticsEventPayload } from '../../../shared/types/typing-analytics'
import type { WordResult } from '../../typing-test/run-state'

export interface UseRunLogRecorderOptions {
  /** `AppConfig.typingRecordingConsentAccepted`. */
  recordingConsentAccepted?: boolean
  /** Active keyboard's uid, if any — the buffer is discarded (never
   *  saved) whenever this changes. */
  keyboardUid?: string
  /** `useInputModes`'s own testLabelRef, forwarded BY REFERENCE (not by
   *  value): `noteRegistration` is called directly as useTypingTest's
   *  option, with no notion of tagging, so it must read the label live at
   *  invocation time rather than whatever it was when this hook last
   *  rendered — passing the stable ref object sidesteps that entirely. */
  typingTestLabelRef: RefObject<string | null>
}

export interface UseRunLogRecorderReturn {
  record: (tag: Pick<RunLogRecordContext, 'typingTestLabel' | 'runId' | 'windowFocused'>, payload: TypingAnalyticsEventPayload) => void
  noteRegistration: (
    runId: string, row: number, col: number, ts: number, wordIndex: number,
    getExpectedChar: () => string | undefined, windowFocused: boolean,
  ) => void
  noteCharContext: (
    runId: string, wordIndex: number, getExpectedChar: () => string | undefined, windowFocused: boolean,
  ) => void
  finishAndSave: (uid: string | undefined, wordResults: readonly WordResult[], meta: Omit<RunLogFinishMeta, 'uid'>) => void
  /** Discard `runId`'s buffer and block it from being re-buffered later
   *  under the same id — see the module doc comment's `discardRun`
   *  bullet and run-log-recorder.ts's `discardRun()`. */
  discardRun: (runId: string) => void
}

export function useRunLogRecorder({
  recordingConsentAccepted = false,
  keyboardUid,
  typingTestLabelRef,
}: UseRunLogRecorderOptions): UseRunLogRecorderReturn {
  const recorderRef = useRef(new RunLogRecorder())
  const consentRef = useRef(recordingConsentAccepted)
  consentRef.current = recordingConsentAccepted

  // Discard the run-log buffer on consent revocation, a keyboard switch,
  // or unmount — never finalize/save a buffer whose gating condition no
  // longer holds.
  useEffect(() => {
    if (!recordingConsentAccepted) recorderRef.current.discard()
  }, [recordingConsentAccepted])
  useEffect(() => {
    const recorder = recorderRef.current
    return () => recorder.discard()
  }, [keyboardUid])

  const record = useCallback((tag: Pick<RunLogRecordContext, 'typingTestLabel' | 'runId' | 'windowFocused'>, payload: TypingAnalyticsEventPayload) => {
    recorderRef.current.record({ ...tag, consentAccepted: consentRef.current }, payload)
  }, [])

  const noteRegistration = useCallback((
    runId: string, row: number, col: number, ts: number, wordIndex: number,
    getExpectedChar: () => string | undefined, windowFocused: boolean,
  ) => {
    const typingTestLabel = typingTestLabelRef.current
    recorderRef.current.noteRegistration(
      { typingTestLabel, runId: typingTestLabel ? runId : null, consentAccepted: consentRef.current, windowFocused },
      row, col, ts, wordIndex, getExpectedChar,
    )
  }, [typingTestLabelRef])

  const noteCharContext = useCallback((
    runId: string, wordIndex: number, getExpectedChar: () => string | undefined, windowFocused: boolean,
  ) => {
    const typingTestLabel = typingTestLabelRef.current
    // Skip the (possibly expensive, for romaji) derivation whenever no
    // test label is active, same as noteRegistration's `runId` gate
    // below — the recorder's own `noteCharContext` takes an
    // already-resolved value rather than a thunk (see its doc comment),
    // so this wrapper is what has to defer calling `getExpectedChar`.
    recorderRef.current.noteCharContext(
      { typingTestLabel, runId: typingTestLabel ? runId : null, consentAccepted: consentRef.current, windowFocused },
      wordIndex, typingTestLabel ? getExpectedChar() : undefined,
    )
  }, [typingTestLabelRef])

  const finishAndSave = useCallback((
    uid: string | undefined, wordResults: readonly WordResult[], meta: Omit<RunLogFinishMeta, 'uid'>,
  ) => {
    if (!uid) {
      recorderRef.current.discard()
      return
    }
    const log = recorderRef.current.finish(wordResults, { ...meta, uid })
    if (log) void window.vialAPI.typingRunLogSave(uid, log)
  }, [])

  const discardRun = useCallback((runId: string) => {
    recorderRef.current.discardRun(runId)
  }, [])

  return { record, noteRegistration, noteCharContext, finishAndSave, discardRun }
}
