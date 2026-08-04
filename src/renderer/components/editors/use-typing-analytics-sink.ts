// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useRef } from 'react'
import type { RefObject } from 'react'
import { materialLabel } from '../../typing-test/result-builder'
import type { TypingTestConfig } from '../../typing-test/types'
import { useRunLogRecorder, type UseRunLogRecorderReturn } from './use-run-log-recorder'
import type { TypingAnalyticsEventPayload, TypingAnalyticsKeyboard } from '../../../shared/types/typing-analytics'

/** Analytics `typing_test` dimension label for the running test: the
 *  imported text's name for fileImport, else `mode (language)` (e.g.
 *  `words (english)`) so Analyze can slice normal runs by language too.
 *  Delegates to `materialLabel` so the recording side and the Analyze run
 *  filter produce the identical join key. */
export function typingTestAnalyticsLabel(
  config: TypingTestConfig,
  language: string,
  currentQuote: { source: string } | null,
): string {
  // Tatoeba's material label keys off the sentence-pack language (in the
  // config), not the MonkeyType word language, so the recording side and the
  // Analyze run filter still produce an identical join key.
  const effectiveLanguage = config.mode === 'tatoeba' ? config.language : language
  return materialLabel(config.mode, effectiveLanguage, currentQuote?.source)
}

/** Context captured by prepareAnalyticsEvent at press time and carried
 *  opaquely through useTypingTest's ordering queue to emitAnalyticsEvent.
 *  `typingTest`/`runId` are null for ordinary REC input (untagged); an
 *  editor typing-test keystroke always has both set together.
 *
 *  GATE SPLIT (codex safety review of the missing-first-keystroke fix):
 *  `typingTest` is the narrow, PER-MINUTE-ANALYTICS tag — non-null only
 *  while `status === 'running'`, restored to its exact original (#203)
 *  meaning. `runLogTest` is a SEPARATE, broader tag used ONLY by the
 *  run-log recorder — non-null while running OR already "armed waiting"
 *  for the run's first keystroke (see useInputModes.ts's
 *  `runLogLabelRef`/`isArmedWaiting`). The two are deliberately allowed
 *  to disagree (`runLogTest` non-null while `typingTest` is still null)
 *  for exactly one narrow window per run — the armed-waiting keystrokes
 *  before `status` flips to `running` — so the run-log can capture that
 *  run's own first keystroke without also reopening the per-minute
 *  pipeline's pre-start cutoff (a run-log-only event must never reach
 *  `window.vialAPI.typingAnalyticsEvent` — see `perMinuteAuthorized` and
 *  `emitAnalyticsEvent`'s own gate). */
export interface PreparedAnalyticsContext {
  keyboard: TypingAnalyticsKeyboard
  typingTest: string | null
  /** Run-log-only tag — see the module doc comment above. Always non-null
   *  whenever `typingTest` is (running implies armed), but can be
   *  non-null on its own during armed-waiting. */
  runLogTest: string | null
  /** Shared run id for both `typingTest` and `runLogTest` — the exact
   *  same run either way, so one field suffices; non-null whenever
   *  EITHER tag is non-null. */
  runId: string | null
  /** Whether this event may reach the per-minute analytics pipeline at
   *  all (REC toggle active OR `typingTest` non-null) — independent of
   *  `runLogTest`. `emitAnalyticsEvent` must skip
   *  `window.vialAPI.typingAnalyticsEvent` entirely when this is false,
   *  even though `runLog.record` still runs — see its own gate for why. */
  perMinuteAuthorized: boolean
  /** Window-focus state snapshotted at press time (see useTypingTest's
   *  `onPrepareAnalyticsEvent` doc comment) — carried through to
   *  `emitAnalyticsEvent` so the run-log recorder's defense-in-depth gate
   *  (see run-log-recorder.ts's PRIVACY note) checks the value as of
   *  when this keystroke actually happened, not whatever focus is by the
   *  time a queued masked-key event finally ships. */
  windowFocused: boolean
}

export interface UseTypingAnalyticsSinkOptions {
  typingRecordKeyboard?: TypingAnalyticsKeyboard
  /** Called once per matrix keystroke recorded while REC (Typing View
   *  record toggle) is active — i.e. the same untagged events dispatched
   *  to typingAnalyticsEvent, not the tagged editor-typing-test events.
   *  Feeds the tray's session keystroke count (see useRecKeystrokeCounter
   *  in App.tsx); this hook does no counting of its own. */
  onRecKeystroke?: () => void
  /** `AppConfig.typingRecordingConsentAccepted` — gates the per-run raw
   *  keystroke log (see run-log-recorder.ts), independently of and
   *  stricter than `typingRecordEnabled`'s per-minute analytics gate. */
  recordingConsentAccepted?: boolean
}

