// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useTypingTest } from '../../typing-test/useTypingTest'
import { isKanaInputActive } from '../../typing-test/kana-input'
import type { TypingTestConfig } from '../../typing-test/types'
import type { LineSnapshot } from '../../typing-test/TypingTestView'
import { DEFAULT_CONFIG, DEFAULT_LANGUAGE } from '../../typing-test/types'
import { createMistakeProfileCache } from '../../typing-test/weak-spot-profile'
import type { MistakeProfile, WeakSpotInputMethod } from '../../typing-test/weak-spot-profile'
import { useWeakSpotRunLogs } from './use-weak-spot-run-logs'
import { useMatrixTester } from './use-matrix-tester'
import { useTypingAnalyticsSink, typingTestAnalyticsLabel } from './use-typing-analytics-sink'
import { useTypingTestResultSave } from './use-typing-test-result-save'
import type { TypingTestResult, TypingTestMemory } from '../../../shared/types/pipette-settings'
import type { TypingAnalyticsKeyboard } from '../../../shared/types/typing-analytics'
import type { RunKeystrokeLog } from '../../../shared/types/typing-run-log'
import { PROCESS_CODE_TO_KEY } from './keymap-editor-types'

export interface UseInputModesOptions {
  rows?: number
  cols?: number
  getMatrixState?: () => Promise<number[]>
  unlocked?: boolean
  onUnlock?: (options?: { macroWarning?: boolean }) => void
  onMatrixModeChange?: (matrixMode: boolean, hasMatrixTester: boolean) => void
  keymap: Map<string, number>
  typingTestMode?: boolean
  onTypingTestModeChange?: (enabled: boolean) => void
  savedTypingTestConfig?: TypingTestConfig
  savedTypingTestLanguage?: string
  onTypingTestConfigChange?: (config: TypingTestConfig) => void
  onTypingTestLanguageChange?: (lang: string) => void
  onSaveTypingTestResult?: (result: TypingTestResult) => void
  /** Label the latest saved result by its ISO date — used to name a finished
   *  result when save-unnamed is on (the result is already in History). */
  onRenameTypingTestResult?: (date: string, name: string) => void
  /** When true (default), a finished result is auto-saved immediately, even
   *  without a name. When false, the result is held unsaved until the user
   *  names it (via `nameFinishedResult`); leaving it unnamed discards it. */
  saveUnnamed?: boolean
  /** Persisted paused-test snapshot for the active keyboard (memory mode). */
  savedTypingTestMemory?: TypingTestMemory
  /** Persist or clear the paused-test snapshot. */
  onTypingTestMemoryChange?: (memory: TypingTestMemory | undefined) => void
  typingTestHistory?: TypingTestResult[]
  typingTestViewOnly?: boolean
  typingRecordEnabled?: boolean
  typingRecordKeyboard?: TypingAnalyticsKeyboard
  /** Called once per matrix keystroke recorded while REC (Typing View
   *  record toggle) is active — i.e. the same untagged events dispatched
   *  to typingAnalyticsEvent, not the tagged editor-typing-test events.
   *  Feeds the tray's session keystroke count (see useRecKeystrokeCounter
   *  in App.tsx); this hook does no counting of its own. */
  onRecKeystroke?: () => void
  /** TAPPING_TERM (ms) forwarded to useTypingTest for masked-key
   * tap/hold classification. Defaults to QMK's 200 ms when the
   * keyboard hasn't reported one. */
  tappingTermMs?: number
  /** `AppConfig.typingRecordingConsentAccepted` — gates the per-run raw
   * keystroke log (see run-log-recorder.ts), independently of and
   * stricter than `typingRecordEnabled`'s per-minute analytics gate. */
  recordingConsentAccepted?: boolean
  /** Owned by the caller (KeymapEditor) — the lowest common ancestor of
   *  this hook and the TypingTestView it drives. Forwarded to
   *  useTypingTestResultSave; see LineSnapshot's own doc comment. */
  lineSnapshotRef?: RefObject<LineSnapshot | null>
}

