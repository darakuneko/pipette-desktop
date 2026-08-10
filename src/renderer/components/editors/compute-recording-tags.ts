// SPDX-License-Identifier: GPL-2.0-or-later

import type { useTypingTest } from '../../typing-test/useTypingTest'
import { isKanaInputActive } from '../../typing-test/kana-input'
import { typingTestAnalyticsLabel } from './use-typing-analytics-sink'
import type { UseTypingAnalyticsSinkReturn } from './use-typing-analytics-sink'

export interface ComputeRecordingTagsOptions {
  typingTest: ReturnType<typeof useTypingTest>
  typingTestMode: boolean | undefined
  typingTestViewOnly: boolean | undefined
  /** The REC toggle's own effective condition (`typingRecordEnabled ?? false`),
   *  computed by useInputModes.ts (this function's only caller) before this
   *  call — see its own comment there for why REC's scope no longer needs
   *  the view-only qualifier. */
  recordingActive: boolean
  /** The runId useInputModes.ts's own `pristineRunIdRef` captured on this
   *  component instance's untouched initial mount
   *  (`useRef(typingTest.state.runId)`, never reassigned afterward). Every
   *  genuine "arm a session" entry point — restart, restartWithCountdown,
   *  setConfig, setLanguage (both its success and its error-fallback path),
   *  and setBaseLayer — mints a brand-new `crypto.randomUUID()` runId
   *  unconditionally whenever it produces a 'waiting' state (`freshState()`/
   *  `createInitialState()`, run-state.ts), so
   *  `typingTest.state.runId !== pristineRunId` reliably means "this
   *  waiting state actually came from an explicit start action" — never
   *  true for the untouched mount value, and also never true while an
   *  in-flight setConfig/setLanguage reconfigure hasn't resolved yet
   *  (`state.runId` only changes once that resolve itself calls
   *  `setState(freshState(...))`; until then `state` is still the coherent
   *  pre-reconfigure snapshot). NOT true for a resumed run either:
   *  `restoreState` (pause/resume) deliberately REUSES the paused run's own
   *  `memory.runId` rather than minting a fresh one — a resumed run is the
   *  same logical run continuing, not a new one starting — so resuming can
   *  never flip this check by itself. Full mint-once reasoning lives on
   *  `pristineRunIdRef` itself in useInputModes.ts. */
  pristineRunId: string
  /** The analytics-sink refs (use-typing-analytics-sink.ts) this function
   *  writes render-phase — see each ref's own doc comment there for the
   *  read side (`prepareAnalyticsEvent` / `emitAnalyticsEvent`). */
  refs: Pick<UseTypingAnalyticsSinkReturn,
    'recordingActiveRef' | 'testLabelRef' | 'testRunIdRef' | 'runLogLabelRef' | 'kanaInputRef'>
}

/**
 * Computes and writes, render-phase, the five analytics-sink tags that
 * decide which keystrokes get recorded and how they're labeled: REC's own
 * on/off flag, the editor typing-test's per-minute-analytics label, the
 * run-log recorder's own (broader) label, the shared run id, and kana-input
 * mode. Called from useInputModes.ts in the exact spot these assignments
 * used to sit inline — same render, same order, same refs — so
 * `prepareAnalyticsEvent` (use-typing-analytics-sink.ts) always sees this
 * render's values by the time any of useTypingTest's own effects run. See
 * the call site in useInputModes.ts for why this must stay render-phase
 * rather than move into a `useEffect`.
 */