export interface UseTypingAnalyticsSinkReturn {
  /** The active keyboard, kept current here (not by the host) since
   *  `typingRecordKeyboard` is an ordinary prop available before
   *  useTypingTest is called. Exposed so use-typing-test-result-save can
   *  read `.current?.uid` — deliberately as a ref, not a dep, in its
   *  finish effect. */
  keyboardRef: RefObject<TypingAnalyticsKeyboard | undefined>
  /** Gates ambient REC input. Created here so `prepareAnalyticsEvent`
   *  closes over a stable ref, but the host assigns `.current` from
   *  `recordingActive` (view-only + record toggle) render-phase, since
   *  useInputModes computes that condition itself. */
  recordingActiveRef: RefObject<boolean>
  /** Non-null while an editor typing-test run is the active tagged input
   *  source. The host assigns `.current` render-phase from
   *  `typingTest.state`, which only exists after the useTypingTest call —
   *  this hook (and its refs) must be created before that call so
   *  useTypingTest can capture the stable callbacks below on first
   *  render. NEVER convert this assignment to a useEffect: it must be
   *  visible to the same render's queue processing. */
  testLabelRef: RefObject<string | null>
  /** Travels with `testLabelRef` (run id) so each run's keystrokes are
   *  separable — same host-assigns-render-phase contract. Also doubles
   *  as `runLogLabelRef`'s own run id (see that ref's doc comment): both
   *  reference the exact same run, so one id ref suffices. */
  testRunIdRef: RefObject<string | null>
  /** GATE SPLIT: run-log-only tag, broader than `testLabelRef` — see
   *  `PreparedAnalyticsContext`'s own doc comment for why these two must
   *  stay separate. Same host-assigns-render-phase contract as
   *  `testLabelRef`; passed to `useRunLogRecorder` as its
   *  `typingTestLabelRef` INSTEAD of `testLabelRef`. */
  runLogLabelRef: RefObject<string | null>
  prepareAnalyticsEvent: (kind: 'matrix' | 'char', windowFocused: boolean) => PreparedAnalyticsContext | null
  emitAnalyticsEvent: (context: PreparedAnalyticsContext, payload: TypingAnalyticsEventPayload) => Promise<void>
  flushAfterPendingEmits: (drained: Promise<void>, uid: string) => void
  runLog: UseRunLogRecorderReturn
}

/** Owns the analytics event sink fed by useTypingTest's ordering queue:
 *  the prepare/emit split (see prepareAnalyticsEvent's doc comment), the
 *  per-emit IPC ordering chain, the flush-after-drain helper, and the
 *  per-run raw keystroke log recorder (RunLogRecorder, one instance per
 *  mount — see useRunLogRecorder). Called before useTypingTest so its
 *  refs exist for the host to keep current and its callbacks can be
 *  captured once by useTypingTest as stable references. */