export interface UseInputModesReturn {
  matrixMode: boolean
  pressedKeys: Set<string>
  everPressedKeys: Set<string>
  hasMatrixTester: boolean
  handleMatrixToggle: () => void
  handleTypingTestToggle: () => void
  typingTest: ReturnType<typeof useTypingTest>
  handleTypingTestConfigChange: (config: TypingTestConfig) => void
  handleTypingTestLanguageChange: (lang: string) => Promise<void>
  /** The just-finished result — the held unsaved one when save-unnamed is off,
   *  else the saved latest; null until a test finishes. For result-name chips. */
  finishedResult: TypingTestResult | null
  /** Name the just-finished result: persists a held unsaved result under the
   *  name (save-unnamed off; blank → discarded) or renames the saved latest. */
  nameFinishedResult: (name: string) => void
  /** The just-finished run's in-memory raw keystroke log (null when
   *  recording consent was off, view-only, or nothing saveable) — see
   *  `useTypingTestResultSave`'s own doc comment on its own
   *  `lastFinishedLog`, which this is a direct passthrough of. */
  lastFinishedLog: RunKeystrokeLog | null
  /** Memory mode (imported fileImport text). */
  savedTypingTestMemory?: TypingTestMemory
  pauseTypingTest: () => void
  resumeTypingTest: () => void
  restartTypingTestFromStart: () => void
}