export function computeRecordingTags({
  typingTest,
  typingTestMode,
  typingTestViewOnly,
  recordingActive,
  pristineRunId,
  refs,
}: ComputeRecordingTagsOptions): void {
  const { recordingActiveRef, testLabelRef, testRunIdRef, runLogLabelRef, kanaInputRef } = refs

  // Keep the sink's refs current (the sink itself is a stable callback).
  recordingActiveRef.current = recordingActive
  // A test in the editor (not the REC view) is the tagged input source — but
  // only while it is actually running. Entering the test view auto-starts a
  // countdown on the default ('words') config; tagging keystrokes before the
  // run starts would record a phantom material (e.g. `words (english)`) for
  // presses made during countdown / waiting or before the user picks a fileImport
  // text. Gating on 'running' guarantees the config has settled to the chosen
  // material before anything is recorded. Trade-off: the keystroke that starts
  // the run (waiting -> running) and the matrix edge of the key that ends it
  // (running -> finished, seen a poll later) may go untagged — a negligible
  // 1-2 edge gap in the aggregate heatmap, accepted to avoid the phantom run.
  // ('finished' is intentionally excluded so idle presses after a test can't
  // re-introduce a phantom record.)
  //
  // GATE SPLIT (codex safety review of an earlier, broader-gate attempt at
  // the missing-first-keystroke fix — see runLogLabelRef below for the
  // actual fix): this condition is deliberately restored to EXACTLY its
  // original (#203) shape. Broadening it to also cover armed-waiting (as
  // a first attempt did) tags the per-minute analytics pipeline too
  // eagerly in two ways that pipeline was never meant to tolerate:
  //  - P1: `setConfig`/`setLanguage` update `config` synchronously but
  //    the STATE stays whatever it was (old runId, possibly already
  //    non-pristine from an earlier session) until their async word-list
  //    load resolves and calls `setState(freshState(...))` — during that
  //    window a broadened gate would tag the STALE run with the NEW
  //    config's label, producing a phantom/orphan analytics run.
  //  - P2: the per-minute pipeline has no notion of "pre-start" content
  //    filtering — a broadened gate would tag every modifier/no-op press
  //    made while armed-waiting (before the user's first real character)
  //    into the heatmap unboundedly, not just the one keystroke that
  //    actually starts the run.
  // The run-log recorder needs the run's first keystroke for a different
  // reason (a raw per-run log, not an aggregate heatmap) and tolerates
  // pre-start junk fine (finish() drops anything preceding startedAtMs via
  // the negative-pressMs filter — see run-log-recorder.ts), so it gets its
  // OWN, separate, broader gate below instead of reusing this one.
  testLabelRef.current = typingTestMode && !typingTestViewOnly && typingTest.state.status === 'running'
    ? typingTestAnalyticsLabel(typingTest.config, typingTest.language, typingTest.state.currentQuote)
    : null

  // The run-log recorder's OWN tag — broader than testLabelRef above (see
  // the GATE SPLIT note): non-null while running, OR already 'waiting'
  // for the run's first keystroke under a session that was actually,
  // explicitly armed (see pristineRunId's own doc comment above). Two
  // states stay excluded, same reasoning as testLabelRef:
  //  - 'countdown' — the config hasn't settled yet.
  //  - a 'waiting' that is still the component's untouched, pristine
  //    initial mount value, OR one whose config just changed but whose
  //    async word-list load (setConfig/setLanguage) hasn't resolved yet
  //    (P1 above) — `runId !== pristineRunId` catches the mount case; the
  //    in-flight-reconfigure case is caught for free too, since
  //    `state.runId` doesn't change until that same async load itself
  //    calls `setState(freshState(...))` — until then, `state` (config,
  //    words, runId) is still the COHERENT pre-reconfigure snapshot
  //    (either the pristine mount, or an earlier session already
  //    correctly tagged/untagged on its own terms), never a mix of the
  //    new config with a stale runId.
  // A GENUINELY armed 'waiting' — reached via restartWithCountdown's own
  // timer once the countdown finishes, or directly via restart/setConfig/
  // setLanguage/setBaseLayer once their async word-list load resolves —
  // always carries a fresh runId (freshState()/createInitialState() mint
  // one unconditionally — see pristineRunId's own doc comment above for
  // why restoreState is excluded from this list), so by the time any of
  // those produce 'waiting', the config has genuinely settled and this
  // check already reads non-pristine.
  //
  // Unlike testLabelRef, admitting this broader 'waiting' here is safe:
  // the run-log recorder's own finish() already drops (never tags/saves)
  // any keystroke preceding the run's own startedAtMs via the negative-
  // pressMs filter, so pre-start junk let in by this wider gate (a
  // modifier key pressed while still armed-waiting, say) is filtered out
  // downstream rather than needing to never enter the buffer at all. This
  // is what fixes the run's own first keystroke: previously, gating on
  // 'running' alone (i.e. reusing testLabelRef) meant the exact keystroke
  // that flips 'waiting' -> 'running' was processed (both its matrix
  // registration in useTypingTestMatrix and its own char-side prepare()
  // in processKeyEvent) while that ref still read null from the render
  // before — a one-render-late ref can never catch up to the very state
  // transition it is itself gating, so that keystroke was silently
  // dropped every single run (user report: a run's first word always
  // renders one keystroke bar short in KeystrokeTimelinePanel).
  // 'finished' stays excluded too, so idle presses after a test can't
  // re-introduce a phantom record.
  const isArmedWaiting = typingTest.state.status === 'waiting' && typingTest.state.runId !== pristineRunId
  runLogLabelRef.current = typingTestMode && !typingTestViewOnly
    && (typingTest.state.status === 'running' || isArmedWaiting)
    ? typingTestAnalyticsLabel(typingTest.config, typingTest.language, typingTest.state.currentQuote)
    : null
  // Shared run id: non-null whenever EITHER tag above is (testLabelRef's
  // narrow condition is always a subset of runLogLabelRef's broader one,
  // so this single check covers both) — both tags, when set, always
  // refer to this exact same run. See PreparedAnalyticsContext's own doc
  // comment (use-typing-analytics-sink.ts) for how prepareAnalyticsEvent
  // reads this alongside each tag.
  testRunIdRef.current = (testLabelRef.current !== null || runLogLabelRef.current !== null) ? typingTest.state.runId : null

  // Kana mode's own tag, read by use-typing-analytics-sink's
  // prepareAnalyticsEvent — see RunLogRecordContext.kanaInput's own doc
  // comment (run-log-recorder.ts) for what this actually gates
  // (recognizing JIS-position keycodes as char-producing). Deliberately
  // NOT gated on typingTestMode/status the way testLabelRef/runLogLabelRef
  // are: kana-vs-romaji is a config CHOICE, independent of whether a run
  // is currently active, and `producesChar` is meaningless to gate on run
  // status anyway (it decides a static fact about a keycode).
  kanaInputRef.current = isKanaInputActive(typingTest.config, typingTest.language, typingTest.state.romajiCapable)
}