export function useTypingAnalyticsSink({
  typingRecordKeyboard,
  onRecKeystroke,
  recordingConsentAccepted = false,
}: UseTypingAnalyticsSinkOptions): UseTypingAnalyticsSinkReturn {
  const keyboardRef = useRef(typingRecordKeyboard)
  keyboardRef.current = typingRecordKeyboard
  // Analytics event sink — two independent sources feed the same pipeline:
  //   1. Typing View REC ambient typing — gated by recordingActiveRef
  //      (record toggle ON + compact window open), emitted untagged.
  //   2. A typing test running in the editor — gated by testLabelRef
  //      (non-null while a test is the active input source), emitted with
  //      a `typingTest` dimension tag so Analyze can slice by which test.
  // recordingActiveRef/testLabelRef/testRunIdRef are updated by the host
  // render-phase; keyboardRef/onRecKeystrokeRef are updated right here.
  // Either way this stays a stable callback (useTypingTest captures it
  // once).
  const recordingActiveRef = useRef(false)
  const testLabelRef = useRef<string | null>(null)
  const testRunIdRef = useRef<string | null>(null)
  // GATE SPLIT: the run-log's OWN, broader tag — see
  // `PreparedAnalyticsContext`'s doc comment. Kept as a fully separate ref
  // (not derived from testLabelRef here) because the host
  // (useInputModes.ts) computes it from a different condition
  // (running OR armed-waiting) than testLabelRef (running only).
  const runLogLabelRef = useRef<string | null>(null)
  const onRecKeystrokeRef = useRef(onRecKeystroke)
  onRecKeystrokeRef.current = onRecKeystroke
  // Per-run raw keystroke log recorder (see run-log-recorder.ts and
  // use-run-log-recorder.ts) — one instance per editor session, mirroring
  // matrixQueueRef's construction style in useTypingTest.ts. Fed
  // `runLogLabelRef`, NOT `testLabelRef` — see the GATE SPLIT note above.
  const runLog = useRunLogRecorder({
    recordingConsentAccepted,
    keyboardUid: typingRecordKeyboard?.uid,
    typingTestLabelRef: runLogLabelRef,
  })
  // The sink used to read recordingActiveRef / testLabelRef / testRunIdRef
  // at the moment an event was actually sent, but a matrix event can now
  // sit in useTypingTest's ordering queue for up to the tapping term
  // (waiting on an unresolved tap-hold press ahead of it) before it gets
  // that far. Reading live state that late meant a press authorized and
  // tagged at press time could be silently dropped, or mistagged, by
  // whatever the state had become by the time it was flushed — most
  // visibly, stopping the record toggle mid-hold discarded every queued
  // event instead of just the one it was meant to finalize.
  //
  // Splitting into prepare (called once, at press time) + emit (called
  // once the event is actually ready to ship, immediately or off the
  // back of the queue) fixes that: prepare captures the gate + tag
  // decision when the keystroke happens and hands back an opaque
  // context; emit only ever ships what prepare already decided.
  const prepareAnalyticsEvent = useCallback((kind: 'matrix' | 'char', windowFocused: boolean): PreparedAnalyticsContext | null => {
    const keyboard = keyboardRef.current
    if (!keyboard) return null
    const label = testLabelRef.current
    const runLogLabel = runLogLabelRef.current
    // GATE SPLIT: `perMinuteAuthorized` is EXACTLY the original (#203)
    // authorization condition for the per-minute analytics pipeline —
    // REC toggle active, or a running editor test. `runLogLabel` (broader
    // — see PreparedAnalyticsContext's doc comment) can ALSO keep this
    // function from returning null on its own, during armed-waiting, but
    // must never by itself authorize a per-minute send — see
    // emitAnalyticsEvent's own `perMinuteAuthorized` gate below, which is
    // what actually enforces that split.
    const perMinuteAuthorized = recordingActiveRef.current || label !== null
    if (!perMinuteAuthorized && !runLogLabel) return null
    // Tray keystroke count tracks REC only (untagged matrix events), not
    // the editor typing-test practice mode — matches recordingActive's
    // narrower definition (typingRecordEnabled && typingTestViewOnly).
    // Counted here, at press time, rather than when the event eventually
    // leaves the queue: the count is a live tray readout of physical
    // keystrokes, and a masked key can otherwise sit unresolved for up to
    // the tapping term before its emit — the user would see the tray lag
    // behind their own typing. Explicitly re-checks recordingActiveRef
    // (not just `!label`) because reaching this line no longer implies
    // recordingActiveRef is true — a run-log-only armed-waiting press
    // (recordingActiveRef false, label null, runLogLabel non-null) must
    // never count toward the REC tray, only genuine untagged REC presses.
    if (!label && kind === 'matrix' && recordingActiveRef.current) {
      onRecKeystrokeRef.current?.()
    }
    // A test keystroke (either tag) carries the shared run id; REC input
    // carries none (so it lands as the null run).
    const runId = (label !== null || runLogLabel !== null) ? testRunIdRef.current : null
    return { keyboard, typingTest: label, runLogTest: runLogLabel, runId, perMinuteAuthorized, windowFocused }
  }, [])
  // Ordering contract, not an optimization: chaining every emit behind the
  // previous one's IPC guarantees at most one typingAnalyticsEvent invoke
  // is in flight at a time, so main's ingestEvent handlers can never
  // interleave around their own internal `await resolveScope()` — the
  // arrival order at main is always the call order here. Without this, a
  // second event whose resolveScope() call resolves from a warm cache
  // could reach the minute buffer before an earlier event still waiting
  // on a cold-cache resolveScope(), reordering keystrokes.
  //
  // Four independent layers share the ordering job end to end, each
  // covering what the one before it cannot:
  //   - MatrixAnalyticsQueue (renderer): press-order classification —
  //     decides tap vs. hold before anything reaches this sink.
  //   - this chain (renderer): the arrival-order contract into main — at
  //     most one IPC in flight, so decided order survives the IPC hop.
  //   - MinuteBuffer retention (main): self-healing aggregation — a late
  //     arrival re-dirties its entry instead of corrupting an already-flushed
  //     minute, so a rare reorder or straggler heals on the next drain
  //     rather than needing to never happen.
  //   - `iki <= 0` guard (main, recordNgramChain): last-resort discard for
  //     whatever tie/out-of-order pair still slips through all of the above.
  const chainRef = useRef<Promise<void>>(Promise.resolve())
  const emitAnalyticsEvent = useCallback((context: PreparedAnalyticsContext, payload: TypingAnalyticsEventPayload): Promise<void> => {
    // Run-keystroke-log capture — gates itself independently (see
    // RunLogRecordContext), fed `runLogTest` (the broader, run-log-only
    // tag), NOT `typingTest` — a no-op for ordinary REC input
    // (context.runLogTest null), without recording consent, or without
    // window focus (see context.windowFocused's doc comment).
    runLog.record({ typingTestLabel: context.runLogTest, runId: context.runId, windowFocused: context.windowFocused }, payload)
    // GATE SPLIT: a run-log-only event (armed-waiting, `perMinuteAuthorized`
    // false) must never reach the per-minute analytics pipeline — this is
    // what restores #203's original pre-start cutoff for that pipeline
    // (codex safety review P2) even though prepareAnalyticsEvent no longer
    // returns null for it. `chainRef` is deliberately left untouched here:
    // this event was never sent, so it has nothing to add to the IPC
    // ordering chain.
    if (!context.perMinuteAuthorized) return Promise.resolve()
    const event = context.typingTest
      ? { ...payload, keyboard: context.keyboard, typingTest: context.typingTest, runId: context.runId ?? undefined }
      : { ...payload, keyboard: context.keyboard }
    // The return value is only ever awaited by a forced drain
    // (MatrixAnalyticsQueue.drainAll, via resetMatrixPressTracking) — the
    // ordinary press/release/deadline paths call this and ignore it,
    // staying fire-and-forget same as before. Caught here (not left to
    // the caller) so a drain's Promise.all never rejects on an IPC error,
    // and so one failed IPC doesn't stall every later link in the chain.
    const next = chainRef.current
      .then(() => window.vialAPI.typingAnalyticsEvent(event))
      .catch(() => { /* fire-and-forget */ })
    chainRef.current = next
    return next
  }, [])
  /** Request a flush only after both `drained` and every event it just
   * emitted have settled. `chainRef.current` must be read INSIDE the
   * `.then()` — only after `drained` resolves — because draining is what
   * pushes those emits onto the chain in the first place; reading it
   * before `drained` resolves could capture the chain's state from
   * before the drain ran. Shared by both flush sites (record-off, test
   * finish): each has its own `drained` promise (from
   * resetMatrixPressTracking) but the same requirement — main's
   * ingestEvent does a real await (resolveScope) before an event reaches
   * its minute buffer, so requesting the flush any earlier could have it
   * serviced before a just-drained or still in-flight event lands,
   * landing that event in a fresh buffer entry after the session it
   * belonged to was already finalized.
   *
   * Reading `chainRef.current` here (rather than trusting emitAnalyticsEvent's
   * return value alone) is also what survives a future refactor: useTypingTest's
   * `onEmitAnalyticsEvent` is typed `=> void`, so nothing at the type level
   * checks that emit keeps returning the chain tail — if a later change quietly
   * dropped that return, this independent read of chainRef.current would still
   * see the same in-flight state. */
  const flushAfterPendingEmits = useCallback((drained: Promise<void>, uid: string): void => {
    void drained
      .then(() => chainRef.current)
      .then(() => window.vialAPI.typingAnalyticsFlush(uid))
      .catch(() => { /* fire-and-forget */ })
  }, [])

  return {
    keyboardRef,
    recordingActiveRef,
    testLabelRef,
    testRunIdRef,
    runLogLabelRef,
    prepareAnalyticsEvent,
    emitAnalyticsEvent,
    flushAfterPendingEmits,
    runLog,
  }
}