export function useInputModes({
  rows,
  cols,
  getMatrixState,
  unlocked,
  onUnlock,
  onMatrixModeChange,
  keymap,
  typingTestMode,
  onTypingTestModeChange,
  savedTypingTestConfig,
  savedTypingTestLanguage,
  onTypingTestConfigChange,
  onTypingTestLanguageChange,
  onSaveTypingTestResult,
  onRenameTypingTestResult,
  saveUnnamed = true,
  savedTypingTestMemory,
  onTypingTestMemoryChange,
  typingTestHistory,
  typingTestViewOnly,
  typingRecordEnabled,
  typingRecordKeyboard,
  onRecKeystroke,
  tappingTermMs,
  recordingConsentAccepted = false,
  lineSnapshotRef,
}: UseInputModesOptions): UseInputModesReturn {
  // --- Matrix tester ---
  const {
    matrixMode,
    pressedKeys,
    everPressedKeys,
    hasMatrixTester,
    handleMatrixToggle,
    enterMatrixMode,
    resetMatrixState,
  } = useMatrixTester({ rows, cols, getMatrixState, unlocked, onUnlock, onMatrixModeChange })

  // --- Analytics sink (must be called before useTypingTest so its refs
  // exist for useTypingTest to capture the stable callbacks below). ---
  const {
    keyboardRef,
    recordingActiveRef,
    testLabelRef,
    testRunIdRef,
    runLogLabelRef,
    kanaInputRef,
    prepareAnalyticsEvent,
    emitAnalyticsEvent,
    flushAfterPendingEmits,
    runLog,
  } = useTypingAnalyticsSink({ typingRecordKeyboard, onRecKeystroke, recordingConsentAccepted })

  // --- Typing test ---
  // Weak Spot Training's timing signals (slowness/stall) source their raw
  // per-token intervals from the same saved run logs the History Analysis
  // tab's mistake ranking already fetches (see useAggregatedMissedDetails)
  // — but fetched independently here, gated only on `typingRecordKeyboard`'s
  // uid, so the feature works whether or not History is ever opened. When
  // no uid is available (recording never configured this session) this
  // simply returns an empty map — weak-spot-profile.ts's aggregation
  // already treats that the same as "no log for this run," degrading to
  // mistakes-only weakness, exactly per the plan's own explicit rule.
  const weakSpotRunLogs = useWeakSpotRunLogs(typingRecordKeyboard?.uid, typingTestHistory ?? [])

  // Weak Spot Training's mistake-profile lookup: one memoized cache
  // instance per useInputModes mount (see weak-spot-profile.ts's
  // MistakeProfileCache — keyed by the typingTestHistory/weakSpotRunLogs
  // references + a language|inputMethod scope key), shared by both
  // useTypingTest's per-run sampling snapshot and its live weakSpotGate.
  // undefined (not the empty-array default) means "history hasn't loaded
  // yet" — distinguished from a loaded-but-empty history, which produces a
  // real zero-weak-token profile — so the Option section's hint never
  // claims "no weak spots" before there's real data to compute one from.
  // Lazy-initialized (not `useRef(createMistakeProfileCache())`, which
  // would allocate a fresh cache object + Map on every render just to
  // discard it — useInputModes re-renders on every keystroke via
  // useTypingTest's own state, so that argument expression is evaluated
  // far more often than the single time its result is actually used).
  const mistakeProfileCacheRef = useRef<ReturnType<typeof createMistakeProfileCache> | null>(null)
  mistakeProfileCacheRef.current ??= createMistakeProfileCache()
  const getMistakeProfile = useCallback((language: string, inputMethod: WeakSpotInputMethod): MistakeProfile | undefined => {
    if (typingTestHistory === undefined) return undefined
    return mistakeProfileCacheRef.current!.get(typingTestHistory, weakSpotRunLogs, language, inputMethod)
  }, [typingTestHistory, weakSpotRunLogs])

  const typingTest = useTypingTest(savedTypingTestConfig, savedTypingTestLanguage, {
    onPrepareAnalyticsEvent: prepareAnalyticsEvent,
    onEmitAnalyticsEvent: emitAnalyticsEvent,
    // A direct passthrough — runLog.noteRegistration re-checks the label/
    // consent gate itself (same privacy-critical gate `record` uses
    // above, fed runLogLabelRef — see the GATE SPLIT note below — NOT
    // testLabelRef), so ambient REC frames (runLogLabelRef null) never
    // touch the recorder buffer at all, not even to register. The call
    // site itself (useTypingTestMatrix's `prepared == null continue`) is
    // also gated on the union of both tags — see prepareAnalyticsEvent's
    // `perMinuteAuthorized` split for why that's still safe for the
    // per-minute pipeline.
    onNoteKeystrokeRegistration: runLog.noteRegistration,
    onNoteCharContext: runLog.noteCharContext,
    tappingTermMs,
    getMistakeProfile,
  })
  const {
    restart: restartTypingTest,
    restartWithCountdown,
    processMatrixFrame,
    resetMatrixPressTracking,
    processKeyEvent,
    setWindowFocused,
  } = typingTest

  // The runId useTypingTest minted for its own untouched initial mount —
  // `useRef`'s initializer runs once, so this never changes afterward,
  // regardless of how many real sessions this useInputModes instance goes
  // on to run. Every genuine "arm a session" entry point that can produce
  // a 'waiting' status — restart, restartWithCountdown, setConfig,
  // setLanguage (both its success and its error-fallback path), and
  // setBaseLayer — goes through `freshState()`/`createInitialState()`,
  // which mints a brand-new `crypto.randomUUID()` runId unconditionally
  // (run-state.ts), so `runId !== pristineRunIdRef.current` is a reliable
  // "this waiting state actually came from an explicit start action"
  // signal — see runLogLabelRef's own gating comment below for why this
  // distinction matters. `restoreState` (pause/resume) is NOT in this
  // list: `buildRestoredState` only ever produces 'running' or 'paused'
  // (typing-test-memory.ts), never 'waiting', so it can't affect this
  // check either way — and it deliberately REUSES the paused run's own
  // `memory.runId` rather than minting a fresh one, since a resumed run
  // is the same logical run continuing, not a new one starting.
  const pristineRunIdRef = useRef(typingTest.state.runId)

  const savedMemoryRef = useRef(savedTypingTestMemory)
  savedMemoryRef.current = savedTypingTestMemory
  const savedConfigRef = useRef(savedTypingTestConfig)
  savedConfigRef.current = savedTypingTestConfig
  const onMemoryChangeRef = useRef(onTypingTestMemoryChange)
  onMemoryChangeRef.current = onTypingTestMemoryChange
  // Tracks the config JSON last pushed into useTypingTest so the config-sync
  // effect below doesn't re-apply (and overwrite a restored snapshot).
  const lastSyncedConfigRef = useRef('')

  /** Enter the typing test. When a paused snapshot is saved for the active
   *  fileImport text, restore it frozen ('paused') so the user must choose
   *  resume / restart before typing; otherwise start a fresh test. */
  const beginTypingTest = useCallback((withCountdown: boolean) => {
    enterMatrixMode()
    const mem = savedMemoryRef.current
    const cfg = savedConfigRef.current
    if (mem && cfg?.mode === 'fileImport' && cfg.textId === mem.textId) {
      // Pre-mark the config as synced so the config-sync effect doesn't
      // clobber the restored snapshot with a fresh test.
      lastSyncedConfigRef.current = JSON.stringify(cfg)
      void typingTest.restoreState(mem, false)
    } else if (withCountdown) {
      restartWithCountdown()
    } else {
      restartTypingTest()
    }
    onTypingTestModeChange?.(true)
  }, [enterMatrixMode, typingTest, restartWithCountdown, restartTypingTest, onTypingTestModeChange])

  const [pendingTypingTest, setPendingTypingTest] = useState(false)

  useEffect(() => {
    if (pendingTypingTest && unlocked) {
      setPendingTypingTest(false)
      beginTypingTest(true)
    }
  }, [pendingTypingTest, unlocked, beginTypingTest])

  // Exit typing test when the keyboard is locked
  useEffect(() => {
    if (!unlocked && typingTestMode) {
      resetMatrixState()
      onTypingTestModeChange?.(false)
    }
  }, [unlocked, typingTestMode, resetMatrixState, onTypingTestModeChange])

  const handleTypingTestToggle = useCallback(() => {
    if (typingTestMode) {
      resetMatrixState()
      onTypingTestModeChange?.(false)
    } else if (unlocked) {
      beginTypingTest(false)
    } else {
      setPendingTypingTest(true)
      onUnlock?.()
    }
  }, [typingTestMode, unlocked, resetMatrixState, beginTypingTest, onTypingTestModeChange, onUnlock])

  // Feed matrix frames to typing test. This `typingTestMode` gate is what
  // keeps `recordingActive` below inert in Key Tester and the plain editor
  // even while REC is armed — see that comment for the other half of the
  // link. Changing this gate to also fire outside Typing View/Typing Test
  // would silently widen where REC actually records.
  useEffect(() => {
    if (!typingTestMode) return
    processMatrixFrame(pressedKeys, keymap)
  }, [pressedKeys, typingTestMode, processMatrixFrame, keymap])

  // Effective recording condition: the REC toggle alone (Task-typing-
  // record-footer — REC now lives in the keymap-editor footer, not the
  // Typing View popover, so it's no longer scoped to view-only). REC
  // being on authorizes ambient per-minute analytics wherever matrix
  // frames actually flow: Typing View AND the editor Typing Test screen.
  // Key Tester and the plain editor never reach this gate at all —
  // `processMatrixFrame` above is itself gated on `typingTestMode`, so
  // REC being armed there is inert until the user enters Typing View or
  // Typing Test.
  const recordingActive = typingRecordEnabled ?? false
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
  // explicitly armed (see pristineRunIdRef above). Two states stay
  // excluded, same reasoning as testLabelRef:
  //  - 'countdown' — the config hasn't settled yet.
  //  - a 'waiting' that is still the component's untouched, pristine
  //    initial mount value, OR one whose config just changed but whose
  //    async word-list load (setConfig/setLanguage) hasn't resolved yet
  //    (P1 above) — `runId !== pristineRunIdRef.current` catches the
  //    mount case; the in-flight-reconfigure case is caught for free too,
  //    since `state.runId` doesn't change until that same async load
  //    itself calls `setState(freshState(...))` — until then, `state`
  //    (config, words, runId) is still the COHERENT pre-reconfigure
  //    snapshot (either the pristine mount, or an earlier session already
  //    correctly tagged/untagged on its own terms), never a mix of the
  //    new config with a stale runId.
  // A GENUINELY armed 'waiting' — reached via restartWithCountdown's own
  // timer once the countdown finishes, or directly via restart/setConfig/
  // setLanguage/setBaseLayer once their async word-list load resolves —
  // always carries a fresh runId (freshState()/createInitialState() mint
  // one unconditionally — see pristineRunIdRef's own comment for why
  // restoreState is excluded from this list), so by the time any of those
  // produce 'waiting', the config has genuinely settled and this check
  // already reads non-pristine.
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
  const isArmedWaiting = typingTest.state.status === 'waiting' && typingTest.state.runId !== pristineRunIdRef.current
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

  // Reset matrix press-edge tracking when keymap changes or recording toggles
  // so the next frame doesn't emit stale press events against an old state.
  // The drain's completion promise is captured so the record-off effect
  // below can await the *same* drain instead of triggering (and racing) a
  // second one — see pendingDrainRef's use there.
  const pendingDrainRef = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    pendingDrainRef.current = resetMatrixPressTracking()
  }, [keymap, recordingActive, resetMatrixPressTracking])

  // When recording transitions off (the footer's Record toggle flips —
  // leaving a view no longer deactivates it), finalize the open session
  // in main and flush its data for the active keyboard. Must wait for the drain the effect
  // above just kicked off (same recordingActive dependency, so it always
  // runs first in this commit) — see flushAfterPendingEmits for why.
  const prevRecordingActiveRef = useRef(recordingActive)
  useEffect(() => {
    const wasOn = prevRecordingActiveRef.current
    prevRecordingActiveRef.current = recordingActive
    if (wasOn && !recordingActive) {
      const uid = typingRecordKeyboard?.uid
      if (uid) flushAfterPendingEmits(pendingDrainRef.current, uid)
    }
  }, [recordingActive, typingRecordKeyboard, flushAfterPendingEmits])

  // Capture-phase keydown listener for typing test
  useEffect(() => {
    if (!typingTestMode || typingTestViewOnly) return
    function handler(e: KeyboardEvent) {
      if (document.querySelector('[role="dialog"]')) return
      // Inline edit fields (e.g. naming a finished result) opt out of typing
      // capture so their keystrokes reach the input instead of the test.
      if (e.target instanceof HTMLElement && e.target.dataset.ttPassthrough != null) return
      if (e.isComposing) return
      let key = e.key
      if (key === 'Process') {
        const resolved = PROCESS_CODE_TO_KEY.get(e.code)
        if (!resolved) return
        key = resolved
      }
      if (e.metaKey) return
      if (e.ctrlKey && !e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      // code/shiftKey are used only by kana mode's stroke resolution
      // (kana-input.ts) — see processKeyEvent's own doc comment.
      processKeyEvent(key, e.ctrlKey, e.altKey, e.metaKey, e.code, e.shiftKey)
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [typingTestMode, typingTestViewOnly, processKeyEvent])

  const { finishedResult, nameFinishedResult, lastFinishedLog } = useTypingTestResultSave({
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
  })

  // Sync saved config/language from device prefs into useTypingTest
  useEffect(() => {
    const target = savedTypingTestConfig
    const json = target ? JSON.stringify(target) : ''
    if (json === lastSyncedConfigRef.current) return
    lastSyncedConfigRef.current = json
    typingTest.setConfig(target ?? DEFAULT_CONFIG)
  }, [savedTypingTestConfig, typingTest.setConfig])

  const lastSyncedLanguageRef = useRef('')
  useEffect(() => {
    const target = savedTypingTestLanguage
    if ((target ?? '') === lastSyncedLanguageRef.current) return
    lastSyncedLanguageRef.current = target ?? ''
    typingTest.setLanguage(target ?? DEFAULT_LANGUAGE)
  }, [savedTypingTestLanguage, typingTest.setLanguage])

  // Wrapped setters that persist user-initiated changes to device prefs
  const handleTypingTestConfigChange = useCallback((newConfig: TypingTestConfig) => {
    // Starting a different imported text discards the saved snapshot.
    const mem = savedMemoryRef.current
    if (mem && newConfig.mode === 'fileImport' && newConfig.textId !== mem.textId) {
      onMemoryChangeRef.current?.(undefined)
    }
    typingTest.setConfig(newConfig)
    lastSyncedConfigRef.current = JSON.stringify(newConfig)
    onTypingTestConfigChange?.(newConfig)
  }, [typingTest.setConfig, onTypingTestConfigChange])

  const handleTypingTestLanguageChange = useCallback(async (newLanguage: string) => {
    const resolved = await typingTest.setLanguage(newLanguage)
    lastSyncedLanguageRef.current = resolved
    onTypingTestLanguageChange?.(resolved)
  }, [typingTest.setLanguage, onTypingTestLanguageChange])

  // --- Memory mode handlers ---
  const pauseTypingTest = useCallback(() => {
    const mem = typingTest.captureMemory()
    if (!mem) return
    onMemoryChangeRef.current?.(mem)
    typingTest.pause()
    // Discard (never save) the run-log buffer for THIS run on pause, and
    // block it from being re-buffered once typing resumes under the same
    // runId (see run-log-recorder.ts's `discardRun()`): resume rebases
    // `startTime` to `Date.now() - elapsedMs`, so this run's raw timeline
    // is already broken by the pause gap — the summary result above still
    // saves/resumes normally, just not this run's raw log.
    runLog.discardRun(typingTest.state.runId)
  }, [typingTest, runLog.discardRun])

  const resumeTypingTest = useCallback(() => {
    const mem = savedMemoryRef.current
    if (!mem) return
    void typingTest.restoreState(mem, true).then((ok) => {
      if (!ok) {
        onMemoryChangeRef.current?.(undefined)
        restartTypingTest()
      }
    })
  }, [typingTest, restartTypingTest])

  const restartTypingTestFromStart = useCallback(() => {
    onMemoryChangeRef.current?.(undefined)
    restartTypingTest()
  }, [restartTypingTest])

  // Window focus/blur listeners
  useEffect(() => {
    if (!typingTestMode || typingTestViewOnly) return
    setWindowFocused(document.hasFocus() && document.visibilityState === 'visible')
    function onBlur() { setWindowFocused(false) }
    function onFocus() { setWindowFocused(true) }
    function onVisibility() { setWindowFocused(document.visibilityState === 'visible') }
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [typingTestMode, typingTestViewOnly, setWindowFocused])

  return {
    matrixMode,
    pressedKeys,
    everPressedKeys,
    hasMatrixTester,
    handleMatrixToggle,
    handleTypingTestToggle,
    typingTest,
    handleTypingTestConfigChange,
    handleTypingTestLanguageChange,
    finishedResult,
    nameFinishedResult,
    lastFinishedLog,
    savedTypingTestMemory,
    pauseTypingTest,
    resumeTypingTest,
    restartTypingTestFromStart,
  }
}
